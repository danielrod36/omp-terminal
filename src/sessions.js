import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { createLogger } from "./log.js";

const log = createLogger("sessions");

/**
 * Session discovery over omp's own transcript store.
 *
 * Layout verified against omp v18.8.7 (`src/session/session-paths.ts`,
 * `src/session/session-manager.ts`):
 *   <sessionsRoot>/<encoded-cwd>/*.jsonl
 * where cwd is home-relative (`-Work` for `~/Work`), tmp-relative under
 * `/tmp`, or the absolute path with separators encoded as `-`.
 * Each file's first two lines are a `title` record and a `session` record
 * carrying `id` and `cwd`.
 */

/**
 * Encode a cwd the way omp's session buckets do.
 *
 * Mirrors `getDefaultSessionDirName` in omp's `src/session/session-paths.ts`
 * (verified against 18.8.9 artifacts): home-relative gets `-<rel>`, a cwd under
 * the temp root gets `-tmp-<rel>`, and anything else keeps the legacy absolute
 * form `--<abs with separators as dashes>--`. The trailing `--` matters: a
 * bucket for `/var/tmp/proj` is `--var-tmp-proj--`, not `var-tmp-proj`.
 */
export function sessionDirName(cwd, { home, tmp = "/tmp" } = {}) {
	const homeDir = home ?? process.env.HOME ?? "";
	if (homeDir && (cwd === homeDir || cwd.startsWith(`${homeDir}/`))) {
		return `-${cwd.slice(homeDir.length).replace(/^\/+/, "").replace(/\//g, "-")}` || "-";
	}
	if (cwd === tmp || cwd.startsWith(`${tmp}/`)) {
		return `-tmp-${cwd.slice(tmp.length).replace(/^\/+/, "").replace(/\//g, "-")}`;
	}
	return `--${cwd.replace(/^\/+/, "").replace(/[/:]/g, "-")}--`;
}

/** Read at most `maxBytes` from a file without loading the whole transcript. */
function readPrefix(file, maxBytes) {
	const fd = openSync(file, "r");
	try {
		const buffer = Buffer.allocUnsafe(maxBytes);
		const read = readSync(fd, buffer, 0, maxBytes, 0);
		return buffer.toString("utf8", 0, read);
	} finally {
		closeSync(fd);
	}
}

function parseHead(file, maxBytes = 64 * 1024) {
	const text = readPrefix(file, maxBytes);
	let title = "";
	let sessionId = "";
	let cwd = "";
	let created = "";
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		let record;
		try {
			record = JSON.parse(line);
		} catch {
			break;
		}
		if (record.type === "title" && !title) title = record.title ?? "";
		if (record.type === "session") {
			sessionId = record.id ?? "";
			cwd = record.cwd ?? "";
			created = record.timestamp ?? "";
		}
		if (title && sessionId) break;
	}
	return { title, sessionId, cwd, created };
}

function tailLines(file, maxBytes = 256 * 1024) {
	const size = statSync(file).size;
	const start = Math.max(0, size - maxBytes);
	const fd = openSync(file, "r");
	try {
		const buffer = Buffer.allocUnsafe(size - start);
		const read = readSync(fd, buffer, 0, buffer.length, start);
		return buffer.toString("utf8", 0, read).split("\n").filter(Boolean);
	} finally {
		closeSync(fd);
	}
}

/**
 * Derive coarse lifecycle state from the transcript's tail.
 *
 * A trailing user/tool-result record means the agent was mid-turn — but only if
 * the file moved recently. Without the freshness gate a crashed or parked turn
 * reads "busy" forever, and the lens shows "working" for a dead session.
 */
function deriveStatus(file, busyWindowMs) {
	const lines = tailLines(file);
	let trailing = null;
	for (let index = lines.length - 1; index >= 0; index--) {
		let record;
		try {
			record = JSON.parse(lines[index]);
		} catch {
			continue;
		}
		if (record.type !== "message") continue;
		const role = record.message?.role;
		if (role === "user" || role === "toolResult") trailing = "busy";
		else if (role === "assistant") trailing = "idle";
		if (trailing) break;
	}
	if (trailing !== "busy") return "idle";
	let fresh = false;
	try {
		fresh = Date.now() - statSync(file).mtimeMs < busyWindowMs;
	} catch {
		fresh = false;
	}
	return fresh ? "busy" : "idle";
}

function firstUserText(file) {
	const text = readPrefix(file, 256 * 1024);
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		let record;
		try {
			record = JSON.parse(line);
		} catch {
			continue;
		}
		if (record.type === "message" && record.message?.role === "user") {
			const content = record.message.content;
			if (typeof content === "string") return content;
			if (Array.isArray(content)) {
				const text = content
					.filter(block => block?.type === "text")
					.map(block => block.text)
					.join(" ")
					.trim();
				if (text) return text;
			}
		}
	}
	return "";
}

/**
 * Every omp session on disk, newest first.
 *
 * `sessionsRoot` is the omp sessions root: the bridge reads the agent's own
 * transcripts, so a session started at the desk or under `tmux` appears here
 * without the bridge owning it.
 */
export function listOmpSessions(config, { limit = 50 } = {}) {
	const root = config.sessionsRoot;
	if (!existsSync(root)) return [];
	const out = [];
	for (const dirName of readdirSync(root)) {
		const dir = join(root, dirName);
		let entries;
		try {
			if (!statSync(dir).isDirectory()) continue;
			entries = readdirSync(dir).filter(name => name.endsWith(".jsonl"));
		} catch {
			continue;
		}
		for (const name of entries) {
			const file = join(dir, name);
			let stat;
			try {
				stat = statSync(file);
			} catch {
				continue;
			}
			if (stat.size === 0) continue;
			const head = parseHead(file);
			if (!head.sessionId) continue;
			const status = deriveStatus(file, config.busyWindowMs);
			const cwd = head.cwd || "";
			out.push({
				id: head.sessionId,
				path: file,
				title: (head.title || firstUserText(file) || basename(cwd) || "session").slice(0, 64),
				cwd,
				timestamp: new Date(head.created || stat.mtimeMs).toISOString(),
				modified: stat.mtimeMs,
				size: stat.size,
				status,
			});
		}
	}
	out.sort((left, right) => right.modified - left.modified);
	return out.slice(0, limit);
}

/**
 * Resolve a session id (or exact transcript path) to one transcript.
 *
 * Matching is deliberately strict: an exact session id, an exact file name, or
 * an unambiguous id prefix (omp's own `--resume` semantics). A bare substring
 * test — the previous behaviour — resolved arbitrary garbage like `"1"` to a
 * timestamp containing that digit, so a typo resumed and exposed an unrelated
 * transcript. Ambiguity resolves to null rather than guessing.
 */
export function findOmpSession(config, idOrPath) {
	if (!idOrPath) return null;
	if (idOrPath.endsWith(".jsonl") && existsSync(idOrPath)) {
		const head = parseHead(idOrPath);
		return { ...head, path: idOrPath };
	}
	const root = config.sessionsRoot;
	if (!existsSync(root)) return null;
	let prefixMatch = null;
	for (const dirName of readdirSync(root)) {
		const dir = join(root, dirName);
		let entries;
		try {
			entries = readdirSync(dir).filter(name => name.endsWith(".jsonl"));
		} catch {
			continue;
		}
		for (const name of entries) {
			const file = join(dir, name);
			// Transcript names are `<timestamp>_<sessionId>.jsonl`; the id is the
			// suffix after the last underscore, so an exact id can be checked from
			// the file name alone.
			const base = name.slice(0, -".jsonl".length);
			const separator = base.lastIndexOf("_");
			const namedId = separator >= 0 ? base.slice(separator + 1) : base;
			if (namedId === idOrPath || name === idOrPath) {
				const head = parseHead(file);
				if (head.sessionId === idOrPath) return { ...head, path: file };
				// The file name matched but the head disagrees (an odd/truncated
				// transcript): fall through and keep scanning for a clean match.
				if (!prefixMatch && head.sessionId && head.sessionId.startsWith(idOrPath)) prefixMatch = { ...head, path: file };
				continue;
			}
			if (idOrPath.length < 6 || !namedId.startsWith(idOrPath)) continue;
			// Prefix hits are only safe when exactly one transcript matches.
			if (prefixMatch) return null;
			prefixMatch = { ...parseHead(file), path: file };
		}
	}
	return prefixMatch;
}

/**
 * Display history (role + text) for one session, oldest first.
 *
 * User prompts are sparse in a long transcript (assistant/tool-result records
 * dominate), so a fixed tail window can miss them entirely. Walk backwards in
 * bounded chunks until `limit` displayable turns are collected or the cap is
 * reached, so the cost stays proportional to what is shown.
 */
export function ompHistory(config, idOrPath, limit = 10) {
	const found = findOmpSession(config, idOrPath);
	if (!found) return [];
	const CHUNK = 256 * 1024;
	const MAX_CHUNKS = 8; // 2 MiB ceiling
	const size = statSync(found.path).size;
	const fd = openSync(found.path, "r");
	const collected = [];
	try {
		let end = size;
		for (let chunk = 0; chunk < MAX_CHUNKS && end > 0 && collected.length < limit; chunk++) {
			const start = Math.max(0, end - CHUNK);
			const buffer = Buffer.allocUnsafe(end - start);
			const read = readSync(fd, buffer, 0, buffer.length, start);
			const text = buffer.toString("utf8", 0, read);
			// A chunk boundary can split a record; drop the leading partial line
			// when this chunk does not begin at the file head.
			const lines = text.split("\n");
			if (start > 0) lines.shift();
			for (let index = lines.length - 1; index >= 0; index--) {
				const item = historyItem(lines[index]);
				if (item) collected.unshift(item);
			}
			end = start;
		}
	} finally {
		closeSync(fd);
	}
	return collected.slice(-limit);
}

/** One displayable history item from a transcript line, or null. */
function historyItem(line) {
	if (!line.trim()) return null;
	let record;
	try {
		record = JSON.parse(line);
	} catch {
		return null;
	}
	if (record.type !== "message") return null;
	const role = record.message?.role;
	if (role !== "user" && role !== "assistant") return null;
	const content = record.message.content;
	let body = "";
	if (typeof content === "string") body = content;
	else if (Array.isArray(content)) {
		body = content
			.filter(block => block?.type === "text")
			.map(block => block.text)
			.join("\n")
			.trim();
	}
	return body ? { role, text: body } : null;
}

export { log };
