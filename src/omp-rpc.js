import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";
import { createLogger } from "./log.js";

const log = createLogger("omp-rpc");

const MAX_FRAME_BYTES = 1024 * 1024;

/**
 * Drive one `omp --mode rpc-ui` child process.
 *
 * Wire facts verified live against omp v18.8.7 (see docs/PROTOCOL.md):
 *  - stdout is NDJSON; `ready` arrives first, then `response` frames for
 *    commands, `extension_ui_request` frames for dialogs, and session event
 *    frames (`agent_start`, `message_update`, `tool_execution_*`,
 *    `prompt_result`, `session_settled`, ...).
 *  - `message_update.assistantMessageEvent` carries `thinking_*`, `text_*`,
 *    and `toolcall_*` sub-events; `text_delta.delta` is the display source.
 *  - `extension_ui_request{method:"select"}` is a tool approval; answering it
 *    with `{"type":"extension_ui_response","id":...,"value":"Approve"}` is what
 *    lets a write proceed under `--approval-mode always-ask`.
 *  - `--mode rpc` (not rpc-ui) leaves `hasUI=false`, which disables the `ask`
 *    tool and every dialog frame; the UI context is only wired for rpc-ui.
 */
export class OmpRpc extends EventEmitter {
	#child = null;
	#rl = null;
	#pending = new Map();
	#requestId = 0;
	#ready = false;
	#readyWaiters = [];
	#stderr = [];
	#closed = false;

	constructor({ command, args, cwd, env } = {}) {
		super();
		this.command = command ?? "omp";
		this.args = args ?? [];
		this.cwd = cwd;
		this.env = env ?? process.env;
	}

	get ready() {
		return this.#ready;
	}

	async start() {
		if (this.#child) throw new Error("OmpRpc already started");
		const argv = ["--mode", "rpc-ui", ...this.args];
		log.info(`spawn ${this.command} ${argv.join(" ")} (cwd=${this.cwd})`);
		this.#child = spawn(this.command, argv, {
			cwd: this.cwd,
			env: { ...this.env },
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.#child.on("error", error => {
			log.error(`spawn failed: ${error.message}`);
			this.#failAll(error);
			this.emit("exit", { code: null, error });
		});
		this.#child.on("exit", (code, signal) => {
			this.#closed = true;
			log.info(`child exited code=${code} signal=${signal}`);
			this.#failAll(new Error(`omp exited (code=${code}, signal=${signal})`));
			this.emit("exit", { code, signal });
		});
		this.#child.stderr.on("data", chunk => {
			const text = chunk.toString();
			this.#stderr.push(text);
			if (this.#stderr.length > 200) this.#stderr.shift();
			for (const line of text.split("\n")) {
				if (line.trim()) log.debug(`stderr: ${line.trim()}`);
			}
		});
		// A pipe write racing the child's death raises EPIPE/ERR_STREAM_DESTROYED on the
		// socket ASYNCHRONOUSLY, so the try/catch around write() cannot intercept it and an
		// unhandled 'error' event would take the whole bridge down — every SSE client with
		// it. A wearer tapping Allow on a permission card as omp crashes hits exactly this.
		// The child's own 'exit' handler already fails the pending requests.
		this.#child.stdin.on("error", error => {
			log.warn(`stdin closed: ${error.code ?? error.message}`);
		});
		this.#child.stdout.on("error", error => {
			log.warn(`stdout closed: ${error.code ?? error.message}`);
		});
		this.#child.stderr.on("error", error => {
			log.warn(`stderr closed: ${error.code ?? error.message}`);
		});
		this.#rl = createInterface({ input: this.#child.stdout, crlfDelay: Infinity });
		this.#rl.on("line", line => this.#handleLine(line));
		// A ready wait that times out must not orphan the child we just spawned: the
		// caller has no reference to it, so nothing else can ever reap it.
		try {
			await this.#waitReady();
		} catch (error) {
			this.kill();
			throw error;
		}
	}

	#handleLine(line) {
		if (!line.trim()) return;
		if (Buffer.byteLength(line, "utf8") > MAX_FRAME_BYTES) {
			log.warn(`oversized frame dropped (${Buffer.byteLength(line, "utf8")} bytes)`);
			return;
		}
		let frame;
		try {
			frame = JSON.parse(line);
		} catch {
			log.warn(`unparseable frame dropped: ${line.slice(0, 200)}`);
			return;
		}
		if (frame.type === "ready") {
			this.#ready = true;
			log.info(
				`ready protocolVersion=${frame.protocolVersion} supported=${JSON.stringify(frame.supportedProtocolVersions)}`,
			);
			for (const resolve of this.#readyWaiters.splice(0)) resolve();
			this.emit("ready", frame);
			return;
		}
		if (frame.type === "response" && frame.id && this.#pending.has(frame.id)) {
			const { resolve, reject, command } = this.#pending.get(frame.id);
			this.#pending.delete(frame.id);
			if (frame.success === false) {
				const error = Object.assign(new Error(frame.error ?? "rpc command failed"), { code: frame.code });
				log.warn(`${command} failed: ${error.message}`);
				reject(error);
			} else {
				resolve(frame.data);
			}
			return;
		}
		this.emit("frame", frame);
	}

	#waitReady() {
		if (this.#ready) return Promise.resolve();
		return new Promise((resolve, reject) => {
			this.#readyWaiters.push(resolve);
			const timer = setTimeout(() => reject(new Error("omp did not signal ready within 30s")), 30_000);
			this.once("exit", () => {
				clearTimeout(timer);
				reject(new Error(`omp exited before ready; stderr: ${this.stderrTail()}`));
			});
		});
	}

	#failAll(error) {
		for (const { reject } of this.#pending.values()) reject(error);
		this.#pending.clear();
	}

	/** Send one command and await its matching `response` frame. */
	send(command, { timeoutMs = 30_000 } = {}) {
		if (this.#closed) return Promise.reject(new Error("omp process is closed"));
		const id = `b${++this.#requestId}`;
		const payload = JSON.stringify({ id, ...command });
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.#pending.delete(id);
				reject(new Error(`rpc command '${command.type}' timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			this.#pending.set(id, {
				command: command.type,
				resolve: value => {
					clearTimeout(timer);
					resolve(value);
				},
				reject: error => {
					clearTimeout(timer);
					reject(error);
				},
			});
			try {
				this.#child.stdin.write(`${payload}\n`);
			} catch (error) {
				clearTimeout(timer);
				this.#pending.delete(id);
				reject(error);
			}
		});
	}

	/** Fire-and-forget write for frames whose response is not needed. */
	write(frame) {
		if (this.#closed) return false;
		try {
			this.#child.stdin.write(`${JSON.stringify(frame)}\n`);
			return true;
		} catch (error) {
			log.warn(`write failed: ${error.message}`);
			return false;
		}
	}

	/** Answer an `extension_ui_request` dialog. */
	respond(requestId, response) {
		return this.write({ type: "extension_ui_response", id: requestId, ...response });
	}

	stderrTail(maxChars = 500) {
		return this.#stderr.join("").slice(-maxChars).trim();
	}

	kill(signal = "SIGTERM") {
		if (!this.#child) return;
		try {
			this.#child.kill(signal);
		} catch {
			/* already gone */
		}
	}

	get closed() {
		return this.#closed;
	}
}
