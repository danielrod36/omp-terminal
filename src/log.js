import { appendFileSync } from "node:fs";
import { inspect } from "node:util";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

let threshold = LEVELS.info;
let logFile = null;

export function configureLog({ level = "info", file = null } = {}) {
	threshold = LEVELS[level] ?? LEVELS.info;
	logFile = file;
}

/**
 * Strip a pairing token from anything headed for a log line.
 *
 * Every current call site logs a request URL, where the token arrives as a query
 * parameter. `Bearer` headers and bare JSON are covered too because a future line
 * that dumps a header block or a config object would otherwise print the credential
 * in full — the failure would be silent and permanent once it reached the log.
 */
export function redactToken(text) {
	return String(text)
		.replace(/([?&]token=)[^&\s"']*/gi, "$1<redacted>")
		.replace(/(\bBearer\s+)[A-Za-z0-9._~+\/-]+=*/gi, "$1<redacted>")
		.replace(/(["']?token["']?\s*[:=]\s*["'])[^"']*(["'])/gi, "$1<redacted>$2")
		// `token = <value>` with no quotes at all, which is how config objects and
		// hand-written diagnostics tend to print.
		.replace(/(\btoken\s*[:=]\s*)(?!<redacted>)[^\s,;&"')]+/gi, "$1<redacted>");
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
