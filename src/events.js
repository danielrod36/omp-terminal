import { createLogger } from "./log.js";

const log = createLogger("sse");

/**
 * Per-session message ring + SSE fan-out.
 *
 * Wire-compatible with @evenrealities/even-terminal (`dist/routes/events.js`):
 * `id:`/`data:` frames, a 500-entry ring, a 15 s `:heartbeat`, and a replay
 * cursor so a frame broadcast while the glasses were dark still paints.
 */
const MAX_MESSAGES_PER_SESSION = 500;
const HEARTBEAT_MS = 15_000;

const sessions = new Map();
/** Equivalence classes of session ids that must receive each other's frames. */
const idLinks = new Map();

function ensureSession(sessionId) {
	let session = sessions.get(sessionId);
	if (!session) {
		session = { messages: [], clients: new Set(), nextId: 1, lastDeliveredId: 0 };
		sessions.set(sessionId, session);
	}
	return session;
}

function idClass(id) {
	let set = idLinks.get(id);
	if (!set) {
		set = new Set([id]);
		idLinks.set(id, set);
	}
	return set;
}

/**
 * Make two ids share every future frame.
 *
 * An owned session learns omp's canonical id only after its child is running,
 * but the app may already be subscribed to the id it was told. Linking the two
 * means whichever identity the app holds, the answer still reaches its ring.
 */
export function linkSessions(left, right) {
	if (!left || !right || left === right) return;
	const classLeft = idClass(left);
	const classRight = idClass(right);
	if (classLeft === classRight) return;
	for (const id of classRight) {
		classLeft.add(id);
		idLinks.set(id, classLeft);
	}
	log.debug(`linked session ids ${[...classLeft].join(" = ")}`);
}

/** Append to the ring and fan out live. Returns the primary ring id. */
export function emit(sessionId, message) {
	if (!sessionId) return 0;
	const data = JSON.stringify(message);
	let primaryId = 0;
	for (const targetId of idClass(sessionId)) {
		const session = ensureSession(targetId);
		const id = session.nextId++;
		session.messages.push({ id, message });
		if (session.messages.length > MAX_MESSAGES_PER_SESSION) session.messages.shift();
		if (targetId === sessionId) primaryId = id;

		log.debug(`${targetId} emit id=${id} type=${message.type}${message.state ? `/${message.state}` : ""}`);
		if (session.clients.size === 0) {
			if (message.type === "text_delta" || message.type === "result") {
				log.warn(`${targetId} content frame '${message.type}' broadcast with no live client (id=${id})`);
			}
			continue;
		}
		let dead = 0;
		for (const client of session.clients) {
			try {
				client.write(`id: ${id}\ndata: ${data}\n\n`);
			} catch {
				session.clients.delete(client);
				dead++;
			}
		}
		if (session.clients.size > 0) session.lastDeliveredId = id;
		if (dead > 0) log.warn(`${targetId} dropped ${dead} dead client(s); ${session.clients.size} remain`);
	}
	return primaryId;
}

export function getMessages(sessionId, after) {
	const session = sessions.get(sessionId);
	if (!session) return [];
	return session.messages.filter(entry => entry.id > after).map(entry => ({ id: entry.id, ...entry.message }));
}

/**
 * Display history synthesized from the retained ring.
 *
 * omp writes a transcript only when the session settles, so a history read
 * immediately after a turn can race the file's creation. The ring already holds
 * what the wearer saw, so it answers in the meantime.
 */
export function historyFromRing(sessionId, limit = 10) {
	// `emit` writes each message into every ring in the equivalence class, so
	// concatenating the class would return every turn as many times as the class
	// has ids. Read the primary ring only; the aliases hold the same entries.
	const session = sessions.get(sessionId);
	if (!session) return [];
	const items = [];
	for (const entry of session.messages) {
		const message = entry.message;
		if (message.type === "user_prompt" && message.text) items.push({ role: "user", text: message.text });
		else if (message.type === "result" && message.text) items.push({ role: "assistant", text: message.text });
	}
	return items.slice(-limit);
}

export function totalClients() {
	let total = 0;
	for (const session of sessions.values()) total += session.clients.size;
	return total;
}

/**
 * Attach an SSE client. Replay cursor priority matches the stock contract:
 * `Last-Event-ID` header, then `needReplay=true`, then the dark-window gap.
 */
export function addClient(sessionId, res, needReplay, lastEventId) {
	res.setHeader("Content-Type", "text/event-stream");
	res.setHeader("Cache-Control", "no-cache");
	res.setHeader("Connection", "keep-alive");
	res.setHeader("X-Accel-Buffering", "no");
	res.flushHeaders?.();
	res.write(":ok\n\n");

	const session = ensureSession(sessionId);
	const parsedLast = Number(lastEventId);
	const replayFrom = Number.isFinite(parsedLast) && parsedLast > 0 ? parsedLast : needReplay ? 0 : session.lastDeliveredId;
	let replayed = 0;
	for (const entry of session.messages) {
		if (entry.id > replayFrom) {
			res.write(`id: ${entry.id}\ndata: ${JSON.stringify(entry.message)}\n\n`);
			replayed++;
		}
	}
	session.lastDeliveredId = session.nextId - 1;
	session.clients.add(res);
	log.info(
		`client connected ${sessionId} (replayFrom=${replayFrom} replayed=${replayed}/${session.messages.length} live=${session.clients.size} total=${totalClients()})`,
	);

	const heartbeat = setInterval(() => {
		try {
			res.write(":heartbeat\n\n");
		} catch {
			clearInterval(heartbeat);
			session.clients.delete(res);
		}
	}, HEARTBEAT_MS);

	return () => {
		clearInterval(heartbeat);
		session.clients.delete(res);
		log.info(`client disconnected ${sessionId} (total=${totalClients()})`);
	};
}

