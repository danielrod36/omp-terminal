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
		this.settleTimer = null;
		this.lastDialogSignature = "";
		/** Assistant record timestamps already painted, so a re-read never duplicates. */
		this.seenAssistant = new Set();
	}

	async start() {
		// A caller-supplied transcript starts at its end: the desk's history is
		// not the bridge's to re-emit, and leaving `offset` at 0 would replay all
		// of it to the lens on the first poll. When no path exists yet, resolution
		// finds one and the same rule applies.
		//
		// Every filesystem probe here is guarded: the file can be rotated away
		// between `existsSync` and `statSync`, and a throw would escape before the
		// poll timer is installed, leaving a session registered in
		// `attachRegistry` that never polls again. Clearing the path lets the
		// first poll re-resolve it.
		if (this.transcriptPath) {
			try {
				if (!existsSync(this.transcriptPath)) {
					this.transcriptPath = null;
				} else if (this.offset === 0) {
					this.offset = statSync(this.transcriptPath).size;
				}
			} catch {
				this.transcriptPath = null;
			}
		}
		if (!this.transcriptPath) this.#resolveTranscript();
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
		// Resolve the new offset BEFORE committing the path: a file rotating away
		// between the two would otherwise leave the new path with the old offset.
		let offset;
		try {
			offset = this.#resumeOffset(path);
		} catch {
			return;
		}
		log.info(`attach ${this.id} adopted transcript ${path}`);
		this.transcriptPath = path;
		this.offset = offset;
	}

	/**
	 * Where to start reading an adopted transcript.
	 *
	 * Normally the end (past history). If its newest assistant record is within
	 * the busy window, start at that record so a turn that completed before the
	 * swap is not lost.
	 *
	 * Offsets are computed on the raw Buffer, not on a JS string: string indices
	 * are UTF-16 code units, and a transcript containing non-ASCII would rewind
	 * mid-line and drop the very record this exists to preserve.
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
			const slice = buffer.subarray(0, read);
			const newline = 0x0a;
			// Forward scan over bytes: record each line's byte offset, then take
			// the LAST assistant record in the window. When the window starts
			// mid-line its first fragment is not a parseable record and is skipped.
			let lastAssistant = -1;
			let lineStart = 0;
			const at = offset => {
				if (offset <= lineStart) return;
				let record;
				try {
					record = JSON.parse(slice.toString("utf8", lineStart, offset));
				} catch {
					return;
				}
				if (record?.type === "message" && record.message?.role === "assistant" && record.message?.timestamp !== undefined) {
					lastAssistant = lineStart;
				}
			};
			for (let index = 0; index < slice.length; index++) {
				if (slice[index] !== newline) continue;
				at(index);
				lineStart = index + 1;
			}
			if (lastAssistant >= 0) return start + lastAssistant;
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
		try {
			this.offset = statSync(newest.path).size;
			this.transcriptPath = newest.path;
		} catch {
			// Rotated away between the listing and the probe; retry next poll.
			return;
		}
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
		let size;
		try {
			size = statSync(this.transcriptPath).size;
		} catch {
			// Rotated between the existence check and the probe; the next poll
			// re-resolves.
			return;
		}
		if (size <= this.offset) {
			if (size < this.offset) this.offset = size; // truncated/rotated
			return;
		}
		// Read in bounded chunks and split on newline BYTES: decoding a chunk that
		// ends mid-multibyte-character corrupts the record straddling the
		// boundary, so only complete records are decoded. The residue is carried
		// to the next read rather than being parsed.
		const CHUNK = 256 * 1024;
		const newline = 0x0a;
		const fd = openSync(this.transcriptPath, "r");
		try {
			let cursor = this.offset;
			let carry = Buffer.alloc(0);
			while (cursor < size) {
				const length = Math.min(CHUNK, size - cursor);
				const buffer = Buffer.allocUnsafe(length);
				const read = readSync(fd, buffer, 0, length, cursor);
				if (read <= 0) break;
				cursor += read;
				const combined = carry.length > 0 ? Buffer.concat([carry, buffer.subarray(0, read)]) : buffer.subarray(0, read);
				let lineStart = 0;
				for (;;) {
					const breakAt = combined.indexOf(newline, lineStart);
					if (breakAt < 0) break;
					if (breakAt > lineStart) this.#handleLine(combined.toString("utf8", lineStart, breakAt));
					lineStart = breakAt + 1;
				}
				carry = lineStart < combined.length ? Buffer.from(combined.subarray(lineStart)) : Buffer.alloc(0);
				// Only the bytes belonging to complete records are consumed. A
				// trailing fragment stays unread so the next poll re-reads it whole:
				// advancing past it would drop the record once the writer finishes
				// it, which is exactly what a half-flushed line looks like.
				this.offset = cursor - carry.length;
			}
		} catch (error) {
			log.warn(`tail failed: ${error.message}`);
		} finally {
			closeSync(fd);
		}
	}

	/** Parse and dispatch one complete transcript record. */
	#handleLine(line) {
		if (!line.trim()) return;
		try {
			this.#handleRecord(JSON.parse(line));
		} catch {
			/* a record the bridge cannot parse is not fatal for the tail */
		}
	}

	/**
	 * Report `idle` when the transcript shows the turn really ended.
	 *
	 * An assistant record can be followed by more tool results, so the settle
	 * signal is its absence: after an assistant message, the next user record
	 * (a new turn) or a quiet transcript within the busy window means the desk
	 * agent stopped. Tracking this on the record stream keeps the lens from
	 * flipping to idle in the middle of a multi-step turn.
	 */
	#noteSettled() {
		clearTimeout(this.settleTimer);
		const settlesAt = Date.now();
		this.settleTimer = setTimeout(() => {
			this.settleTimer = null;
			// A dialog on the pane has its own lifecycle (#scrapeDialog owns the
			// awaiting → idle transition); do not race it.
			if (this.lastDialogSignature) return;
			// Only settle if nothing has been written since this timer was armed:
			// a follow-up record means the turn is still running.
			if (this.lastActivity > settlesAt) return;
			if (this.state === "busy" || this.state === "awaiting") {
				this.state = "idle";
				emit(this.id, statusFrame(this.id, "idle", this.provider));
			}
		}, Math.max(1000, (this.config.tailIntervalMs ?? 500) * 4));
		this.settleTimer.unref?.();
	}

	#handleRecord(record) {
		if (record?.type !== "message") return;
		const role = record.message?.role;
		const content = record.message?.content;
		this.lastActivity = Date.now();
		if (role === "user" || role === "toolResult") {
			// A new turn or in-flight work: not settled yet, but the transcript can
			// also END on one of these (the agent answered inside a tool result, or
			// the TUI stopped mid-step). Arm the settle timer rather than only
			// cancelling, or the session strands in `busy` with nothing to clear it.
			this.#noteSettled();
			if (role === "user" && this.state !== "busy" && this.state !== "awaiting") {
				this.state = "busy";
				emit(this.id, statusFrame(this.id, "busy", this.provider));
			}
			return;
		}
		if (role === "assistant") {
			this.#noteSettled();
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
		// The signature includes the option set and multi flag: a dialog that
		// changes shape in place (an option appearing, a single turning multi) is
		// a different dialog and must be re-announced.
		const signature = dialog
			? `${dialog.kind}:${dialog.toolName}:${dialog.prompt}:${dialog.multi ? "multi" : "single"}:${dialog.options.map(option => option.label).join("|")}`
			: "";
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
							// The app arms its multi-select UI from this flag; the
							// dialog's own key-hint bar is what identifies it.
							multi: dialog.multi === true,
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
		if (!dialog || dialog.kind !== "permission") return false;
		const approved = decision === "allow" || decision === "allowAlways";
		// Find the row by label: the desk user may have moved the cursor, so the
		// menu is not guaranteed to open on Approve.
		const options = dialog.options ?? [];
		const target = options.findIndex(option => (approved ? /^(Approve|Yes)$/i : /^(Deny|No)$/i).test(option.label));
		const steps = (target >= 0 ? target : approved ? 0 : 1) - (dialog.focusedIndex ?? 0);
		if (!(await this.#moveCursor(steps))) return false;
		if (!(await this.send("Enter", { enter: false }))) return false;
		return this.#answered();
	}

	async answerQuestion(rawAnswer) {
		const pane = await this.capture();
		const dialog = readDialogFromPane(pane);
		if (!dialog || dialog.kind !== "question") return false;
		// A dictated answer names an option by label ("Blue") or by number
		// ("two" → 2), relative to the option rows as rendered.
		const text = String(rawAnswer ?? "").trim();
		const options = dialog.options ?? [];
		const wanted = resolveRequestedIndex(text, options);
		if (wanted < 0) return false;
		if (dialog.multi) return this.#toggleMulti(dialog, wanted);
		return this.#selectSingle(dialog, wanted);
	}

	/** Single-select: move the highlight to the row, then submit. */
	async #selectSingle(dialog, wanted) {
		const steps = wanted - dialog.focusedIndex;
		if (!(await this.#moveCursor(steps))) return false;
		if (!(await this.send("Enter", { enter: false }))) return false;
		return this.#answered();
	}

	/**
	 * Multi-select: `Down` moves the highlight and `Space` toggles the row under
	 * it (verified live), so each requested row is visited, toggled, and the
	 * dialog submitted with `Enter`. The cursor returns to its start row so the
	 * sequence is independent of any prior state.
	 */
	async #toggleMulti(dialog, wanted) {
		let cursor = dialog.focusedIndex;
		if (!(await this.#moveCursor(wanted - cursor))) return false;
		cursor = wanted;
		// `Space` toggles, so sending it to a row that is already checked would
		// silently uncheck the desk user's selection.
		const alreadyChecked = (dialog.checked ?? []).includes(wanted);
		if (!alreadyChecked && !(await this.send("Space", { enter: false }))) return false;
		if (cursor !== dialog.focusedIndex && !(await this.#moveCursor(dialog.focusedIndex - cursor))) return false;
		if (!(await this.send("Enter", { enter: false }))) return false;
		return this.#answered();
	}

	/** Move the dialog highlight by `steps` rows (negative = up). */
	async #moveCursor(steps) {
		const key = steps > 0 ? "Down" : "Up";
		for (let step = 0; step < Math.abs(steps); step++) {
			if (!(await this.send(key, { enter: false }))) return false;
		}
		return true;
	}

	#answered() {
		// A timer armed by an earlier assistant record would fire shortly after
		// this answer and report `idle` while the agent is still working.
		clearTimeout(this.settleTimer);
		this.settleTimer = null;
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
		clearTimeout(this.settleTimer);
		this.settleTimer = null;
	}

	kill() {
		this.stop();
	}
}

/**
 * Parse an open dialog box out of a captured pane.
 *
 * Two shapes are recognised, both verified live against omp 18.8.9:
 *  - an approval box headed `Allow tool: <name>` with an Approve/Deny list;
 *  - omp's `ask` dialog: a `╭─ Ask …` box whose option rows render as
 *    `<focus> <marker> <label>`, the focus marker (`\uf054`) identifying the
 *    highlighted row.
 *
 * The numeric-row heuristic this replaces matched no real omp rendering: `ask`
 * paints a boxed list whose option marker is a private-use glyph, and `select`
 * dialogs are consumed by the RPC UI context, so no dialog ever produced
 * numbered option rows.
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
		const choices = [];
		let focusRow = -1;
		let rowIndex = -1;
		for (let index = boxStart + 1; index < lines.length; index++) {
			const trimmed = lines[index].trim();
			if (/^[╰└]/.test(trimmed)) break;
			const content = trimmed.replace(/^[│|]\s?/, "").replace(/\s?[│|]$/, "").trimEnd();
			body.push(content);
			// The choice rows carry the focus marker (verified live on 18.8.9):
			// `\uf054 Approve` / `   Deny`.
			const choice = content.match(/^([\uf054\u276f\u25b6\s]*)(Approve|Deny|Yes|No)\s*$/);
			if (choice) {
				rowIndex++;
				if (choice[1].includes("\uf054") || choice[1].includes("\u276f") || choice[1].includes("\u25b6")) focusRow = rowIndex;
				choices.push(choice[2]);
			}
		}
		const toolName = lines[boxStart]
			.trim()
			.replace(/^[╭┌]─*\s*/, "")
			.replace(/\s*─*[╮┐]$/, "")
			.replace(/^Allow tool:\s*/, "");
		return {
			kind: "permission",
			toolName,
			body: body.join("\n"),
			prompt: toolName,
			focusedIndex: focusRow >= 0 ? focusRow : 0,
			options: choices.map(label => ({ label })),
		};
	}
	return readAskFromPane(lines);
}

/** The `Ask` dialog box, if one is open at the bottom of the pane. */
function readAskFromPane(lines) {
	const boxes = readAskBoxes(lines);
	if (boxes.length === 0) return null;
	// Prefer the bottom-most candidate: the composer dialog is painted at the
	// bottom, transcript echoes above it.
	const box = boxes[boxes.length - 1];
	// A live dialog is framed and carries a focus marker on one option row. The
	// transcript echo (`╭─── Ask 1 questions ─…`, borderless option glyphs, no
	// focus marker) and a dialog that has already closed are rejected here
	// rather than answered blind.
	if (box.options.length === 0 || box.focusRow < 0 || box.framedRows === 0) return null;
	const prompt = box.header.length > 0 ? box.header[box.header.length - 1] : "";
	const multi = /\btoggle\b/.test(box.help) || box.options.filter(option => option.checked).length > 1;
	return {
		kind: "question",
		toolName: "ask",
		body: "",
		prompt,
		multi,
		focusedIndex: box.focusRow,
		checked: [...box.checked],
		options: box.options.map(option => ({ label: option.label })),
	};
}

/**
 * Parse every `Ask` box in the pane: its header lines, option rows, focus
 * marker, key-hint bar, and whether its rows were framed by `│` borders. The
 * caller decides which box (if any) is a live dialog.
 */
function readAskBoxes(lines) {
	const boxes = [];
	for (let start = 0; start < lines.length; start++) {
		if (!/^[╭┌][─\s]*(?:\S+\s+)?Ask\b/.test(lines[start].trim())) continue;
		// Layout (verified live on 18.8.9):
		//   ╭─── Ask ──…╮
		//   │ <question text>                ← header/question
		//   ├─…─┤                           ← rule before the option rows
		//   │ <focus> <marker> <label>       ← one row per option
		//   ├─…─┤
		//   │ <key hints>
		//   ╰─…─╯
		const box = { header: [], options: [], checked: new Set(), focusRow: -1, help: "", framedRows: 0 };
		let rowIndex = -1;
		for (let index = start + 1; index < lines.length; index++) {
			const trimmed = lines[index].trim();
			if (/^[╰└]/.test(trimmed)) break;
			const framed = /^[│|]/.test(trimmed);
			if (framed) box.framedRows++;
			// The row keeps its leading whitespace: the focus column is
			// whitespace-delimited, so trimming here would erase the focus marker
			// before it can be read. Only the trailing border and padding go.
			const content = framed
				? trimmed.replace(/^[│|]\s?/, "").replace(/\s?[│|]$/, "").trimEnd()
				: trimmed;
			if (!content.trim() || /^[├┝]/.test(trimmed)) continue;
			// An option row: an optional focus glyph, then the marker glyph, then
			// the label. Parsing by structure (`focus? marker label`) rather than by
			// "a glyph the label cannot start with" keeps labels that themselves
			// begin with a glyph (`● Low quality`) intact. When the character after
			// the marker is itself a glyph it is part of the label, because the
			// marker is exactly one character wide.
			const row = framed ? splitOptionRow(content) : null;
			if (row && row.label && isMarker(row.marker)) {
				const label = row.label;
				// The `Other (type your own)` row is the free-text affordance, not
				// one of the offered options.
				if (/^Other \(type your own\)$/.test(label)) continue;
				// A checked row renders U+F14A where an unchecked one renders
				// U+F096 (measured live: toggling a row with Space swaps those two).
				const checkedMarker = row.marker === "\uf14a";
				if (checkedMarker) box.checked.add(box.options.length);
				rowIndex++;
				if (row.focus) box.focusRow = rowIndex;
				box.options.push({ label, checked: checkedMarker });
				continue;
			}
			if (box.options.length === 0) box.header.push(content);
			// The key-hint bar names the interaction: multi-select says `toggle`,
			// single-select says `select`. The marker glyph alone cannot tell them
			// apart (both render U+F096 when unchecked).
			else if (/\b(toggle|select|submit)\b/.test(content)) box.help = content;
		}
		boxes.push(box);
	}
	return boxes;
}

/**
 * Split one option row into focus / marker / label.
 *
 * The row is `<focus glyph>? <marker glyph> <label>`. Whitespace is not a
 * reliable focus signal: omp trims the leading padding, so a focused row can
 * begin at column 0 while an unfocused one starts with spaces — and which of
 * those happens depends on the terminal width, not on the state. The focus
 * glyph set is therefore what decides, and the marker is the next character
 * after it. A label that itself begins with a glyph is preserved because only
 * the single marker character is consumed.
 */
function splitOptionRow(content) {
	const text = content.replace(/^\s+/, "");
	if (!text) return null;
	const focused = FOCUS.test(text[0]) ? text[0] : null;
	const afterFocus = focused ? text.slice(1).replace(/^\s+/, "") : text;
	if (!afterFocus) return null;
	return { focus: focused, marker: afterFocus[0], label: afterFocus.slice(1).trim() };
}

const FOCUS = /[\uf054\u276f\u25b6]/;

/**
 * True for the glyphs omp uses as option markers.
 *
 * Measured across three live captures (single-select, multi-select, approval):
 * every marker is a Nerd Font private-use glyph — U+F096 and U+F10C observed —
 * while the focus glyph is always U+F054. Geometric shapes and dingbats are NOT
 * markers on this wire, so accepting them risked reading a label like `★ Starred`
 * as a marker row; only the private-use area is treated as a marker.
 */
function isMarker(glyph) {
	if (!glyph) return false;
	const code = glyph.codePointAt(0);
	return code >= 0xe000 && code <= 0xf8ff;
}

/** Resolve a dictated answer to an option index.
 *
 * Ordered by confidence: exact label, then a number named anywhere in the
 * dictation ("2", "two", "option 2", "number two"), then a unique word-boundary
 * partial label. An ambiguous or too-short partial resolves to nothing rather
 * than guessing — answering the wrong option is worse than declining.
 */
function resolveRequestedIndex(text, options) {
	if (!text) return -1;
	const lowered = text.toLowerCase().trim();
	if (!lowered) return -1;
	// 1. The dictation IS a label (including a label like "Option 2").
	const byLabel = options.findIndex(option => option.label.toLowerCase() === lowered);
	if (byLabel >= 0) return byLabel;
	// 2. A number token anywhere in the dictation, 1-based. The pre-PR code
	// stripped every non-digit, so "option 2" resolved; bare-word dictations
	// ("two") must keep working too.
	const digits = lowered.match(/\d+/);
	const words = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
	const wordMatch = lowered.split(/[^a-z]+/).find(token => token in words);
	const numeric = digits ? Number(digits[0]) : wordMatch ? words[wordMatch] : NaN;
	if (Number.isInteger(numeric) && numeric >= 1 && numeric <= options.length) return numeric - 1;
	// 3. A unique partial label, but only on a word boundary and long enough to
	// be meaningful: a two-character misrecognition must not silently answer.
	if (lowered.length >= 3) {
		const partials = [];
		options.forEach((option, index) => {
			const label = option.label.toLowerCase();
			if (label.startsWith(lowered) || label.split(/[^a-z0-9]+/).some(token => token.startsWith(lowered))) {
				partials.push(index);
			}
		});
		if (partials.length === 1) return partials[0];
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
