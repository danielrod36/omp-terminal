import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { URL } from "node:url";
import { createLogger, redactToken } from "./log.js";
import { addClient, dropSession, getMessages, historyFromRing, linkSessions, totalClients } from "./events.js";
import { OwnedSession, parseQuestionAnswer } from "./provider.js";
import { AttachSession, listTmuxOmpSessions } from "./attach.js";
import { findOmpSession, listOmpSessions, ompHistory } from "./sessions.js";

const log = createLogger("http");
const run = promisify(execFile);
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const pkgName = pkg.name;
const pkgVersion = pkg.version;

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };

function sendJson(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, { ...JSON_HEADERS, "Content-Length": Buffer.byteLength(payload) });
	res.end(payload);
}

async function readJson(req) {
	const chunks = [];
	let total = 0;
	for await (const chunk of req) {
		total += chunk.length;
		if (total > 10 * 1024 * 1024) {
			const error = new Error("request body too large");
			error.statusCode = 413;
			throw error;
		}
		chunks.push(chunk);
	}
	if (chunks.length === 0) return {};
	const text = Buffer.concat(chunks).toString("utf8").trim();
	if (!text) return {};
	try {
		return JSON.parse(text);
	} catch (error) {
		// A malformed body is the client's mistake: mapping it to 500 would both
		// misreport the fault and log a client error at error level.
		const wrapped = new Error(`invalid JSON body: ${error.message}`);
		wrapped.statusCode = 400;
		throw wrapped;
	}
}

/**
 * HTTP surface, wire-compatible with @evenrealities/even-terminal so the stock
 * Even App (Terminal Mode) talks to it unmodified. The one provider is `omp`.
 */
export function createBridge(config) {
	const token = config.token ?? randomBytes(16).toString("hex");
	const sessions = new Map(); // sessionId -> OwnedSession | AttachSession
	const sessionAliases = new Map(); // pre-adoption client id -> canonical id
	const pendingSpawns = new Map(); // sessionId -> Promise<OwnedSession>

	/** `omp --version`, resolved once and cached for /api/info. */
	let ompVersion;
	/** The in-flight probe, so concurrent callers share one child instead of one each. */
	let ompVersionProbe;
	function resolveOmpVersion() {
		if (ompVersion !== undefined) return Promise.resolve(ompVersion);
		// Cache the PROMISE, not the result: assigning only after the await let every
		// concurrent /api/info spawn its own `omp --version` (measured: 30 requests, 30
		// children), which any token holder could repeat to exhaust the process table.
		if (!ompVersionProbe) {
			ompVersionProbe = (async () => {
				try {
					const { stdout } = await run(config.ompCommand, ["--version"], { timeout: 5000 });
					ompVersion = stdout.trim().replace(/^omp\//, "") || null;
				} catch (error) {
					// A probe that failed because omp was momentarily unavailable must not
					// pin "unknown" for the process lifetime, so only a success is cached
					// past this call.
					log.warn(`could not resolve omp version: ${error.message}`);
					ompVersionProbe = undefined;
					return null;
				}
				return ompVersion;
			})();
		}
		return ompVersionProbe;
	}

	function authorized(req) {
		const header = req.headers.authorization;
		const bearer = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
		const url = new URL(req.url, "http://localhost");
		const query = url.searchParams.get("token");
		return (bearer ?? query) === token;
	}

	/** Any live session object (owned or attached) for a session id. */
	function getLive(sessionId) {
		if (!sessionId) return null;
		const direct = sessions.get(sessionId);
		if (direct) return direct;
		// A client may still hold the id it was told before the owned child
		// reported omp's canonical id; follow the alias to the same session.
		const canonical = sessionAliases.get(sessionId);
		return canonical ? sessions.get(canonical) ?? null : null;
	}

	/** A session whose child exited is dead weight: drop it so a re-prompt respawns. */
	function isDead(session) {
		if (session instanceof OwnedSession) return session.rpc?.closed === true;
		return session.paneGone === true;
	}

	function dropIfDead(session) {
		if (!session || !isDead(session)) return session;
		sessions.delete(session.id);
		if (session.tmuxSession) attachRegistry.delete(session.tmuxSession);
		for (const [alias, canonical] of sessionAliases) {
			if (canonical === session.id) sessionAliases.delete(alias);
		}
		// The SSE ring is keyed by session id and is not this map's to free, but a dead
		// session's ring is now unreachable: without this, one ring per conversation ever
		// started is retained for the life of the process.
		dropSession(session.id);
		return null;
	}

	/** Attach-mode sessions keyed by tmux session name, so one pane maps to one bridge session. */
	const attachRegistry = new Map(); // tmuxSession -> AttachSession

	/** Stable bridge id for a tmux-hosted pane (independent of transcript timing). */
	function attachId(tmuxSession) {
		return `tmux:${tmuxSession}`;
	}

	function ensureAttached(entry) {
		const existing = attachRegistry.get(entry.attach.tmuxSession);
		if (existing) {
			// The pane may have started a NEW transcript since the attachment was
			// created (a fresh TUI writes nothing until its first turn). Refreshing
			// here is what keeps the answer stream pointed at the file the desk is
			// actually appending to; a stale binding silently delivers nothing.
			if (entry.attach.transcriptPath) existing.adoptTranscript(entry.attach.transcriptPath);
			return existing;
		}
		const session = new AttachSession({
			id: attachId(entry.attach.tmuxSession),
			tmuxSession: entry.attach.tmuxSession,
			cwd: entry.cwd,
			provider: config.providerLabel,
			config,
			transcriptPath: entry.attach.transcriptPath,
		});
		attachRegistry.set(entry.attach.tmuxSession, session);
		sessions.set(session.id, session);
		// Polling follows the transcript and scrapes the pane for dialogs; it
		// must run for the lifetime of the attachment.
		session.start().catch(error => log.warn(`attach start failed: ${error.message}`));
		log.info(`attached to tmux session '${session.tmuxSession}' as ${session.id}`);
		return session;
	}

	/** Owned session for a session id, spawning omp on first use. */
	async function ensureOwned(sessionId, { cwd, resumePath } = {}) {
		dropIfDead(getLive(sessionId));
		const existing = getLive(sessionId);
		if (existing) return existing;
		if (pendingSpawns.has(sessionId)) return pendingSpawns.get(sessionId);
		const spawnPromise = (async () => {
			// A scan failure must not masquerade as "unknown id": starting fresh
			// would silently drop the resume and fork the wearer's thread with no
			// error anywhere. Surface it instead.
			let found = resumePath ?? null;
			if (!found) {
				try {
					found = findOmpSession(config, sessionId)?.path ?? null;
				} catch (error) {
					if (error.code === "SESSION_SCAN_FAILED") {
						// The scan message embeds an absolute bucket path; it belongs in the log,
						// not in a body a token holder can read.
						log.warn(`could not resolve session ${sessionId ?? "-"}: ${error.message}`);
						const wrapped = new Error("could not scan the session store");
						wrapped.statusCode = 503;
						throw wrapped;
					}
					throw error;
				}
			}
			// The scan may have resolved this id to a transcript another child already owns:
			// two client ids that prefix-match one transcript would otherwise each spawn a
			// child, and the second `sessions.set` below would orphan the first past
			// `bridge.close()`. Adopt the LIVE owner instead of spawning a duplicate.
			//
			// A dead owner must NOT be adopted: its child has exited, so every prompt would
			// fail with "omp process is closed" until something unrelated evicted it. Falling
			// through respawns, which is what the dead-session eviction exists to allow.
			if (found) {
				for (const existing of sessions.values()) {
					const known = existing.sessionFile ?? existing.transcriptPath;
					if (!known || known !== found) continue;
					// A dead owner is evicted rather than adopted. It would otherwise answer
					// every prompt with "omp process is closed" until something unrelated
					// evicted it — the session is keyed by the id the wearer prompted with, and
					// this caller reaches it only through the transcript, so `dropIfDead` above
					// (which resolves by id) cannot see it.
					if (isDead(existing)) {
						dropIfDead(existing);
						continue;
					}
					// The caller subscribed under ITS id, so record the alias and link the rings
					// here too — otherwise getLive never resolves it and its SSE client, which
					// holds the id it prompted with, never receives the adopted session's frames.
					if (sessionId && sessionId !== existing.id) {
						sessionAliases.set(sessionId, existing.id);
						linkSessions(sessionId, existing.id);
					}
					return existing;
				}
			}
			const args = [];
			// A known transcript resumes in place so the transcript stays the
			// single source of truth; unknown ids start a fresh session.
			if (found) args.push("--resume", found);
			const session = new OwnedSession({
				id: sessionId || randomBytes(8).toString("hex"),
				cwd: cwd ?? config.cwd,
				provider: config.providerLabel,
				config,
				ompArgs: args,
			});
			// A start that rejects must not leave the child behind: the session is not
			// in `sessions` yet, so neither a later prompt nor shutdown can reap it, and
			// a retry would orphan another. Kill it here, where the ownership still is.
			try {
				await session.start();
			} catch (error) {
				session.kill();
				throw error;
			}
			// omp mints the canonical session id (kept across a resume). Adopt it,
			// and link the id the client already subscribed to, so whichever
			// identity the app holds the answer still reaches its SSE ring.
			const clientId = sessionId;
			session.id = session.ompSessionId ?? session.id;
			if (clientId && clientId !== session.id) {
				sessionAliases.set(clientId, session.id);
				linkSessions(clientId, session.id);
			}
			// Every `sessions.set` is keyed by the session's OWN id, so an entry found here
			// can only be a different session that claimed the same canonical id. Losing that
			// race must not orphan a running child: keep the incumbent, drop the one we just
			// started, and leave the alias recorded above alone — it already points at the
			// canonical id the incumbent is stored under.
			const incumbent = sessions.get(session.id);
			if (incumbent && incumbent !== session) {
				// The incumbent may have exited during our `start()`: adopting it would kill the
				// healthy child we just started AND wedge every prompt on "omp process is
				// closed", so a dead one is evicted and ours is kept instead.
				if (isDead(incumbent)) {
					dropIfDead(incumbent);
				} else {
					session.kill();
					return incumbent;
				}
			}
			sessions.set(session.id, session);
			if (clientId && clientId !== session.id) sessions.delete(clientId);
			log.info(`owned session ${session.id} started (cwd=${session.cwd} resume=${found ?? "none"})`);
			return session;
		})();
		pendingSpawns.set(sessionId, spawnPromise);
		try {
			return await spawnPromise;
		} finally {
			pendingSpawns.delete(sessionId);
		}
	}

	/**
	 * Resolve a prompt target.
	 *
	 * Attach-first: a session id that names a live tmux-hosted omp TUI is
	 * steered in place (the desk agent owns the process). Anything else gets an
	 * owned `omp --mode rpc-ui` child, resuming the transcript when one exists.
	 */
	async function resolveTarget(sessionId, { cwd } = {}) {
		const live = dropIfDead(getLive(sessionId));
		if (live) return live;
		if (config.attach) {
			const attached = await findAttachEntry(sessionId);
			if (attached) return ensureAttached(attached);
		}
		if (typeof sessionId === "string" && sessionId.startsWith("tmux:")) {
			// An explicit attach id names a desk pane, not a transcript. If that
			// pane is gone, spawning an owned child would silently switch the
			// wearer to a different session than the one they picked.
			const error = new Error(`tmux session '${sessionId.slice(5)}' is not running`);
			error.statusCode = 404;
			throw error;
		}
		return ensureOwned(sessionId, { cwd });
	}

	async function findAttachEntry(sessionId) {
		if (!sessionId) return null;
		const entries = await listTmuxOmpSessions(config);
		return entries.find(entry => entry.id === sessionId) ?? null;
	}

	async function listSessions({ cwd, limit }) {
		for (const session of [...sessions.values()]) dropIfDead(session);
		const live = [...sessions.values()].map(session => ({
			id: session.id,
			title: session.title || "omp session",
			timestamp: new Date(session.lastActivity).toISOString(),
			cwd: session.cwd,
			provider: config.providerLabel,
			status: session.state,
			...(session.tmuxSession ? { attach: { tmuxSession: session.tmuxSession, transcriptPath: session.transcriptPath } } : {}),
		}));
		const attached = config.attach ? await listTmuxOmpSessions(config) : [];
		const diskAll = listOmpSessions(config, { limit });
		const disk = diskAll.map(session => ({
			id: session.id,
			title: session.title,
			timestamp: session.timestamp,
			cwd: session.cwd,
			provider: config.providerLabel,
			status: getLive(session.id)?.state ?? session.status,
		}));
		const seen = new Set();
		const merged = [];
		// Live bridge sessions take priority; a tmux pane merges with the on-disk
		// transcript it is appending to (one desk conversation must appear once),
		// and remaining on-disk transcripts fill in the rest.
		const rows = [...live, ...attached, ...disk.map((session, index) => ({ ...session, path: diskAll[index].path }))];
		for (const session of rows) {
			const keys = sessionKeys(session);
			if (keys.some(key => seen.has(key))) continue;
			for (const key of keys) seen.add(key);
			merged.push(session);
		}
		const filtered = cwd ? merged.filter(session => session.cwd === cwd) : merged;
		return filtered.slice(0, limit);
	}

	/** Identity keys for one session row: its id, tmux name, and transcript path. */
	function sessionKeys(session) {
		const keys = [`id:${session.id}`];
		if (session.attach) {
			keys.push(`tmux:${session.attach.tmuxSession}`);
			if (session.attach.transcriptPath) keys.push(`path:${session.attach.transcriptPath}`);
		}
		if (session.path) keys.push(`path:${session.path}`);
		return keys;
	}

	const server = createServer(async (req, res) => {
		const started = Date.now();
		res.on("finish", () => {
			// The socket can already be gone when the client aborts mid-body
			// (e.g. after an early 413), so it is not safe to assume it exists.
			log.info(`${req.socket?.remoteAddress ?? "-"} ${res.statusCode} ${req.method} ${redactToken(req.url)} ${Date.now() - started}ms`);
		});
		try {
			await route(req, res);
		} catch (error) {
			const status = typeof error.statusCode === "number" ? error.statusCode : 500;
			if (status >= 500) log.error(`unhandled route error: ${error.message}`);
			// A 5xx message can quote a filesystem path or a spawn failure; keep the detail
			// in the log and answer the client with the category only. Deliberate 4xx
			// messages are written for the caller and pass through unchanged.
			const detail = status >= 500 ? "internal error" : error.message;
			if (!res.headersSent) sendJson(res, status, { error: detail });
			else res.end();
		}
	});

	async function route(req, res) {
		const url = new URL(req.url, "http://localhost");
		const path = url.pathname;

		if (config.allowCors) {
			// Preflight AND real responses need the header: a browser discards a
			// response whose ACAO is missing even when the preflight passed.
			res.setHeader("Access-Control-Allow-Origin", "*");
			res.setHeader("Access-Control-Allow-Headers", "authorization, content-type, last-event-id");
			res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
			if (req.method === "OPTIONS") {
				res.writeHead(204);
				return res.end();
			}
		}

		if (path === "/healthz") {
			// Unauthenticated by design (the stock server mounts auth on /api
			// only), so it must not hand out host paths or counters. Those live
			// behind the token on /api/info.
			return sendJson(res, 200, {
				ok: true,
				provider: config.providerLabel,
				backend: config.backend,
			});
		}

		if (!path.startsWith("/api/")) {
			return sendJson(res, 404, { error: "not found" });
		}

		if (!authorized(req)) {
			log.warn(`401 ${req.method} ${redactToken(req.url)}`);
			return sendJson(res, 401, { error: { code: "auth_failed", message: "Unauthorized" } });
		}

		/* ---------------- SSE ---------------- */
		if (req.method === "GET" && path === "/api/events") {
			const sessionId = url.searchParams.get("sessionId");
			if (!sessionId) return sendJson(res, 400, { error: "Missing 'sessionId' query parameter" });
			const dispose = addClient(
				sessionId,
				res,
				url.searchParams.get("needReplay") === "true",
				req.headers["last-event-id"],
			);
			req.on("close", dispose);
			return;
		}

		/* -------------- sessions ------------- */
		if (req.method === "GET" && path === "/api/sessions") {
			const limit = Number(url.searchParams.get("limit")) || 50;
			const cwd = url.searchParams.get("cwd") ?? undefined;
			try {
				return sendJson(res, 200, { sessions: await listSessions({ cwd, limit }) });
			} catch (error) {
				return sendJson(res, 200, { sessions: [], error: error.message });
			}
		}

		if (req.method === "GET" && path === "/api/info") {
			const version = await resolveOmpVersion();
			return sendJson(res, 200, {
				account: {},
				model: version ? `omp ${version}` : "omp",
				version: version ?? "unknown",
				// Wire vocabulary the app understands (`claude`/`claude-sync`/`codex`);
				// the real backend is named in `extra.backend`.
				provider: config.providerLabel,
				extra: {
					expose: config.expose ?? "off",
					backend: config.backend,
					sessionsRoot: config.sessionsRoot,
					ownedSessions: sessions.size,
					sseClients: totalClients(),
					uptimeMs: Math.round(process.uptime() * 1000),
				},
			});
		}

		if (req.method === "GET" && path === "/api/update-check") {
			return sendJson(res, 200, {
				packageName: pkgName,
				currentVersion: pkgVersion,
				newestVersion: null,
				updateAvailable: null,
				checkedAt: new Date().toISOString(),
			});
		}

		const historyMatch = path.match(/^\/api\/sessions\/([^/]+)\/history$/);
		if (req.method === "GET" && historyMatch) {
			let id;
			try {
				id = decodeURIComponent(historyMatch[1]);
			} catch {
				return sendJson(res, 400, { error: "malformed session id in path" });
			}
			const limit = Math.min(Number(url.searchParams.get("limit")) || config.historyLimit, 20);
			try {
				// A bridge-owned session knows its exact transcript; a desk
				// session is found by scanning the store.
				const live = getLive(id);
				const target = live?.sessionFile ?? live?.transcriptPath ?? id;
				const fromDisk = ompHistory(config, target, limit);
				// omp flushes the transcript only when the session settles, so
				// right after a turn the file may not exist yet. Fall back to the
				// ring, which already holds what the wearer saw.
				const history = fromDisk.length > 0 ? fromDisk : historyFromRing(live?.id ?? id, limit);
				return sendJson(res, 200, { history });
			} catch (error) {
				// The message can carry an absolute path from the session scan; that is for
				// the log, not for a client that merely holds a token.
				log.warn(`history for ${id} failed: ${error.message}`);
				return sendJson(res, 200, { history: historyFromRing(id, limit), error: "could not read the session history" });
			}
		}

		/* -------------- prompting ------------- */
		if (req.method === "POST" && path === "/api/prompt") {
			const body = await readJson(req);
			const { text, sessionId, cwd } = body ?? {};
			if (!text || typeof text !== "string") {
				log.warn(`prompt rejected: missing text (sessionId=${sessionId ?? "-"})`);
				return sendJson(res, 400, { error: "Missing 'text' field" });
			}
			try {
				const session = await resolveTarget(sessionId ?? null, { cwd });
				await session.prompt(text);
				return sendJson(res, 202, { ok: true, sessionId: session.id, provider: config.providerLabel });
			} catch (error) {
				const code = typeof error.statusCode === "number" ? error.statusCode : 500;
				return sendJson(res, code, { error: error.message });
			}
		}

		/* -------------- dialogs ------------- */
		if (req.method === "POST" && path === "/api/permission-response") {
			const { sessionId, decision } = (await readJson(req)) ?? {};
			if (!sessionId) return sendJson(res, 400, { error: "Missing 'sessionId'" });
			const session = dropIfDead(getLive(sessionId));
			if (!session) return sendJson(res, 404, { error: "Session not found" });
			const accepted = await session.answerPermission(decision || "deny");
			if (!accepted) return sendJson(res, 400, { error: "No permission request is pending" });
			return sendJson(res, 200, { ok: true });
		}

		if (req.method === "POST" && path === "/api/question-response") {
			const body = (await readJson(req)) ?? {};
			const { sessionId, answer } = body;
			log.info(`question-response raw=${JSON.stringify(answer)?.slice(0, 200)} (sessionId=${sessionId ?? "-"})`);
			if (!sessionId) return sendJson(res, 400, { error: "Missing 'sessionId'" });
			const session = dropIfDead(getLive(sessionId));
			if (!session) return sendJson(res, 404, { error: "Session not found" });
			const accepted = await session.answerQuestion(answer ?? "skip");
			if (!accepted) return sendJson(res, 400, { error: "No question is pending" });
			return sendJson(res, 200, { ok: true });
		}

		if (req.method === "POST" && path === "/api/interrupt") {
			const { sessionId } = (await readJson(req)) ?? {};
			if (!sessionId) return sendJson(res, 400, { error: "Missing 'sessionId'" });
			const session = dropIfDead(getLive(sessionId));
			if (!session) return sendJson(res, 404, { error: "Session not found" });
			try {
				await session.interrupt();
				return sendJson(res, 200, { ok: true });
			} catch (error) {
				return sendJson(res, 500, { error: error.message });
			}
		}

		/* -------------- status -------------- */
		if (req.method === "GET" && path === "/api/status") {
			const sessionId = url.searchParams.get("sessionId");
			if (!sessionId) return sendJson(res, 400, { error: "Missing 'sessionId'" });
			const session = dropIfDead(getLive(sessionId));
			if (session) return sendJson(res, 200, { state: session.state, sessionId, provider: config.providerLabel });
			// The same call is mapped to 503 in ensureOwned: a scan that could not complete
			// must not surface as a 500 with the sessions root in the message.
			let found;
			try {
				found = findOmpSession(config, sessionId);
			} catch (error) {
				if (error.code === "SESSION_SCAN_FAILED") {
					return sendJson(res, 503, { error: "could not scan the session root" });
				}
				throw error;
			}
			if (!found) return sendJson(res, 404, { error: "Session not found" });
			return sendJson(res, 200, { state: "idle", sessionId, provider: config.providerLabel });
		}

		if (req.method === "GET" && path === "/api/messages") {
			const sessionId = url.searchParams.get("sessionId");
			if (!sessionId) return sendJson(res, 400, { error: "Missing 'sessionId'" });
			const after = Number(url.searchParams.get("after")) || 0;
			const session = dropIfDead(getLive(sessionId));
			return sendJson(res, 200, {
				messages: getMessages(sessionId, after),
				state: session?.state ?? "idle",
				sessionId,
				provider: config.providerLabel,
			});
		}

		return sendJson(res, 404, { error: "not found" });
	}

	return {
		server,
		token,
		config,
		ownedSessions: sessions,
		async listen() {
			await new Promise((resolve, reject) => {
				server.once("error", reject);
				server.listen(config.port, config.bindHost, resolve);
			});
			log.info(`listening on ${config.bindHost}:${config.port} (sse clients=${totalClients()})`);
			return server.address();
		},
		async close() {
			for (const session of sessions.values()) session.kill();
			sessions.clear();
			// SSE clients hold sockets open; close() alone would wait forever.
			server.closeAllConnections?.();
			await new Promise(resolve => server.close(resolve));
		},
	};
}

export { parseQuestionAnswer };
