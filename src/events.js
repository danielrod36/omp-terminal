import { createLogger } from "./log.js";

const log = createLogger("sse");

/**
 * Per-session message ring + SSE fan-out.
 *
 * Wire-compatible with @evenrealities/even-terminal (`dist/routes/events.js`):
 * `id:`/`data:` frames, a 500-entry ring, a 15 s `:heartbeat`, and a replay
 * cursor so a frame broadcast while the glasses were dark still paints.
 *
 * Several ids can name one session: the app subscribes under the id it was told,
 * and omp only reports its canonical id once the child is running. Those ids form
 * an equivalence CLASS, and the class owns ONE ring and ONE client set. That is
 * the whole reason a class exists — a per-id ring would copy every frame once per
 * id, so memory would grow with the number of ids a caller can invent, and
 * forgetting an id would throw its history away.
 */
const MAX_MESSAGES_PER_SESSION = 500;
const HEARTBEAT_MS = 15_000;
/**
 * Drop a client whose socket has buffered this much without draining. Well above a
 * normal frame burst and below anything that threatens the process.
 */
const MAX_CLIENT_BUFFER_BYTES = 4 * 1024 * 1024;
/**
 * Most ids one class may keep a lookup for. Ids cost a map entry and a Set slot, not a
 * ring, so this only bounds the lookup itself; frames are written once per client.
 */
const MAX_IDS_PER_CLASS = 256;

/**
 * Marker for the teardown attached to each attached response, so any path that removes a
 * client can also stop its heartbeat. Registry-global so a test can observe it.
 */
const DISPOSE = Symbol.for("omp-terminal.dispose");

/** id -> its class. Every id of a class points at the same object. */
const sessions = new Map();

/**
 * When each id was last looked up or emitted under. A class owns one ring, so forgetting an
 * id costs only its name; this list decides which names are worth keeping, newest first.
 */
const idUse = new Map();
/** How many attached SSE clients subscribed under each id. */
const idSubscribers = new Map();

function touchId(id) {
	idUse.delete(id);
	idUse.set(id, Date.now());
}

/** The class an id belongs to, creating one when it is new. */
function ensureClass(id) {
	touchId(id);
	let cls = sessions.get(id);
	if (!cls) {
		cls = { ids: new Set([id]), emitId: id, messages: [], clients: new Set(), nextId: 1, lastDeliveredId: 0 };
		sessions.set(id, cls);
	}
	return cls;
}

/**
 * Merge two ids' classes so they share one ring.
 *
 * An owned session learns omp's canonical id only after its child is running, but
 * the app may already be subscribed to the id it was told, so whichever identity
 * either side holds the frames must land in the same ring.
 */
export function linkSessions(left, right) {
	if (!left || !right || left === right) return;
	const leftClass = ensureClass(left);
	const rightClass = ensureClass(right);
	if (leftClass === rightClass) return;
	// Keep the larger (established) class as the survivor, so the ids that have been around
	// longest keep their ring. Merging the other way is harmless for the ring, which is
	// shared either way, but this keeps the survivor stable across repeated links.
	const [target, source] = leftClass.ids.size >= rightClass.ids.size ? [leftClass, rightClass] : [rightClass, leftClass];
	// Both sides can already hold frames (an emit before the link). Keep BOTH histories rather
	// than dropping one, renumbering the source onto the target's id space so the ids stay
	// monotonic and unique across the merge. The merged order is each side's own emission
	// order (target first), which is the best available: the entries carry no timestamp, and
	// no current server path emits into both classes before linking them.
	//
	// A cursor minted on the source ring therefore no longer names the same frame. It is
	// clamped forward rather than silently re-delivering: anything at or below the renumbered
	// end of the source range is treated as already seen.
	if (source.messages.length > 0) {
		const base = target.nextId;
		const merged = source.messages.map(entry => ({ id: entry.id + base - 1, message: entry.message }));
		target.messages = [...target.messages, ...merged]
			.sort((left, right) => left.id - right.id)
			.slice(-MAX_MESSAGES_PER_SESSION);
		target.nextId = base + source.nextId - 1;
		target.lastDeliveredId = Math.max(target.lastDeliveredId, target.nextId - 1);
	}
	for (const id of source.ids) {
		target.ids.add(id);
		sessions.set(id, target);
	}
	// The survivor keeps the canonical id it emits under; a merged-away emit id becomes an
	// alias like any other.
	// Move the clients too. Leaving them on `source` strands them: that object is no longer
	// reachable from any id, so `emit` never fans to it, the backpressure sweep cannot see
	// it, and `totalClients` undercounts — a client subscribed under a merged-away id would
	// keep its heartbeat but stop receiving anything for good.
	for (const client of source.clients) target.clients.add(client);
	source.clients.clear();
	// Bound the lookup by forgetting the stalest ids. This drops only the name: the ring is
	// the class's, so a forgotten id loses no history, and `linkSessions` or a prompt
	// re-establishes it. The ids linked just now are never the ones forgotten, so the caller
	// that is acting right now always stays reachable.
	const protectedIds = new Set([left, right]);
	const excess = Math.max(0, target.ids.size - MAX_IDS_PER_CLASS);
	if (excess > 0) {
		// Least-recently-used first: an id that is being polled or subscribed was touched
		// moments ago, so it outranks ids invented in a burst. `idUse` is insertion-ordered,
		// and `touchId` re-inserts on every use.
		const byUse = [...idUse.keys()];
		let forgotten = 0;
		for (const id of byUse) {
			if (forgotten >= excess) break;
			if (protectedIds.has(id)) continue;
			// Never forget the id the class emits under. Relying on the caller to pass it as
			// one of the two linked ids would let a future caller that links two aliases lose
			// the canonical id, and the next emit under it would mint a fresh class — stranding
			// the ring and its clients.
			if (id === target.emitId) continue;
			// An id a client is subscribed under keeps its name: its stream and its polls both
			// use it, and `getMessages` has no other way to find the class.
			if ((idSubscribers.get(id) ?? 0) > 0) continue;
			if (!target.ids.has(id)) continue;
			target.ids.delete(id);
			sessions.delete(id);
			idUse.delete(id);
			idSubscribers.delete(id);
			forgotten++;
			log.warn(`forgot idle session id ${id} from a class at the ${MAX_IDS_PER_CLASS}-id cap`);
		}
	}
	log.debug(`linked session ids ${[...target.ids].join(" = ")}`);
}

/**
 * Drop a class's ring once nothing can read it again.
 *
 * Every ring holds up to MAX_MESSAGES_PER_SESSION frames, and a fresh conversation
 * mints a fresh id, so without this a long-lived bridge accumulates one ring per
 * conversation ever started (measured: ~0.84 MB each) until it runs out of memory.
 * The ring is kept while any client of the class is attached, so an app that
 * reconnects to a just-finished session still gets its replay.
 */
export function dropSession(sessionId) {
	const cls = sessions.get(sessionId);
	if (!cls) return false;
	if (cls.clients.size > 0) return false;
	for (const id of cls.ids) {
		sessions.delete(id);
		idUse.delete(id);
		idSubscribers.delete(id);
	}
	log.debug(`dropped ring for ${[...cls.ids].join(" = ")}`);
	return true;
}

/** Append to the ring and fan out live. Returns the ring id of the new entry. */
export function emit(sessionId, message) {
	if (!sessionId) return 0;
	const cls = ensureClass(sessionId);
	const data = JSON.stringify(message);
	const id = cls.nextId++;
	cls.messages.push({ id, message });
	if (cls.messages.length > MAX_MESSAGES_PER_SESSION) cls.messages.shift();

	log.debug(`${sessionId} emit id=${id} type=${message.type}${message.state ? `/${message.state}` : ""}`);
	if (cls.clients.size === 0) {
		if (message.type === "text_delta" || message.type === "result") {
			log.warn(`${sessionId} content frame '${message.type}' broadcast with no live client (id=${id})`);
		}
		return id;
	}
	let dead = 0;
	for (const client of cls.clients) {
		// A client that stops reading (asleep phone, wedged radio) never triggers 'close', so
		// without this its unsent frames accumulate in userspace without bound — measured: 20k
		// frames buffered 30 MB for one silent client. Dropping it loses nothing: the ring
		// keeps the frames and the reconnect replays them from the cursor, which is the same
		// path a dark-lens reconnect already takes. `writableLength` is undefined on the fakes
		// tests pass in, which reads as idle.
		if ((client.writableLength ?? 0) > MAX_CLIENT_BUFFER_BYTES) {
			log.warn(`${sessionId} dropping a client ${client.writableLength} bytes behind; it can replay on reconnect`);
			try {
				client.end?.();
			} catch {
				/* already gone */
			}
			// Stop its heartbeat as well: a timer still writing after `end()` would raise an
			// unhandled 'error' event and crash the bridge.
			client[DISPOSE]?.();
			cls.clients.delete(client);
			dead++;
			continue;
		}
		try {
			client.write(`id: ${id}\ndata: ${data}\n\n`);
		} catch {
			client[DISPOSE]?.();
			cls.clients.delete(client);
			dead++;
		}
	}
	if (cls.clients.size > 0) cls.lastDeliveredId = id;
	if (dead > 0) log.warn(`${sessionId} dropped ${dead} dead client(s); ${cls.clients.size} remain`);
	return id;
}

export function getMessages(sessionId, after) {
	const cls = sessions.get(sessionId);
	if (!cls) return [];
	return cls.messages.filter(entry => entry.id > after).map(entry => ({ id: entry.id, ...entry.message }));
}

/**
 * Display history synthesized from the retained ring.
 *
 * omp writes a transcript only when the session settles, so a history read
 * immediately after a turn can race the file's creation. The ring already holds
 * what the wearer saw, so it answers in the meantime. One ring per class, so no id
 * can return the same turn twice.
 */
export function historyFromRing(sessionId, limit = 10) {
	const cls = sessions.get(sessionId);
	if (!cls) return [];
	const items = [];
	for (const entry of cls.messages) {
		const message = entry.message;
		if (message.type === "user_prompt" && message.text) items.push({ role: "user", text: message.text });
		else if (message.type === "result" && message.text) items.push({ role: "assistant", text: message.text });
	}
	return items.slice(-limit);
}

export function totalClients() {
	let total = 0;
	for (const cls of new Set(sessions.values())) total += cls.clients.size;
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

	const cls = ensureClass(sessionId);
	const parsedLast = Number(lastEventId);
	// A cursor past the ring's newest id came from a different (or superseded) ring: clamping
	// to the newest means "nothing new", instead of replaying the whole ring again.
	const cursor = Number.isFinite(parsedLast) && parsedLast > 0 ? Math.min(parsedLast, cls.nextId - 1) : null;
	const replayFrom = cursor ?? (needReplay ? 0 : cls.lastDeliveredId);
	let replayed = 0;
	let replayStalled = false;
	for (const entry of cls.messages) {
		if (entry.id > replayFrom) {
			// The replay burst is bounded by the ring, but a client that is already far behind
			// must not be handed 500 more frames to buffer: stop and let the live path drop it
			// on the next emit.
			if ((res.writableLength ?? 0) > MAX_CLIENT_BUFFER_BYTES) {
				replayStalled = true;
				break;
			}
			res.write(`id: ${entry.id}\ndata: ${JSON.stringify(entry.message)}\n\n`);
			replayed++;
		}
	}
	cls.lastDeliveredId = cls.nextId - 1;
	if (replayStalled) {
		log.warn(`client ${sessionId} stalled during replay; dropping it`);
		try {
			res.end?.();
		} catch {
			/* already gone */
		}
		return () => {
			cls.clients.delete(res);
		};
	}
	// The teardown lives on the response because `emit` has no reference to this closure, and
	// every path that removes the client must run it — otherwise the heartbeat keeps ticking
	// after `end()` and the resulting ERR_STREAM_WRITE_AFTER_END is an unhandled 'error' event
	// that takes the whole bridge down.
	let heartbeat = null;
	let disposed = false;
	const dispose = () => {
		if (disposed) return;
		disposed = true;
		clearInterval(heartbeat);
		cls.clients.delete(res);
		const remaining = (idSubscribers.get(sessionId) ?? 1) - 1;
		if (remaining > 0) idSubscribers.set(sessionId, remaining);
		else idSubscribers.delete(sessionId);
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

	cls.clients.add(res);
	idSubscribers.set(sessionId, (idSubscribers.get(sessionId) ?? 0) + 1);
	log.info(
		`client connected ${sessionId} (replayFrom=${replayFrom} replayed=${replayed}/${cls.messages.length} live=${cls.clients.size} total=${totalClients()})`,
	);

	// A write that fails asynchronously (the socket died under us) must not become an
	// unhandled 'error' event either.
	res.on?.("error", () => dispose());

	return () => {
		dispose();
		log.info(`client disconnected ${sessionId} (total=${totalClients()})`);
	};
}
