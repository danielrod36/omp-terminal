import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { createLogger } from "./log.js";

const log = createLogger("store");

/**
 * Persistent bridge config.
 *
 * The stock even-terminal keeps a versioned `~/.even-terminal/config.json` (0600)
 * so the pairing token survives restarts and the glasses never need to re-pair.
 * Without this, a random per-boot token invalidates every stored pairing on each
 * restart — the wearer re-scans forever and a session that "just worked" appears
 * to break for no visible reason.
 *
 * Mirrors the stock shape (token + defaults), not its path.
 */
export const CONFIG_PATH = join(homedir(), ".omp-terminal", "config.json");

export function loadStore(path = CONFIG_PATH) {
	if (!existsSync(path)) return {};
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
	} catch (error) {
		// A corrupt store must not stop the bridge; regenerate on write.
		log.warn(`ignoring unreadable config at ${path}: ${error.message}`);
		return {};
	}
}

export function saveStore(patch, path = CONFIG_PATH) {
	const current = loadStore(path);
	const next = { ...current, ...patch };
	try {
		mkdirSync(dirname(path), { recursive: true });
		// Write a sibling temp file and rename it into place: rename is atomic on POSIX,
		// so a crash, a kill, or ENOSPC mid-write can never leave a truncated store. The
		// token is a pairing credential — a torn write would silently rotate it, and the
		// wearer's paired glasses would 401 with nothing in the log to explain it.
		const temp = `${path}.${process.pid}.tmp`;
		writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
		try {
			// writeFileSync honours an existing file's mode, so force 0600 explicitly:
			// the token is a credential and must not be group/world readable.
			chmodSync(temp, 0o600);
		} catch (error) {
			log.warn(`could not tighten permissions on ${temp}: ${error.message}`);
		}
		renameSync(temp, path);
		return true;
	} catch (error) {
		// A failed save must not litter the config directory with temp files.
		try {
			unlinkSync(`${path}.${process.pid}.tmp`);
		} catch {
			/* never written, or already renamed */
		}
		log.warn(`could not persist config to ${path}: ${error.message}`);
		return false;
	}
}
