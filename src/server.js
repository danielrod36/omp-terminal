import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { URL } from "node:url";
import { createLogger, redactToken } from "./log.js";
import { addClient, getMessages, historyFromRing, linkSessions, totalClients } from "./events.js";
import { OwnedSession, parseQuestionAnswer } from "./provider.js";
import { AttachSession, listTmuxOmpSessions } from "./attach.js";
import { findOmpSession, listOmpSessions, ompHistory } from "./sessions.js";

const log = createLogger("http");
const run = promisify(execFile);

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
		if (total > 10 * 1024 * 1024) throw new Error("request body too large");
		chunks.push(chunk);
	}
	if (chunks.length === 0) return {};
	const text = Buffer.concat(chunks).toString("utf8").trim();
	if (!text) return {};
	return JSON.parse(text);
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
	async function resolveOmpVersion() {
		if (ompVersion !== undefined) return ompVersion;
		try {
			const { stdout } = await run(config.ompCommand, ["--version"], { timeout: 5000 });
			ompVersion = stdout.trim().replace(/^omp\//, "") || null;
		} catch (error) {
			log.warn(`could not resolve omp version: ${error.message}`);
			ompVersion = null;
		}
		return ompVersion;
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

	/** Attach-mode sessions keyed by tmux session name, so one pane maps to one bridge session. */
	const attachRegistry = new Map(); // tmuxSession -> AttachSession

	/** Stable bridge id for a tmux-hosted pane (independent of transcript timing). */
	function attachId(tmuxSession) {
		return `tmux:${tmuxSession}`;
	}

	function ensureAttached(entry) {
		const existing = attachRegistry.get(entry.attach.tmuxSession);
		if (existing) {
			if (!existing.transcriptPath && entry.attach.transcriptPath) {
				existing.transcriptPath = entry.attach.transcriptPath;
			}
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
		const existing = getLive(sessionId);
		if (existing && !(existing instanceof OwnedSession && existing.rpc?.closed)) return existing;
		if (pendingSpawns.has(sessionId)) return pendingSpawns.get(sessionId);
		const spawnPromise = (async () => {
			const found = resumePath ?? findOmpSession(config, sessionId)?.path ?? null;
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
			await session.start();
			// omp mints the canonical session id (kept across a resume). Adopt it,
			// and link the id the client already subscribed to, so whichever
			// identity the app holds the answer still reaches its SSE ring.
			const clientId = sessionId;
			session.id = session.ompSessionId ?? session.id;
			if (clientId && clientId !== session.id) {
				sessionAliases.set(clientId, session.id);
				linkSessions(clientId, session.id);
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
		const live = getLive(sessionId);
		if (live) return live;
		if (config.attach) {
			const attached = await findAttachEntry(sessionId);
			if (attached) return ensureAttached(attached);
		}
		return ensureOwned(sessionId, { cwd });
	}

	async function findAttachEntry(sessionId) {
		if (!sessionId) return null;
		const entries = await listTmuxOmpSessions(config);
		return entries.find(entry => entry.id === sessionId) ?? null;
	}

	async function listSessions({ cwd, limit }) {
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
		const disk = listOmpSessions(config, { limit }).map(session => ({
			id: session.id,
			title: session.title,
			timestamp: session.timestamp,
			cwd: session.cwd,
			provider: config.providerLabel,
			status: getLive(session.id)?.state ?? session.status,
		}));
		const seen = new Set();
		const merged = [];
		// Live bridge sessions take priority; the tmux panes that back them merge
		// by tmux name; remaining on-disk transcripts fill in the rest.
		for (const session of [...live, ...attached, ...disk]) {
			const key = session.attach ? `tmux:${session.attach.tmuxSession}` : session.id;
			if (seen.has(key)) continue;
			seen.add(key);
			merged.push(session);
		}
		const filtered = cwd ? merged.filter(session => session.cwd === cwd) : merged;
		return filtered.slice(0, limit);
	}

	const server = createServer(async (req, res) => {
		const started = Date.now();
		res.on("finish", () => {
			log.info(`${req.socket.remoteAddress} ${res.statusCode} ${req.method} ${redactToken(req.url)} ${Date.now() - started}ms`);
		});
		try {
			await route(req, res);
		} catch (error) {
			log.error(`unhandled route error: ${error.message}`);
			if (!res.headersSent) sendJson(res, 500, { error: error.message });
			else res.end();
		}
	});

	async function route(req, res) {
		const url = new URL(req.url, "http://localhost");
		const path = url.pathname;

		if (config.allowCors && req.method === "OPTIONS") {
			res.writeHead(204, {
				"Access-Control-Allow-Origin": "*",
				"Access-Control-Allow-Headers": "authorization, content-type, last-event-id",
				"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
			});
			return res.end();
		}

		if (path === "/healthz") {
			return sendJson(res, 200, {
				ok: true,
				provider: config.providerLabel,
				backend: config.backend,
				ownedSessions: sessions.size,
				sseClients: totalClients(),
				sessionsRoot: config.sessionsRoot,
				uptimeMs: Math.round(process.uptime() * 1000),
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
				},
			});
		}

		if (req.method === "GET" && path === "/api/update-check") {
			return sendJson(res, 200, {
				packageName: "omp-terminal",
				currentVersion: "0.1.0",
				newestVersion: null,
				updateAvailable: null,
				checkedAt: new Date().toISOString(),
			});
		}

		const historyMatch = path.match(/^\/api\/sessions\/([^/]+)\/history$/);
		if (req.method === "GET" && historyMatch) {
			const id = decodeURIComponent(historyMatch[1]);
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
				return sendJson(res, 200, { history: historyFromRing(id, limit), error: error.message });
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
			const session = getLive(sessionId);
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
			const session = getLive(sessionId);
			if (!session) return sendJson(res, 404, { error: "Session not found" });
			const accepted = await session.answerQuestion(answer ?? "skip");
			if (!accepted) return sendJson(res, 400, { error: "No question is pending" });
			return sendJson(res, 200, { ok: true });
		}

		if (req.method === "POST" && path === "/api/interrupt") {
			const { sessionId } = (await readJson(req)) ?? {};
			if (!sessionId) return sendJson(res, 400, { error: "Missing 'sessionId'" });
			const session = getLive(sessionId);
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
			const session = getLive(sessionId);
			if (session) return sendJson(res, 200, { state: session.state, sessionId, provider: config.providerLabel });
			const found = findOmpSession(config, sessionId);
			if (!found) return sendJson(res, 404, { error: "Session not found" });
			return sendJson(res, 200, { state: "idle", sessionId, provider: config.providerLabel });
		}

		if (req.method === "GET" && path === "/api/messages") {
			const sessionId = url.searchParams.get("sessionId");
			if (!sessionId) return sendJson(res, 400, { error: "Missing 'sessionId'" });
			const after = Number(url.searchParams.get("after")) || 0;
			const session = getLive(sessionId);
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
