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
		this.pending = null;
		this.timer = null;
		this.lastDialogSignature = "";
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
		await this.#tailTranscript();
		await this.#scrapeDialog();
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
			for (const line of complete) this.#handleRecord(JSON.parse(line));
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
		if (role === "assistant") {
			const text = Array.isArray(content)
				? content
						.filter(block => block?.type === "text" && block.text)
						.map(block => block.text)
						.join("\n")
						.trim()
				: "";
			if (!text || text === this.lastAssistantText) return;
			this.lastAssistantText = text;
			for (const out of textCommitFrames(this.id, forDisplay(text), { provider: this.provider })) {
				emit(this.id, out);
			}
		}
	}

	/** Emit a question/permission frame when a dialog box is open on the pane. */
	async #scrapeDialog() {
		const pane = await this.capture();
		const dialog = readDialogFromPane(pane);
		const signature = dialog ? `${dialog.kind}:${dialog.toolName}:${dialog.prompt}` : "";
		if (signature === this.lastDialogSignature) return;
		if (!dialog) {
			this.lastDialogSignature = "";
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
			return "";
		}
	}

	async prompt(text) {
		emit(this.id, userPromptFrame(this.id, forDisplay(text, { maxLines: 6 })));
		this.title = this.title || text.slice(0, 64);
		await this.send(text, { literal: true, enter: true });
	}

	async answerPermission(decision) {
		const pane = await this.capture();
		const dialog = readDialogFromPane(pane);
		if (!dialog) return false;
		const approved = decision === "allow" || decision === "allowAlways";
		// The menu opens on Approve; Deny sits one row below.
		if (!approved) await this.send("Down", { enter: false });
		await this.send("Enter", { enter: false });
		this.lastDialogSignature = "";
		this.state = "busy";
		emit(this.id, statusFrame(this.id, "busy", this.provider));
		return true;
	}

	async answerQuestion(rawAnswer) {
		const pane = await this.capture();
		const dialog = readDialogFromPane(pane);
		if (!dialog) return false;
		// Numbered voice pick: "2" selects the second option row.
		const index = Number.parseInt(String(rawAnswer).replace(/[^0-9]/g, ""), 10);
		if (Number.isInteger(index) && index >= 1) {
			for (let step = 1; step < index; step++) await this.send("Down", { enter: false });
		}
		await this.send("Enter", { enter: false });
		this.lastDialogSignature = "";
		this.state = "busy";
		emit(this.id, statusFrame(this.id, "busy", this.provider));
		return true;
	}

	async interrupt() {
		await this.send("Escape", { enter: false });
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

	// `ask` renders options as numbered rows after a question line.
	const questionLine = findAskQuestion(lines);
	if (questionLine >= 0) {
		const options = [];
		for (let index = questionLine + 1; index < lines.length; index++) {
			const match = lines[index].trim().match(/^(\d+)[.)]\s+(.+)$/);
			if (!match) break;
			options.push({ label: match[2].trim() });
		}
		if (options.length > 0) {
			return {
				kind: "question",
				toolName: "ask",
				body: "",
				prompt: lines[questionLine].trim().replace(/^[?❯]\s*/, ""),
				options,
			};
		}
	}
	return null;
}

function findAskQuestion(lines) {
	for (let index = lines.length - 1; index >= 0; index--) {
		const line = lines[index].trim();
		if (!line) continue;
		if (/^\d+[.)]\s+/.test(lines[index + 1]?.trim() ?? "") && /\?\s*$/.test(line)) return index;
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
