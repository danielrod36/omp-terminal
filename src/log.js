import { appendFileSync } from "node:fs";
import { inspect } from "node:util";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

let threshold = LEVELS.info;
let logFile = null;

export function configureLog({ level = "info", file = null } = {}) {
	threshold = LEVELS[level] ?? LEVELS.info;
	logFile = file;
}

export function redactToken(text) {
	const s = String(text);
	return s.replace(/([?&]token=)[^&]*/g, "$1<redacted>");
}

function write(level, scope, message) {
	if ((LEVELS[level] ?? LEVELS.info) < threshold) return;
	const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${redactToken(message)}`;
	if (logFile) {
		try {
			appendFileSync(logFile, `${line}\n`);
		} catch {
			/* keep stdout alive when the log file is unwritable */
		}
	}
	const sink = level === "error" || level === "warn" ? console.error : console.log;
	sink(line);
}

export function createLogger(scope) {
	return {
		debug: message => write("debug", scope, message),
		info: message => write("info", scope, message),
		warn: message => write("warn", scope, message),
		error: message => write("error", scope, message),
		inspect: (label, value) => write("debug", scope, `${label} ${inspect(value, { depth: 4, breakLength: 120 })}`),
	};
}
