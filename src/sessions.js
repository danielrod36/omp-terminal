import { closeSync, existsSync, openSync, readSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { createLogger } from "./log.js";

const log = createLogger("sessions");

/**
 * Session discovery over omp's own transcript store.
 *
 * Layout verified against omp v18.8.9 (`src/session/session-paths.ts`):
 *   <sessionsRoot>/<encoded-cwd>/*.jsonl
 * where cwd is home-relative (`-Work` for `~/Work`), tmp-relative under the
 * temp root (`-tmp-x` for `/tmp/x`), and otherwise the legacy absolute form
 * (`--var-tmp-proj--` for `/var/tmp/proj`).
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
	let fd;
	try {
		fd = openSync(file, "r");
	} catch {
		// Rotated away between the listing and the read.
		return "";
	}
	try {
		const buffer = Buffer.allocUnsafe(maxBytes);
		const read = readSync(fd, buffer, 0, maxBytes, 0);
		return buffer.toString("utf8", 0, read);
	} catch {
		return "";
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
	let size;
	try {
		size = statSync(file).size;
	} catch {
		return [];
	}
	const start = Math.max(0, size - maxBytes);
	let fd;
	try {
		fd = openSync(file, "r");
	} catch {
		return [];
	}
	try {
		const buffer = Buffer.allocUnsafe(size - start);
		const read = readSync(fd, buffer, 0, buffer.length, start);
		return buffer.toString("utf8", 0, read).split("\n").filter(Boolean);
	} catch {
		return [];
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
	let rootEntries;
	try {
		rootEntries = readdirSync(root);
	} catch {
		return [];
	}
	// Collect cheap candidates first: a stat per transcript, newest first, and parse only until
	// `limit` rows exist. Parsing every file up front made each request O(total transcript bytes)
	// of synchronous I/O — measured on this host's store (354 transcripts, ~602 MB) a limit=1
	// listing still took 111 ms and touched every file, because `limit` was applied to the result
	// slice only, after every parseHead (64 KiB) plus deriveStatus (256 KiB tail) had run.
	const candidates = [];
	for (const dirName of rootEntries) {
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
			try {
				const stat = statSync(file);
				if (stat.size === 0) continue;
				candidates.push({ file, modified: stat.mtimeMs, size: stat.size });
			} catch {
				continue;
			}
		}
	}
	candidates.sort((left, right) => right.modified - left.modified);

	const out = [];
	for (const candidate of candidates) {
		if (out.length >= limit) break;
		const head = parseHead(candidate.file);
		if (!head.sessionId) continue;
		const status = deriveStatus(candidate.file, config.busyWindowMs);
		const cwd = head.cwd || "";
		out.push({
			id: head.sessionId,
			path: candidate.file,
			title: (head.title || firstUserText(candidate.file) || basename(cwd) || "session").slice(0, 64),
			cwd,
			timestamp: new Date(head.created || candidate.modified).toISOString(),
			modified: candidate.modified,
			size: candidate.size,
			status,
		});
	}
	return out;
}

/**
 * Resolve a session id (or exact transcript path) to one transcript.
 *
 * Matching is deliberately strict: an exact session id, an exact file name, or
 * an unambiguous id prefix (omp's own `--resume` semantics). A bare substring
 * test — the previous behaviour — resolved arbitrary garbage like `"1"` to a
 * timestamp containing that digit, so a typo resumed and exposed an unrelated
 * transcript. Ambiguity resolves to `null` rather than guessing.
 *
 * A `null` means "no such session", which callers read as "start fresh". Two
 * cases reach it: the root or the id is genuinely absent, and the scan is
 * ambiguous. A scan that could not *complete* (EMFILE/ENFILE/EACCES) is never
 * reported as `null` — that would silently drop a resume the wearer expected to
 * find; it throws a tagged error instead, which callers surface or retry.
 */
/**
 * A session id is opaque: a uuid, or any id-shaped token without a path separator.
 *
 * Distinguishing an id from a path is what keeps a client-supplied path from ever
 * reaching the filesystem, even when it points inside the sessions root.
 */
function isSessionId(value) {
	return Boolean(value) && !value.includes("/") && !value.includes("\\");
}

/**
 * True when `file` resolves inside the configured sessions root.
 *
 * Everything read as a transcript must pass this: the id comes from an HTTP path
 * segment, and a bare `existsSync` would let it name any file on the host.
 */
function isInsideSessionsRoot(config, file) {
	const root = config.sessionsRoot;
	if (!root) return false;
	let resolvedRoot;
	let realRoot;
	let realFile;
	try {
		resolvedRoot = resolve(root);
		// realpath, not resolve: resolve() is LEXICAL, so a symlink placed inside the root passes a
		// resolve-based check while pointing anywhere on the host — measured: a symlink at
		// <root>/link.jsonl to an outside file was parsed and its title served. Comparing real paths
		// is what actually confines the read.
		realRoot = realpathSync(resolvedRoot);
		realFile = realpathSync(file);
	} catch {
		// A path whose realpath cannot be taken (missing, or a broken link) is not a transcript.
		return false;
	}
	const prefix = realRoot.endsWith(sep) ? realRoot : realRoot + sep;
	return realFile === realRoot || realFile.startsWith(prefix);
}

export function findOmpSession(config, idOrPath) {
	// A JSON body can carry any type (`{"sessionId": 123}`); a non-string is simply an
	// unknown id, not a 500 from `.includes` on a number.
	if (typeof idOrPath !== "string" || !idOrPath) return null;
	const root = config.sessionsRoot;
	// A transcript is only ever a file INSIDE the sessions root. The id reaches this
	// function from an HTTP path segment, so accepting any existing `.jsonl` let a token
	// holder read arbitrary files on the host (verified: an absolute path outside the root
	// was served in full). Compare resolved paths so `..` cannot climb out either.
	// A path is only honoured when the CALLER supplied one (a live session's transcript,
	// which the bridge read from omp itself). A bare id — the only shape an HTTP path
	// segment may take — never names a file, so it cannot become a path here at all.
	if (!isSessionId(idOrPath) && idOrPath.endsWith(".jsonl") && isInsideSessionsRoot(config, idOrPath) && existsSync(idOrPath)) {
		const head = parseHead(idOrPath);
		return { ...head, path: idOrPath };
	}
	if (!existsSync(root)) return null;
	let rootEntries;
	try {
		rootEntries = readdirSync(root);
	} catch (error) {
		const wrapped = new Error(`could not scan the session root ${root}: ${error.message}`);
		wrapped.code = "SESSION_SCAN_FAILED";
		throw wrapped;
	}
	// Prefix matching follows omp's `--resume` semantics and needs enough
	// characters to be meaningful; shorter inputs are only ever exact matches.
	const allowPrefix = idOrPath.length >= 6;
	const prefixMatches = [];
	let exactFallback = null;
	for (const dirName of rootEntries) {
		const dir = join(root, dirName);
		let entries;
		try {
			entries = readdirSync(dir).filter(name => name.endsWith(".jsonl"));
		} catch (error) {
			// Swallowing this would make an unreadable bucket look like an empty one, so
			// `null` would mean "no such session" and the caller would fork a fresh thread
			// over the wearer's resumed one — exactly what the contract above forbids.
			// A missing bucket is ordinary (sessions are deleted), anything else is not.
			if (error.code === "ENOENT" || error.code === "ENOTDIR") continue;
			const wrapped = new Error(`could not scan the session bucket ${dir}: ${error.message}`);
			wrapped.code = "SESSION_SCAN_FAILED";
			throw wrapped;
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
				// The file name matched but the head disagrees or is unreadable
				// (a truncated or mid-write transcript). An exact file-name hit is
				// unambiguous, so remember it and keep looking for a head match;
				// this is a last resort, never a prefix guess.
				if (!exactFallback) exactFallback = { ...head, path: file };
				continue;
			}
			if (!allowPrefix || !namedId.startsWith(idOrPath)) continue;
			prefixMatches.push({ ...parseHead(file), path: file });
		}
	}
	// Ambiguity must not depend on readdir order: collect every prefix hit and
	// refuse when more than one transcript could be meant.
	if (exactFallback) return exactFallback;
	return prefixMatches.length === 1 ? prefixMatches[0] : null;
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
	let size;
	try {
		size = statSync(found.path).size;
	} catch {
		return [];
	}
	let fd;
	try {
		fd = openSync(found.path, "r");
	} catch {
		return [];
	}
	const collected = [];
	try {
		let end = size;
		for (let chunk = 0; chunk < MAX_CHUNKS && end > 0 && collected.length < limit; chunk++) {
			const start = Math.max(0, end - CHUNK);
			const buffer = Buffer.allocUnsafe(end - start);
			// A read can fail mid-file (a truncated or rotated transcript). What was
			// already collected is valid history, so keep it and stop reading rather
			// than letting the throw escape into the route's 200-with-error path.
			let read;
			try {
				read = readSync(fd, buffer, 0, buffer.length, start);
			} catch {
				break;
			}
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
