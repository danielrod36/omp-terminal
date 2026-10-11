import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
		writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
		// writeFileSync honours an existing file's mode, so force 0600 explicitly:
		// the token is a credential and must not be group/world readable.
		chmodSync(path, 0o600);
		return true;
	} catch (error) {
		log.warn(`could not persist config to ${path}: ${error.message}`);
		return false;
	}
}
