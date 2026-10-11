import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import { loadStore, saveStore } from "./store.js";

/** Built-in defaults, mirrored by the startup banner and README. */
export const DEFAULTS = {
	port: 3456,
	bindHost: "0.0.0.0",
	ompCommand: "omp",
	approvalMode: "always-ask",
	sessionsRoot: join(homedir(), ".omp", "agent", "sessions"),
	attach: true,
	busyWindowMs: 120_000,
	tailIntervalMs: 500,
	historyLimit: 10,
	eventFilter: null,
	/**
	 * Provider name reported on the wire.
	 *
	 * The Even App was built against a fixed vocabulary
	 * (`claude`, `claude-sync`, `codex` — see the stock `SUPPORTED_PROVIDERS`),
	 * and its Terminal Mode picker offers only claude/codex. The reference
	 * bridge, validated live against the glasses, reports `"claude"` for its
	 * own non-Claude backend for exactly this reason. The real backend is
	 * always reported separately in `extra.backend`.
	 */
	providerLabel: "claude",
	/** Real backend identity, surfaced in `/api/info`'s `extra`. */
	backend: "omp",
};

/**
 * Resolve runtime configuration.
 *
 * Precedence mirrors the stock even-terminal: CLI flag > environment > default.
 */
export function loadConfig({ env = process.env, flags = {}, store = loadStore() } = {}) {
	const pick = (flagValue, envKey, fallback) => {
		if (flagValue !== undefined) return flagValue;
		const fromEnv = envKey ? env[envKey] : undefined;
		return fromEnv === undefined || fromEnv === "" ? fallback : fromEnv;
	};
	const bool = (value, fallback) => {
		if (value === undefined) return fallback;
		if (typeof value === "boolean") return value;
		return !["0", "false", "no", "off"].includes(String(value).toLowerCase());
	};

	// Token precedence: flag > env > persisted store > generated-once-and-saved.
	// The store is what keeps the glasses paired across restarts; without it a
	// fresh random token silently invalidates every stored pairing.
	let token = pick(flags.token, "BRIDGE_TOKEN", undefined);
	let tokenSource = token !== undefined ? (flags.token !== undefined ? "flag" : "env") : undefined;
	if (token === undefined && typeof store.token === "string" && store.token) {
		token = store.token;
		tokenSource = "config";
	}
	if (token === undefined) {
		token = randomBytes(16).toString("hex");
		tokenSource = "generated";
		saveStore({ token });
	}
	const cwd = resolve(pick(flags.cwd, "PROJECT_DIR", process.cwd()));

	return {
		port: Number(pick(flags.port, "PORT", DEFAULTS.port)),
		bindHost: pick(flags.bindHost, "BIND_HOST", DEFAULTS.bindHost),
		token,
		tokenSource,
		name: pick(flags.name, "OMP_TERMINAL_NAME", ""),
		cwd,
		ompCommand: pick(flags.omp, "OMP_TERMINAL_OMP_COMMAND", DEFAULTS.ompCommand),
		approvalMode: pick(flags.approvalMode, "OMP_TERMINAL_APPROVAL_MODE", DEFAULTS.approvalMode),
		sessionsRoot: pick(flags.sessionsRoot, "OMP_TERMINAL_SESSIONS_ROOT", DEFAULTS.sessionsRoot),
		historyLimit: DEFAULTS.historyLimit,
		providerLabel: pick(flags.providerLabel, "OMP_TERMINAL_PROVIDER_LABEL", DEFAULTS.providerLabel),
		backend: DEFAULTS.backend,
		attach: bool(pick(flags.attach, "OMP_TERMINAL_ATTACH", undefined), DEFAULTS.attach),
		busyWindowMs: Number(pick(flags.busyWindowMs, "OMP_TERMINAL_BUSY_WINDOW_MS", DEFAULTS.busyWindowMs)),
		tailIntervalMs: Number(pick(flags.tailIntervalMs, "OMP_TERMINAL_TAIL_INTERVAL_MS", DEFAULTS.tailIntervalMs)),
		allowCors: bool(pick(flags.allowCors, "EVEN_ALLOW_CORS", undefined), false),
		networkMode: flags.networkMode ?? null,
		expose: flags.expose ?? null,
		logFile: flags.logFile ?? null,
		logLevel: pick(flags.logLevel, "OMP_TERMINAL_LOG_LEVEL", "info"),
	};
}
