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
/**
 * Drop a client whose socket has buffered this much without draining. Well above a
 * normal frame burst and below anything that threatens the process.
 */
const MAX_CLIENT_BUFFER_BYTES = 4 * 1024 * 1024;
/**
 * Most ids one equivalence class may hold. Every member costs a ring push and a frame write
 * per emit, so the class is capped rather than allowed to grow with a caller's invented ids.
 */
const MAX_IDS_PER_CLASS = 32;

/**
 * Marker for the teardown attached to each attached response, so any path that removes a
 * client can also stop its heartbeat. Registry-global so a test can observe it.
 */
const DISPOSE = Symbol.for("omp-terminal.dispose");

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
	// A class exists only to bridge the ids a client already holds to the session's
	// canonical one. An unbounded class is not merely memory: `emit` writes one frame per
	// member, so a caller rotating prefix ids made every frame cost O(ids) — measured 229x
	// for 1000 aliases.
	//
	// The cap EVICTS the stalest members rather than refusing the new id. Refusing would be a
	// lockout, not a limit: once hostile ids fill a class, every later — genuinely
	// subscribed — id would be muted for as long as the session lives, because nothing
	// shrinks the class. Both sides merge first, so the survivor set is the merged one and a
	// freshly-arriving id can never be dropped in favour of ids that arrived before it.
	// Merge the SMALLER class into the larger one, so the established class (usually the
	// canonical session's ring) keeps its insertion order and the arriving id is appended
	// last. Merging the other way would make the arrival the oldest member and the trim
	// below would evict the client that just subscribed.
	const [target, source] = classLeft.size >= classRight.size ? [classLeft, classRight] : [classRight, classLeft];
	for (const id of source) {
		if (target.has(id)) continue;
		target.add(id);
		idLinks.set(id, target);
	}
	// Trim to the cap, evicting the OLDEST members first — except never the two ids just
	// linked, and never an id with an attached client. Ordering by insertion is what makes
	// "oldest" meaningful, and excluding the linked pair is what keeps the arrival reachable
	// no matter which class the merge happened to grow.
	const protectedIds = new Set([left, right]);
	const members = [...target];
	const excess = Math.max(0, members.length - MAX_IDS_PER_CLASS);
	let evicted = 0;
	for (const id of members) {
		if (evicted >= excess) break;
		if (protectedIds.has(id)) continue;
		if (sessions.get(id)?.clients.size > 0) continue; // a live SSE client keeps its id
		target.delete(id);
		idLinks.delete(id);
		// Release the evicted id's ring as well. Leaving it would mean the cap bounds
		// fan-out but not memory: the ring holds up to MAX_MESSAGES_PER_SESSION frames, and
		// nothing else ever frees an id the class walk can no longer reach (measured 591 MB
		// retained from 800 evicted, fully-buffered ids).
		sessions.delete(id);
		evicted++;
		log.warn(`evicted stale session id ${id} from a class at the ${MAX_IDS_PER_CLASS}-id cap`);
	}
	log.debug(`linked session ids ${[...target].join(" = ")}`);
}

/**
 * Drop a session's ring once nothing can read it again.
 *
 * Every ring holds up to MAX_MESSAGES_PER_SESSION frames, and a fresh conversation
 * mints a fresh id, so without this a long-lived bridge accumulates one ring per
 * conversation ever started (measured: ~0.84 MB each) until it runs out of memory.
 * The ring is kept while clients are attached or while it is an alias of a live id,
 * so an app that reconnects to a just-finished session still gets its replay.
 */
export function dropSession(sessionId) {
	const links = idLinks.get(sessionId);
	// A linked class dies together: the ids are one session under two names, so its
	// rings are only reclaimable when none of them has a live client. Without this the
	// alias ring — which holds a full copy of every frame, since `emit` writes into each
	// ring in the class — outlives the canonical one and the class leaks anyway.
	const ids = links ? [...links] : [sessionId];
	for (const id of ids) {
		const session = sessions.get(id);
		if (session && session.clients.size > 0) return false;
	}
	let dropped = false;
	for (const id of ids) {
		if (sessions.delete(id)) dropped = true;
		if (links) idLinks.delete(id);
	}
	if (dropped) log.debug(`dropped ring(s) for ${ids.join(" = ")}`);
	return dropped;
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
			// A client that stops reading (asleep phone, wedged radio) never triggers
			// 'close', so without this its unsent frames accumulate in userspace without
			// bound — measured: 20k frames buffered 30 MB for one silent client. Dropping it
			// loses nothing: the ring keeps the frames and the reconnect replays them from
			// the cursor, which is the same path a dark-lens reconnect already takes.
			// `writableLength` is undefined on the fakes tests pass in, which reads as idle.
			if ((client.writableLength ?? 0) > MAX_CLIENT_BUFFER_BYTES) {
				log.warn(`${targetId} dropping a client ${client.writableLength} bytes behind; it can replay on reconnect`);
				try {
					client.end?.();
				} catch {
					/* already gone */
				}
				// Stop its heartbeat as well: a timer still writing after `end()` would
				// raise an unhandled 'error' event and crash the bridge.
				client[DISPOSE]?.();
				session.clients.delete(client);
				dead++;
				continue;
			}
			try {
				client.write(`id: ${id}\ndata: ${data}\n\n`);
			} catch {
				client[DISPOSE]?.();
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
	let replayStalled = false;
	for (const entry of session.messages) {
		if (entry.id > replayFrom) {
			// The replay burst is bounded by the ring, but a client that is already far
			// behind must not be handed 500 more frames to buffer: stop and let the live
			// path drop it on the next emit.
			if ((res.writableLength ?? 0) > MAX_CLIENT_BUFFER_BYTES) {
				replayStalled = true;
				break;
			}
			res.write(`id: ${entry.id}\ndata: ${JSON.stringify(entry.message)}\n\n`);
			replayed++;
		}
	}
	session.lastDeliveredId = session.nextId - 1;
	if (replayStalled) {
		log.warn(`client ${sessionId} stalled during replay; dropping it`);
		try {
			res.end?.();
		} catch {
			/* already gone */
		}
		return () => {
			session.clients.delete(res);
		};
	}
	// The teardown lives on the response because `emit` has no reference to this closure,
	// and every path that removes the client must run it — otherwise the heartbeat keeps
	// ticking after `end()` and the resulting ERR_STREAM_WRITE_AFTER_END is an unhandled
	// 'error' event that takes the whole bridge down.
	let heartbeat = null;
	let disposed = false;
	const dispose = () => {
		if (disposed) return;
		disposed = true;
		if (heartbeat) clearInterval(heartbeat);
		session.clients.delete(res);
		// Clear the marker so a caller can tell a torn-down client from a live one: a
		// heartbeat still ticking after `end()` is the crash this guards against.
		delete res[DISPOSE];
	};
	res[DISPOSE] = dispose;

	heartbeat = setInterval(() => {
		try {
			res.write(":heartbeat\n\n");
		} catch {
			dispose();
		}
	}, HEARTBEAT_MS);

	session.clients.add(res);
	log.info(
		`client connected ${sessionId} (replayFrom=${replayFrom} replayed=${replayed}/${session.messages.length} live=${session.clients.size} total=${totalClients()})`,
	);

	// A write that fails asynchronously (the socket died under us) must not become an
	// unhandled 'error' event either.
	res.on?.("error", () => dispose());

	return () => {
		dispose();
		log.info(`client disconnected ${sessionId} (total=${totalClients()})`);
	};
}

