import { execFile } from "node:child_process";
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { promisify } from "node:util";
import { createLogger } from "./log.js";
import { emit } from "./events.js";
import { forDisplay, statusFrame, textCommitFrames, userPromptFrame, questionFrame } from "./frames.js";
import { findOmpSession, sessionDirName } from "./sessions.js";

const log = createLogger("attach");
const run = promisify(execFile);

/**
 * Attach-to-live mode: steer an interactive omp TUI already running under tmux.
 *
 * Verified live against omp v18.8.7:
 *  - a tmux pane whose `pane_current_command` is `omp` hosts the TUI;
 *    `tmux send-keys -t <name> -l '<text>'` + `Enter` submits a prompt;
 *  - the approval menu renders as a bordered box headed `Allow tool: <name>`
 *    with an `❯ Approve` / `Deny` list; `Enter` approves, `Down`+`Enter` denies;
 *  - the pane's `pane_current_path` identifies the cwd, whose session bucket
 *    holds the transcript the TUI appends to.
 *
 * Reads come from that transcript (the desk agent owns the process), so the
 * bridge never fights a second process for the same session.
 */
export class AttachSession {
	constructor({ id, tmuxSession, cwd, provider, config, transcriptPath }) {
		this.id = id;
		this.tmuxSession = tmuxSession;
		this.cwd = cwd;
		this.provider = provider;
		this.config = config;
		this.transcriptPath = transcriptPath ?? null;
		this.state = "idle";
		this.title = tmuxSession;
		this.lastActivity = Date.now();
		this.offset = 0;
		this.timer = null;
		this.lastDialogSignature = "";
		/** Assistant record timestamps already painted, so a re-read never duplicates. */
		this.seenAssistant = new Set();
	}

	async start() {
		this.#resolveTranscript();
		if (this.transcriptPath && existsSync(this.transcriptPath)) {
			this.offset = statSync(this.transcriptPath).size;
		}
		this.timer = setInterval(() => this.#poll().catch(error => log.warn(`poll failed: ${error.message}`)), this.config.tailIntervalMs);
		this.timer.unref?.();
		return this;
	}

	/**
	 * Point the tail at a transcript the pane is (or has started) writing.
	 *
	 * The desk TUI mints a new session file on its next turn, and a freshly
	 * started TUI writes nothing at all until then — so a binding chosen at
	 * attach time goes stale and every later answer is read from the wrong file.
	 * Swapping the target here keeps the stream on the conversation the wearer
	 * is actually having.
	 *
	 * History is not re-emitted, with one exception: if the adopted file's last
	 * assistant turn is fresh (the poll interval is up to 500 ms, so a fast turn
	 * can finish before the swap), the tail rewinds to that record so the answer
	 * the wearer is waiting for still paints. Timestamp dedup keeps it single.
	 */
	adoptTranscript(path) {
		if (!path || path === this.transcriptPath) return;
		if (!existsSync(path)) return;
		// Only adopt a file this pane could be writing: same bucket as the cwd,
		// and newer than what we are currently following.
		if (!path.startsWith(`${this.config.sessionsRoot}/${sessionDirName(this.cwd)}/`)) return;
		if (this.transcriptPath && existsSync(this.transcriptPath) && statSync(this.transcriptPath).mtimeMs > statSync(path).mtimeMs) return;
		log.info(`attach ${this.id} adopted transcript ${path}`);
		this.transcriptPath = path;
		this.offset = this.#resumeOffset(path);
	}

	/**
	 * Where to start reading an adopted transcript.
	 *
	 * Normally the end (past history). If its newest assistant record is within
	 * the busy window, start at that record so a turn that completed before the
	 * swap is not lost.
	 */
	#resumeOffset(path) {
		const size = statSync(path).size;
		const busyWindow = this.config.busyWindowMs ?? 120_000;
		if (Date.now() - statSync(path).mtimeMs > busyWindow) return size;
		const TAIL = 256 * 1024;
		const start = Math.max(0, size - TAIL);
		const fd = openSync(path, "r");
		try {
			const buffer = Buffer.allocUnsafe(size - start);
			const read = readSync(fd, buffer, 0, buffer.length, start);
			const text = buffer.toString("utf8", 0, read);
			const lines = text.split("\n");
			// Byte offset of each line's first character within the window.
			const offsets = [];
			let cursor = 0;
			for (const line of lines) {
				offsets.push(cursor);
				cursor += line.length + 1;
			}
			for (let index = lines.length - 1; index >= 0; index--) {
				if (!lines[index].trim()) continue;
				let record;
				try {
					record = JSON.parse(lines[index]);
				} catch {
					continue;
				}
				if (record?.type === "message" && record.message?.role === "assistant" && record.message?.timestamp !== undefined) {
					return start + offsets[index];
				}
			}
		} catch {
			/* unreadable tail: fall through to the end */
		} finally {
			closeSync(fd);
		}
		return size;
	}

	/**
	 * Find the transcript this pane appends to.
	 *
	 * A freshly started TUI has written nothing yet, so the bucket holds no file
	 * until its first turn lands. Retry on each poll until one appears; once
	 * found, tail from the current end (the desk's history is not re-emitted).
	 */
	#resolveTranscript() {
		if (this.transcriptPath && existsSync(this.transcriptPath)) return;
		const newest = newestTranscript(this.config, this.cwd);
		if (!newest?.path) return;
		this.transcriptPath = newest.path;
		this.offset = statSync(newest.path).size;
		log.info(`attach ${this.id} resolved transcript ${newest.path}`);
	}

	/** Follow the transcript and scrape the pane for open dialogs. */
	async #poll() {
		if (!this.transcriptPath) this.#resolveTranscript();
		else {
			// The pane may have rotated to a newer transcript since the last poll.
			const newest = newestTranscript(this.config, this.cwd);
			if (newest?.path) this.adoptTranscript(newest.path);
		}
		const pane = await this.capture();
		if (pane === null && !(await this.alive())) {
			log.info(`attach ${this.id}: tmux session '${this.tmuxSession}' is gone`);
			this.paneGone = true;
			this.stop();
			return;
		}
		await this.#tailTranscript();
		await this.#scrapeDialog(pane);
	}

	async #tailTranscript() {
		if (!this.transcriptPath || !existsSync(this.transcriptPath)) return;
		const size = statSync(this.transcriptPath).size;
		if (size <= this.offset) {
			if (size < this.offset) this.offset = size; // truncated/rotated
			return;
		}
		const fd = openSync(this.transcriptPath, "r");
		try {
			const length = size - this.offset;
			const buffer = Buffer.allocUnsafe(length);
			readSync(fd, buffer, 0, length, this.offset);
			this.offset = size;
			const text = buffer.toString("utf8");
			const lines = text.split("\n");
			// Keep the trailing partial line for the next pass.
			const complete = lines.slice(0, -1).filter(line => line.trim());
			for (const line of complete) {
				try {
					this.#handleRecord(JSON.parse(line));
				} catch {
					/* a record the bridge cannot parse is not fatal for the tail */
				}
			}
		} catch (error) {
			log.warn(`tail failed: ${error.message}`);
		} finally {
			closeSync(fd);
		}
	}

	#handleRecord(record) {
		if (record?.type !== "message") return;
		const role = record.message?.role;
		const content = record.message?.content;
		this.lastActivity = Date.now();
		// A trailing assistant record means the desk turn finished; without this
		// the row would read "busy" forever after the first answered dialog.
		if (role === "assistant" && this.state !== "idle") {
			this.state = "idle";
			emit(this.id, statusFrame(this.id, "idle", this.provider));
		}
		if (role === "assistant") {
			// Dedupe on the record's own identity, not on its text: two turns can
			// legitimately say the same thing, and a transcript can be re-read
			// after a target swap. Message timestamps are unique per transcript.
			const stamp = record.message?.timestamp;
			if (stamp !== undefined) {
				if (this.seenAssistant.has(stamp)) return;
				this.seenAssistant.add(stamp);
				if (this.seenAssistant.size > 4096) {
					const oldest = this.seenAssistant.values().next().value;
					this.seenAssistant.delete(oldest);
				}
			}
			const text = Array.isArray(content)
				? content
						.filter(block => block?.type === "text" && block.text)
						.map(block => block.text)
						.join("\n")
						.trim()
				: "";
			if (!text) return;
			for (const out of textCommitFrames(this.id, forDisplay(text), { provider: this.provider })) {
				emit(this.id, out);
			}
		}
	}

	/** Emit a question/permission frame when a dialog box is open on the pane. */
	async #scrapeDialog(pane) {
		if (pane === null) return;
		const dialog = readDialogFromPane(pane);
		const signature = dialog ? `${dialog.kind}:${dialog.toolName}:${dialog.prompt}` : "";
		if (signature === this.lastDialogSignature) return;
		if (!dialog) {
			this.lastDialogSignature = "";
			// The box closed (answered at the desk, or timed out): the session is
			// no longer waiting on the wearer, so stop reporting `awaiting`.
			if (this.state === "awaiting") {
				this.state = "idle";
				emit(this.id, statusFrame(this.id, "idle", this.provider));
			}
			return;
		}
		this.lastDialogSignature = signature;
		this.state = "awaiting";
		if (dialog.kind === "permission") {
			emit(this.id, {
				type: "permission_request",
				toolName: dialog.toolName,
				description: dialog.body.replace(/\n/g, " ").slice(0, 200),
				detail: dialog.body,
				toolUseId: `attach-${this.id}`,
				options: [
					{ text: "Yes", key: "allow" },
					{ text: "No", key: "deny" },
				],
				suggestions: null,
				sessionId: this.id,
			});
		} else {
			emit(
				this.id,
				questionFrame(
					this.id,
					[
						{
							question: dialog.prompt,
							header: "",
							options: dialog.options.map(option => ({ label: option.label })),
						},
					],
					`attach-${this.id}`,
				),
			);
		}
		emit(this.id, statusFrame(this.id, "awaiting", this.provider));
	}

	async send(keys, { literal = false, enter = true } = {}) {
		// `-l` makes EVERY following argument literal text, so a trailing `Enter`
		// would be typed into the composer instead of submitting. Literal text and
		// the Enter key therefore go in separate invocations.
		try {
			if (literal) await run("tmux", ["send-keys", "-t", this.tmuxSession, "-l", keys], { timeout: 5000 });
			else await run("tmux", ["send-keys", "-t", this.tmuxSession, keys], { timeout: 5000 });
			if (enter) await run("tmux", ["send-keys", "-t", this.tmuxSession, "Enter"], { timeout: 5000 });
			return true;
		} catch (error) {
			log.warn(`send-keys failed for ${this.tmuxSession}: ${error.message}`);
			return false;
		}
	}

	async capture() {
		try {
			const { stdout } = await run("tmux", ["capture-pane", "-p", "-t", this.tmuxSession], { timeout: 5000 });
			return stdout;
		} catch {
			// null distinguishes "tmux could not read the pane" from a genuinely
			// empty one; the poll uses it to detect a vanished session.
			return null;
		}
	}

	async prompt(text) {
		emit(this.id, userPromptFrame(this.id, forDisplay(text, { maxLines: 6 })));
		this.title = this.title || text.slice(0, 64);
		const sent = await this.send(text, { literal: true, enter: true });
		if (!sent) {
			// The pane is gone; say so instead of returning 202 to a prompt that
			// nobody will ever read.
			const error = new Error(`tmux session '${this.tmuxSession}' is no longer available`);
			error.statusCode = 503;
			throw error;
		}
		this.state = "busy";
		emit(this.id, statusFrame(this.id, "busy", this.provider));
	}

	async answerPermission(decision) {
		const pane = await this.capture();
		const dialog = readDialogFromPane(pane);
		if (!dialog) return false;
		const approved = decision === "allow" || decision === "allowAlways";
		// The menu opens on Approve; Deny sits one row below.
		if (!approved && !(await this.send("Down", { enter: false }))) return false;
		if (!(await this.send("Enter", { enter: false }))) return false;
		this.lastDialogSignature = "";
		this.state = "busy";
		emit(this.id, statusFrame(this.id, "busy", this.provider));
		return true;
	}

	async answerQuestion(rawAnswer) {
		const pane = await this.capture();
		const dialog = readDialogFromPane(pane);
		if (!dialog) return false;
		// A dictated answer can name an option by label ("Blue") or by number
		// ("two" → 2). Both are promised by the README; resolve the label first
		// and fall back to the digit.
		const text = String(rawAnswer ?? "").trim();
		const options = dialog.options ?? [];
		let index = options.findIndex(option => option.label.toLowerCase() === text.toLowerCase());
		if (index < 0) {
			const numeric = Number.parseInt(text.replace(/[^0-9]/g, ""), 10);
			if (Number.isInteger(numeric) && numeric >= 1 && numeric <= options.length) index = numeric - 1;
		}
		if (index < 0) return false;
		for (let step = 0; step < index; step++) {
			if (!(await this.send("Down", { enter: false }))) return false;
		}
		if (!(await this.send("Enter", { enter: false }))) return false;
		this.lastDialogSignature = "";
		this.state = "busy";
		emit(this.id, statusFrame(this.id, "busy", this.provider));
		return true;
	}

	async interrupt() {
		await this.send("Escape", { enter: false });
	}

	/** The pane vanished (tmux session ended); the attachment is dead. */
	async alive() {
		try {
			await run("tmux", ["has-session", "-t", this.tmuxSession], { timeout: 5000 });
			return true;
		} catch {
			return false;
		}
	}

	stop() {
		clearInterval(this.timer);
		this.timer = null;
	}

	kill() {
		this.stop();
	}
}

/**
 * Parse an open dialog box out of a captured pane.
 *
 * Two shapes are recognised on the pane (both verified live): an approval box
 * headed `Allow tool: <name>` with an Approve/Deny list, and omp's numbered
 * option rows used by `ask`.
 */
export function readDialogFromPane(pane) {
	const lines = String(pane ?? "").split("\n");
	let boxStart = -1;
	for (let index = lines.length - 1; index >= 0; index--) {
		if (/^[╭┌]─*\s*Allow tool[: ]/.test(lines[index].trim())) {
			boxStart = index;
			break;
		}
	}
	if (boxStart >= 0) {
		const body = [];
		for (let index = boxStart + 1; index < lines.length; index++) {
			if (/^[╰└]/.test(lines[index].trim())) break;
			body.push(lines[index].replace(/^[│|]\s?/, "").replace(/\s?[│|]$/, "").trimEnd());
		}
		const toolName = lines[boxStart]
			.trim()
			.replace(/^[╭┌]─*\s*/, "")
			.replace(/\s*─*[╮┐]$/, "")
			.replace(/^Allow tool:\s*/, "");
		return { kind: "permission", toolName, body: body.join("\n"), prompt: toolName, options: [] };
	}

	// `ask` renders options as numbered rows under a question line. Require two
	// numbered rows, or one when the question carries the TUI's own `? ` prompt
	// prefix — that prefix is emitted only by the dialog, so ordinary prose that
	// happens to precede a numbered list still cannot read as an open question.
	const questionLine = findAskQuestion(lines);
	if (questionLine >= 0) {
		const options = [];
		for (let index = questionLine + 1; index < lines.length && options.length < 12; index++) {
			const match = lines[index].trim().match(/^(\d+)[.)]\s+(.+)$/);
			if (!match) break;
			options.push({ label: match[2].trim() });
		}
		const prompt = lines[questionLine].trim().replace(/^[?❯]\s*/, "");
		const dialogPrompt = /^[?❯]\s/.test(lines[questionLine].trim());
		if (options.length >= 2 || (options.length === 1 && dialogPrompt)) {
			return {
				kind: "question",
				toolName: "ask",
				body: "",
				prompt,
				options,
			};
		}
	}
	return null;
}

function findAskQuestion(lines) {
	for (let index = lines.length - 1; index >= 1; index--) {
		const line = lines[index].trim();
		if (!/^\d+[.)]\s+/.test(line)) continue;
		// The option run must start here; walk to its head to find the question.
		if (/^\d+[.)]\s+/.test(lines[index - 1]?.trim() ?? "")) continue;
		const question = lines[index - 1]?.trim() ?? "";
		if (!question) continue;
		return index - 1;
	}
	return -1;
}

/** Every tmux pane currently hosting an interactive omp TUI. */
export async function listTmuxOmpSessions(config) {
	let panes;
	try {
		const { stdout } = await run(
			"tmux",
			["list-panes", "-a", "-F", "#{session_name}\t#{pane_current_path}\t#{pane_current_command}"],
			{ timeout: 5000 },
		);
		panes = stdout
			.split("\n")
			.filter(Boolean)
			.map(line => {
				const [session, cwd, command] = line.split("\t");
				return { session, cwd, command };
			});
	} catch {
		return [];
	}
	const out = [];
	for (const pane of panes) {
		if (!/^omp/.test(pane.command ?? "")) continue;
		const transcript = newestTranscript(config, pane.cwd);
		out.push({
			// Stable identity for a pane: the tmux session name. It exists before
			// the TUI has written any transcript, so the id never shifts under a
			// client that already subscribed.
			id: `tmux:${pane.session}`,
			title: pane.session,
			cwd: pane.cwd,
			timestamp: transcript ? new Date(transcript.modified).toISOString() : new Date().toISOString(),
			provider: config.providerLabel,
			status: "idle",
			attach: { tmuxSession: pane.session, transcriptPath: transcript?.path ?? null },
		});
	}
	return out;
}

function newestTranscript(config, cwd) {
	const dir = `${config.sessionsRoot}/${sessionDirName(cwd)}`;
	if (!existsSync(dir)) return null;
	let best = null;
	for (const name of readdirSync(dir)) {
		if (!name.endsWith(".jsonl")) continue;
		const path = `${dir}/${name}`;
		try {
			const stat = statSync(path);
			if (!best || stat.mtimeMs >= best.modified) best = { path, modified: stat.mtimeMs };
		} catch {
			/* raced away */
		}
	}
	if (!best) return null;
	const session = findOmpSession(config, best.path);
	return { ...best, sessionId: session?.sessionId ?? null };
}
