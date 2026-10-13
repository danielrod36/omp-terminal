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
 * Most bytes of an unterminated trailing transcript line to keep re-reading between polls.
 *
 * A trailing fragment is deliberately left unconsumed so a record still being flushed is not
 * dropped, but re-reading it costs I/O proportional to the LINE rather than to the new bytes.
 * The bound sits above the longest real line measured on this host (1 903 529 bytes across 354
 * transcripts), because a cap below it would discard legitimate records rather than merely
 * bound the re-read: the largest single-line records are tool results, which the wearer does
 * see. 4 MiB leaves headroom without letting an unterminated line re-read without bound.
 */
const MAX_CARRY_BYTES = 4 * 1024 * 1024;

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
		if (!this.transcriptPath) {
			// Resolution itself walks the filesystem (readdir, stat, open); any of
			// those can race a rotation. A throw here would escape before the timer
			// below is installed, leaving a registered session that never polls, so
			// it is contained — the first poll retries.
			try {
				this.#resolveTranscript();
			} catch (error) {
				log.warn(`attach ${this.id} transcript resolution failed: ${error.message}`);
			}
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
	/**
	 * True when `path` is not newer than the transcript we already follow.
	 *
	 * Both stats are guarded because either file can rotate away between the existsSync checks
	 * and the stat — a session being pruned, or a bucket being cleaned. Unguarded, that throws
	 * out of the prompt path and the wearer's prompt is dropped for a 500 that also carries the
	 * absolute transcript path. Every other rotation probe in this file is guarded the same way.
	 */
	#isOlderThan(path) {
		try {
			if (!existsSync(this.transcriptPath)) return false;
			return statSync(this.transcriptPath).mtimeMs > statSync(path).mtimeMs;
		} catch {
			// A stat that cannot complete means the question cannot be answered; treat the file as
			// not-older so the caller proceeds to #resumeOffset, which guards its own read.
			return false;
		}
	}

	adoptTranscript(path) {
		if (!path || path === this.transcriptPath) return;
		if (!existsSync(path)) return;
		// Only adopt a file this pane could be writing: same bucket as the cwd,
		// and newer than what we are currently following.
		if (!path.startsWith(`${this.config.sessionsRoot}/${sessionDirName(this.cwd)}/`)) return;
		if (this.transcriptPath && this.#isOlderThan(path)) return;
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
				// Only the bytes belonging to complete records are consumed. A trailing fragment
				// stays unread so the next poll re-reads it whole: advancing past it would drop the
				// record once the writer finishes it, which is exactly what a half-flushed line
				// looks like. But a transcript line can be very long (measured maximum on this host:
				// 1.9 MB), and re-reading it every poll costs I/O proportional to the LINE rather
				// than to the new bytes. Past the cap the fragment is given up as unparseable
				// rather than re-read forever — it cannot be a record boundary we owe the wearer.
				if (carry.length > MAX_CARRY_BYTES) {
					// Give up the fragment rather than re-read it forever. It is a real record being
					// flushed, so say so: the wearer loses that turn's output and the log is the only
					// place it would show.
					log.warn(`transcript line exceeds ${MAX_CARRY_BYTES} bytes; dropping it`);
					carry = Buffer.alloc(0);
				}
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
			// Both roles mean the agent is still working. If a quiet gap already
			// reported `idle`, resuming must restore `busy` — otherwise the lens
			// shows a finished turn while the transcript is still growing.
			if (this.state !== "busy" && this.state !== "awaiting") {
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
		// `awaiting` is set per-branch, AFTER the announce is known to be possible: reporting the
		// wearer as waiting on a dialog that was never announced (an unreadable permission card)
		// leaves the app armed for an answer nobody will be asked for.
		if (dialog.kind === "permission") {
			// A card whose rows could not be read has nothing truthful to announce. Its rows are
			// real on the desk — only the bar has not painted — so announcing the stock pair would
			// name words that are not on the card, the mismatch this whole path exists to avoid.
			// The signature above is already recorded, so the card re-announces with its own rows
			// as soon as the bar paints and the parse finds them.
			//
			// The test is `!== 2`, not `=== 0`: a mid-repaint capture can yield exactly ONE focused
			// row (the partial-render branch), and indexing `options[1]` there threw a TypeError
			// into the poll's catch — after the signature was stored, so the card could not
			// re-announce until the second row happened to paint.
			if (dialog.options.length !== 2) {
				log.info(`attach ${this.id} permission card shows ${dialog.options.length} row(s); announcing nothing`);
				return;
			}
			this.state = "awaiting";
			// `key` is the decision the app posts back; `text` is what the wearer reads. Mirror the
			// card's own vocabulary: announcing words the desk does not show makes the wearer answer
			// a question they cannot see. Labels are passed through verbatim, so a card saying
			// `Allow`/`Cancel` is announced as such rather than as the stock pair.
			emit(this.id, {
				type: "permission_request",
				toolName: dialog.toolName,
				description: dialog.body.replace(/\n/g, " ").slice(0, 200),
				detail: dialog.body,
				toolUseId: `attach-${this.id}`,
				options: [
					{ text: dialog.options[0].label, key: "allow" },
					{ text: dialog.options[1].label, key: "deny" },
				],
				suggestions: null,
				sessionId: this.id,
			});
		} else {
			this.state = "awaiting";
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
		// A refusal is reported as `{ ok: false, reason }`, never a bare `false`: the caller has to
		// tell "no permission is pending" (nothing to answer) from "the card is there but was not
		// understood" (answer at the desk), and a single boolean flattened both into one 400.
		if (!dialog || dialog.kind !== "permission") return { ok: false, reason: "no permission card is on screen" };
		const approved = decision === "allow" || decision === "allowAlways";
		// Find the row by label: the desk user may have moved the cursor, so the
		// menu is not guaranteed to open on Approve.
		const options = dialog.options ?? [];
		// An unknown focus makes the cursor delta meaningless: sending Enter would submit whatever
		// row the desk has highlighted, which need not be the one the wearer named.
		if (options.length === 0) {
			log.warn(`attach ${this.id} found no answerable rows on the permission card; refusing`);
			return { ok: false, reason: "the card's rows are not in a shape this bridge recognises" };
		}
		if (!Number.isInteger(dialog.focusedIndex) || dialog.focusedIndex < 0) {
			log.warn(`attach ${this.id} does not know which permission row is focused; refusing`);
			return { ok: false, reason: "the card does not show which row is selected" };
		}
		const target = options.findIndex(option => (approved ? /^(Approve|Yes)$/i : /^(Deny|No)$/i).test(option.label));
		// No matching row means the card was not understood — a parse that found no options, or a
		// menu whose labels we do not know. Pressing Enter then submits whatever the cursor happens
		// to sit on, so a dictated "allow" can land on Deny. Refuse instead: the wearer retries and
		// nothing is approved by accident.
		if (target < 0) {
			log.warn(`attach ${this.id} could not find an ${approved ? "approve" : "deny"} row; refusing to press Enter`);
			return { ok: false, reason: `the card does not offer a row matching ${approved ? "approve" : "deny"}` };
		}
		// No `?? 0` here: the guard above already rejects anything that is not a non-negative
		// integer, so a fallback would be unreachable — and an unreachable default is what let the
		// focus bug hide in the first place.
		const steps = target - dialog.focusedIndex;
		if (!(await this.#moveCursor(steps))) return { ok: false, reason: "the cursor could not be moved to the selected row" };
		if (!(await this.send("Enter", { enter: false }))) return { ok: false, reason: "the key could not be delivered to the desk" };
		return this.#answered();
	}

	async answerQuestion(rawAnswer) {
		const pane = await this.capture();
		const dialog = readDialogFromPane(pane);
		// Same contract as `answerPermission`: `{ ok, reason }`, never a bare boolean, so the route
		// can tell "nothing is pending" from "the card is there but the answer failed" — the
		// distinction the permission route already reports.
		if (!dialog || dialog.kind !== "question") return { ok: false, reason: "no question card is on screen" };
		const options = dialog.options ?? [];
		// The app names an answer three ways and cannot know whether this session is owned or
		// attached, so both paths accept the same shapes. A keyed object maps the question to its
		// answer, and `parseQuestionAnswer` looks the key up by question text, by question id, and
		// by the question's index — with the value possibly an ARRAY for a multi-select. Handling
		// only the prompt and index zero silently dropped the rest, and stringifying an array
		// produced `"Green,Blue"`, which matches no label.
		//
		// A question dialog's `toolName` is the constant `"ask"`, not an id, so it is NOT a key
		// worth trying: no client can know it as a question's name, and the scraped pane carries
		// no id to match. `keyed[0]` and `keyed["0"]` are one property slot, since a numeric key
		// is coerced to a string.
		const keyed = rawAnswer && typeof rawAnswer === "object" && !Array.isArray(rawAnswer) ? rawAnswer : null;
		const picks = keyed
			? [keyed[dialog.prompt], keyed[0]].find(hit => hit !== undefined && hit !== null)
			: rawAnswer;
		const values = (Array.isArray(picks) ? picks : [picks]).filter(item => item !== undefined && item !== null && item !== "");
		if (values.length === 0) return { ok: false, reason: "the answer was empty" };
		// An attached dialog can only be driven one row at a time, so every named option must be
		// honoured — silently acting on the first would leave a multi-select half answered.
		const wanted = [];
		for (const value of values) {
			// A dictated answer names an option by label ("Blue") or by number ("two" → 2),
			// relative to the option rows as rendered.
			const index = resolveRequestedIndex(String(value).trim(), options);
			if (index < 0) return { ok: false, reason: `the card offers no row matching ${JSON.stringify(String(value).trim())}` };
			if (!wanted.includes(index)) wanted.push(index);
		}
		// Naming several rows on a SINGLE-select card means at least one of them was misdictated,
		// so it is refused like any other ambiguous dictation rather than silently taking the
		// first — the desk would otherwise submit a row the wearer never settled on.
		if (!dialog.multi) {
			if (wanted.length !== 1) return { ok: false, reason: "more than one row was named for a single-select card" };
			return this.#selectSingle(dialog, wanted[0]);
		}
		return this.#toggleMulti(dialog, wanted);
	}

	/** Single-select: move the highlight to the row, then submit. */
	async #selectSingle(dialog, wanted) {
		const steps = wanted - dialog.focusedIndex;
		if (!(await this.#moveCursor(steps))) return { ok: false, reason: "the cursor could not be moved to the selected row" };
		if (!(await this.send("Enter", { enter: false }))) return { ok: false, reason: "the key could not be delivered to the desk" };
		return this.#answered();
	}

	/**
	 * Multi-select: `Down` moves the highlight and `Space` toggles the row under
	 * it (verified live), so each requested row is visited, toggled, and the
	 * dialog submitted with `Enter`. The cursor returns to its start row so the
	 * sequence is independent of any prior state.
	 */
	async #toggleMulti(dialog, wantedRows) {
		// A row may be visited out of order, so the cursor position is tracked here rather than
		// read from `dialog.focusedIndex` — that is a snapshot taken before any of these moves, and
		// subtracting it from every target sent the cursor to the wrong row from the second move
		// on (rows [1,2] moved +1 then +2, landing on row 3).
		let cursor = dialog.focusedIndex;
		for (const wanted of wantedRows) {
			if (!(await this.#moveCursor(wanted - cursor))) return { ok: false, reason: "the cursor could not be moved to the selected row" };
			cursor = wanted;
			// `Space` toggles, so sending it to a row that is already checked would silently
			// uncheck the desk user's selection.
			const alreadyChecked = (dialog.checked ?? []).includes(wanted);
			if (!alreadyChecked && !(await this.send("Space", { enter: false }))) return { ok: false, reason: "the key could not be delivered to the desk" };
		}
		if (!(await this.#moveCursor(dialog.focusedIndex - cursor))) return { ok: false, reason: "the cursor could not be returned to the desk's row" };
		if (!(await this.send("Enter", { enter: false }))) return { ok: false, reason: "the key could not be delivered to the desk" };
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
		return { ok: true };
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
		// Read the card in two passes. Its body can contain anything — a command, a diff, a file
		// preview — so a row is only a CHOICE when it sits in the run of rows directly above the
		// key-hint bar. Scoring every line for `Approve|Deny|Yes|No` (the previous shape) turned
		// any body line reading `Yes` or `No` into an option: the list was inflated, the focus
		// index shifted, and `answerPermission` then moved the cursor onto the phantom row and
		// submitted THAT instead of Approve/Deny.
		//
		// Measured card (omp 18.8.9):
		//   │ Command: echo HELLO-PERM │
		//   │                        │
		//   │  \uf054 Approve            │
		//   │    Deny                 │
		//   │                        │
		//   │ ↑/↓ navigate  \uf11c select  \uf1c5 cancel │
		const body = [];
		for (let index = boxStart + 1; index < lines.length; index++) {
			const trimmed = lines[index].trim();
			if (/^[╰└]/.test(trimmed)) break;
			body.push(trimmed.replace(/^[│|]\s?/, "").replace(/\s?[│|]$/, "").trimEnd());
		}
		const looksLikeHint = content => /\bnavigate\b|\bselect\b|\bcancel\b|\btoggle\b|\bsubmit\b/.test(content);
		// Locate the MENU first: the longest run of choice rows in the card. Anchoring on the choices
		// rather than on the first keyword is what keeps a body mention harmless (a shell command, a
		// diff), and taking the whole run is what survives a hint bar that WRAPS: the bar's first
		// fragment may carry no keyword at all, so a scan keyed to the bar alone would stop above
		// the real choices and empty the option list — the card then answered blind.
		let menuEnd = -1;
		let menuStart = -1;
		let best = -1;
		for (let index = 0; index < body.length; index++) {
			if (!CHOICE_ROW.exec(body[index])) continue;
			let end = index;
			while (end + 1 < body.length && CHOICE_ROW.exec(body[end + 1])) end++;
			// Rank runs by vocabulary, then by length, then by position. `Approve`/`Deny` IS the
			// permission menu's own vocabulary while `Yes`/`No` is what a body line looks like, so a
			// canonical run wins even when a body pair is longer or sits higher — measured: a
			// three-row `No`/`Yes`/`No` body run above the menu wins on length alone under a
			// length-only score, and the card is then announced as the body pair with focus -1,
			// unanswerable. Position only breaks a full tie (same rank, same length), where the
			// BOTTOM-most run wins because the menu sits at the end of the card.
			// Canonical means the run CONTAINS an adjacent Approve/Deny pair, not merely that it
			// starts and ends with those words. Testing only the ends let a body `Yes` that happened
			// to touch the menu join the real pair into a three-row run — `Yes, Approve, Deny` — which
			// then read as non-canonical, lost to a bare `Yes`/`No` body run above it, and the card was
			// announced with the body's words and focus -1 (unanswerable).
			const labels = [];
			for (let row = index; row <= end; row++) labels.push(CHOICE_ROW.exec(body[row])[2]);
			const hasApproval = labels.some((label, at) => label === "Approve" && labels[at + 1] === "Deny");
			const endsYesNo = labels[0] === "Yes" && labels[labels.length - 1] === "No";
			const rank = hasApproval ? 2 : endsYesNo ? 1 : 0;
			const score = rank * 1000 + (end - index + 1);
			if (score >= best) {
				best = score;
				menuStart = index;
				menuEnd = end;
			}
			index = end;
		}
		// Walk down from the menu to the hint bar, so a wrapped bar's later fragment is still
		// reachable even though its first one carries no keyword. The bar's position is not needed
		// to build the rows — they come from the menu run itself — so only the fact that one exists
		// matters here.
		let hasHintBar = false;
		for (let after = menuEnd + 1; after < body.length; after++) {
			if (!body[after]) continue;
			if (looksLikeHint(body[after])) {
				hasHintBar = true;
				break;
			}
		}
		// Build the rows from the menu run itself, skipping the blank rows the card may leave
		// between the run and the bar (measured: one blank line).
		const choices = [];
		let focusRow = -1;
		// The bar is required, not merely present: a card mid-repaint can show the rows while the
		// frame below them has not painted yet, and answering that partial card would submit a row
		// the wearer has not finished reading. Requiring the bar makes such a card unanswerable
		// instead, which the answer path turns into a refusal.
		if (menuEnd >= 0 && hasHintBar) {
			const rows = [];
			for (let index = menuEnd; index >= menuStart; index--) {
				const choice = body[index].match(CHOICE_ROW);
				if (!choice) continue;
				rows.unshift({ label: choice[2], focused: /[\uf054\u276f\u25b6]/.test(choice[1]) });
			}
			// A permission card offers one positive and one negative row, so the run must END in a
			// pair: {Approve, Deny} or {Yes, No}. Taking the trailing pair rather than requiring the
			// whole run to be exactly two rows is what keeps a body line reading `Yes` that happens
			// to sit directly above the choices from joining them — the misfire this branch exists to
			// prevent — while still leaving the card answerable in that case.
			// Prefer the card's OWN vocabulary. `Approve`/`Deny` IS the permission menu — verified
			// live on 18.8.9 — while `Yes`/`No` is what a body line looks like (a command, a diff, a
			// preview). A body pair sitting nearest the hint bar therefore used to displace the real
			// menu, and a dictated "allow" then pressed `Yes`, a different row. The Approve/Deny pair
			// wins wherever it sits; Yes/No is only a fallback for a card that offers it.
			const pairAt = (() => {
				const pairs = [];
				for (let index = 0; index < rows.length - 1; index++) {
					const [a, b] = [rows[index].label, rows[index + 1].label];
					if ((a === "Approve" && b === "Deny") || (a === "Yes" && b === "No")) pairs.push({ index, canonical: a === "Approve" });
				}
				if (pairs.length === 0) return -1;
				const canonical = pairs.filter(pair => pair.canonical);
				// Among equals take the LAST pair, because the choices sit directly above the bar at
				// the bottom of the card.
				return (canonical.length > 0 ? canonical : pairs)[(canonical.length > 0 ? canonical : pairs).length - 1].index;
			})();
			if (pairAt >= 0) {
				// Exactly the pair, not everything above it: a body row that is itself a choice word
				// must not ride along and shift the focus index.
				for (let index = pairAt; index < pairAt + 2; index++) {
					if (rows[index].focused) focusRow = index - pairAt;
					choices.push(rows[index].label);
				}
			} else if (rows.length === 1) {
				// A partial render: a single row still answers, but only if it is FOCUSED — inventing
				// focusRow = 0 for an unfocused row would let a dictated deny submit Approve.
				if (rows[0].focused) {
					focusRow = 0;
					choices.push(rows[0].label);
				}
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
			// Report the focus we actually saw. Defaulting to 0 fabricated one: with no focused row
			// the cursor delta came out 0, no key was sent, and Enter submitted whichever row the
			// desk cursor happened to be on — the wearer says "allow" and cannot tell which row it
			// hit. `-1` says "unknown", which answerPermission refuses on.
			focusedIndex: focusRow,
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
	// Multi-select signals, most reliable first:
	//  1. the key-hint bar — ASCII, so it does not depend on the font. It says `toggle` for
	//     multi-select and `select` for single, and docs/PROTOCOL.md §2 already calls it the
	//     authoritative signal. Measured on all twelve live captures: the hint and the marker
	//     glyph agree every time (select+circle, toggle+square), so leading with the hint
	//     changes nothing on real dialogs while surviving a font that renders a different glyph.
	//  2. the option marker glyph — square (U+F096) multi, circle (U+F10C) single, verified by a
	//     controlled A/B on one host. Used when the hint bar is absent or says neither word.
	//  3. any row rendered as a checked box (more than one);
	//  4. the header's `Submit` affordance — the FIRST line of a two-line header (`<id> Submit`
	//     above the question). Last, because a multi-QUESTION dialog renders that tab bar while
	//     each question is independently single- or multi-select, so it is the weakest claim.
	const hintMulti = /\btoggle\b/.test(box.help) ? true : /\bselect\b/.test(box.help) ? false : null;
	const glyphMulti = box.markerGlyph === "\uf096" ? true : box.markerGlyph === "\uf10c" ? false : null;
	// The tab-bar `Submit` is the WEAKEST signal: a multi-QUESTION dialog renders that bar while
	// each question is independently single- or multi-select, so it is evidence about the FORM,
	// not the question. It is consulted only when neither the hint bar nor the marker glyph could
	// decide (an unknown font with no hint line) — a case absent from all twelve live captures,
	// which use only the known markers and carry a hint bar. Requiring a checked row to
	// corroborate would not help: an alternate font's checked glyph is unnameable, so `checked`
	// is always empty there and the card would be needlessly unreadable.
	const headerSubmit = box.header.length >= 2 && /\bSubmit\s*$/.test(box.header[0]);
	// The checked fallback requires MORE THAN ONE checked row: a single checked row is the
	// wearer's cursor resting on a selected option in either mode, so it must not promote a
	// single-select dialog to the multi path (where a dictated answer to an unchecked row is
	// dropped). A multi dialog with no hint and an unknown font has nothing better than the tab
	// bar, so that is the last resort.
	const multi =
		hintMulti ??
		glyphMulti ??
		(box.options.filter(option => option.checked).length > 1 || headerSubmit);
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
		//   │ <question id>  <Submit>        ← header (multi only)
		//   │ <question text>                ← header
		//   ├─…─┤                           ← rule 1: options begin
		//   │ <focus> <marker> <label>       ← one row per option
		//   ├─…─┤                           ← rule 2: options end
		//   │ <key hints>
		//   ╰─…─╯
		// Sections are delimited by the rules themselves rather than inferred from
		// content: a header line that happens to start with a private-use glyph can
		// then never be mistaken for an option, and the option block cannot be
		// "closed early" by one.
		const box = { header: [], options: [], checked: new Set(), focusRow: -1, help: "", framedRows: 0 };
		let rules = 0;
		// The marker offset shared by the block's option rows. Every live capture
		// puts the marker at one fixed offset regardless of focus, so a framed row
		// whose marker sits elsewhere (a wrapped question line, a note row) is not
		// an option. Without this a stray PUA-led row becomes a phantom option and
		// shifts focusRow, so navigation toggles a different physical row.
		const candidates = [];
		for (let index = start + 1; index < lines.length; index++) {
			const trimmed = lines[index].trim();
			if (/^[╰└]/.test(trimmed)) break;
			const framed = /^[│|]/.test(trimmed);
			if (framed) box.framedRows++;
			if (/^[├┝]/.test(trimmed)) {
				rules++;
				continue;
			}
			const content = framed
				? trimmed.replace(/^[│|]\s?/, "").replace(/\s?[│|]$/, "").trimEnd()
				: trimmed;
			if (!content.trim()) continue;
			// After the closing rule: key hints only, never an option row.
			if (rules >= 2) {
				if (/\b(toggle|select|submit|mark)\b/.test(content)) box.help = content;
				continue;
			}
			// Before the opening rule: the header (question id + question text).
			if (rules === 0) {
				box.header.push(content.trim());
				continue;
			}
			// Between the rules: the option rows. The row keeps its leading
			// whitespace because the focus column is whitespace-delimited.
			const row = framed ? splitOptionRow(content) : null;
			// Every private-use-marker row inside the option block is a candidate; the vote
			// below decides which glyph is the dialog's marker. Admitting them all here (and
			// filtering there) is what lets an alternate font's glyph win when the whole
			// dialog uses it, while a stray still cannot outvote known option markers.
			if (row && row.label && isMarker(row.marker)) candidates.push({ ...row, known: MARKER_GLYPHS.has(row.marker) });
		}
		// Select the real option rows by MARKER GLYPH, not by alignment.
		//
		// The marker glyph is a deterministic function of the dialog MODE, verified by
		// a controlled A/B on one host seconds apart: a single-select dialog renders
		// U+F10C (circle) and a multi-select one renders U+F096 (square), with U+F14A
		// for a checked box. It is constant across a dialog's rows, while the marker's
		// column moves with the focus glyph and the terminal padding — so an
		// offset-based rule fails in both directions (it drops a real option whose
		// column shifted, and keeps a stray row indented like the options).
		//
		// The focused row is always kept: it is an option by definition, and dropping it
		// would leave focusRow at -1 and make the live dialog unanswerable.
		// Count the empty markers and the checked ones separately. A checked row is a
		// SELECTED option, not a different kind of row, and it is the focused row
		// whenever the wearer's cursor sits on it — so seeding the tie with the focused
		// row's glyph would make a checked box the block's marker and trim every
		// unchecked sibling that shares the dialog's real (empty) glyph.
		// Whether the block renders ANY known marker decides which glyphs may vote. When it
		// does the font is one we know, and every other private-use glyph is a stray that
		// must not be able to outvote the real rows (that would drop them and shift
		// focusRow, and with it every dictated index). When it does not, the dialog uses an
		// alternate icon set and there is no known glyph to compare against, so the vote
		// runs over whatever markers it renders.
		const knownFont = candidates.some(candidate => candidate.known);
		const focusedRow = candidates.find(candidate => candidate.focus);
		// Count the EMPTY markers. A checked row never votes: its glyph is not the block's
		// empty marker, and letting a checked FOCUSED row vote would make the checked box
		// the marker and trim every unchecked sibling. The focused row otherwise DOES vote
		// — it is an option by definition, so its empty glyph is authoritative for the
		// dialog's mode. In a known font an unknown glyph is a stray and never votes.
		const emptyVotes = new Map();
		for (const candidate of candidates) {
			if (candidate.marker === CHECKED_GLYPH) continue;
			if (knownFont && !candidate.known) continue;
			emptyVotes.set(candidate.marker, (emptyVotes.get(candidate.marker) ?? 0) + 1);
		}
		// The marker is a constant function of the dialog's mode, so a glyph shared by the
		// siblings is evidence of it — but only a STRICT lead is. On a tie nothing
		// distinguishes a stray from a sibling, and `Map` iteration order must not decide.
		let modalGlyph = null;
		let modalGlyphCount = 0;
		let tied = false;
		for (const [glyph, count] of emptyVotes) {
			if (count > modalGlyphCount) {
				modalGlyph = glyph;
				modalGlyphCount = count;
				tied = false;
			} else if (count === modalGlyphCount) {
				tied = true;
			}
		}
		if (tied) modalGlyph = null;
		// Two cases adopt the focused row's own glyph. (1) No evidence at all (every row
		// checked, or a single row): the dialog would otherwise have no marker, so fall back
		// to the focused row's glyph to keep it answerable. (2) A tie in a KNOWN font: the
		// focused row is an option by definition, so its empty glyph is the mode's marker and
		// a row differing from it is a provable stray. A tie in an ALTERNATE font does not
		// adopt — its checked-variant glyph cannot be named, so a differing row could be a
		// real checked sibling, and dropping one loses the option outright.
		const focusedUsable = focusedRow !== undefined && focusedRow.marker !== CHECKED_GLYPH && (!knownFont || focusedRow.known);
		if (modalGlyph === null && focusedUsable && (emptyVotes.size === 0 || knownFont)) {
			modalGlyph = focusedRow.marker;
		}
		// `modalGlyph` stays null when a known font checks every row (no empty marker
		// exists): the mode then comes from the header or hint fallbacks, and the checks
		// below keep each known row on its own merits.
		// A checked row renders U+F14A where an unchecked one renders U+F096/U+F10C, so
		// the checked glyph is a variant of the same marker rather than a different one.
		const sameMarker = (glyph, reference) =>
			glyph === reference || (glyph === CHECKED_GLYPH && reference !== CHECKED_GLYPH);
		// In a known font every marker can be named, so a row whose glyph is unknown or
		// differs from the marker is a stray and is dropped. In an alternate icon set the
		// checked variant cannot be named, so a differing row may be a real checked sibling:
		// keeping a phantom row costs a mis-dictated index, while dropping a real one loses
		// the option outright and shifts every later index, which is the worse failure.
		const family = (glyph) => !knownFont || modalGlyph === null || sameMarker(glyph, modalGlyph);
		// Only a known font lets the mode be read from the glyph; an alternate icon set's
		// marker is unknown to us, so the mode comes from the header or hint fallbacks.
		box.markerGlyph = knownFont ? modalGlyph : null;
		for (const row of candidates) {
			// Keep the focused row unconditionally: it is an option by definition, and
			// dropping it would leave focusRow at -1 and the dialog unanswerable. Every other
			// row is kept only when it belongs to the block's marker family — an unknown glyph
			// in a known font, or a differing glyph anywhere, marks a stray whose presence
			// would inflate the option list and shift every dictated index.
			if (!row.focus && knownFont && !row.known) continue;
			if (!row.focus && !family(row.marker)) continue;
			// The `Other (type your own)` row is the free-text affordance, not one of
			// the offered options.
			if (/^Other \(type your own\)$/.test(row.label)) continue;
			// A checked row renders U+F14A where an unchecked one renders U+F096
			// (measured live: toggling a row with Space swaps those two).
			const checkedMarker = row.marker === "\uf14a";
			if (checkedMarker) box.checked.add(box.options.length);
			if (row.focus) box.focusRow = box.options.length;
			box.options.push({ label: row.label, checked: checkedMarker });
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
 * The marker identifies the dialog's option rows and its mode. Verified by a
 * controlled A/B on one host, seconds apart, same omp build and pane width:
 *   U+F10C  empty circle  — single-select
 *   U+F096  empty square  — multi-select
 *   U+F14A  checked box   — a selected row in either mode
 * Every marker is a Nerd Font private-use glyph and the focus glyph is always
 * U+F054. Geometric shapes and dingbats are NOT markers on this wire, so accepting
 * them would let a label like `★ Starred` read as a marker row; only the
 * private-use area is admitted as a candidate, which the vote then narrows.
 */
const MARKER_GLYPHS = new Set(["\uf10c", "\uf096", "\uf14a"]);
/** The checked variant, which replaces the empty marker once a row is selected. */
const CHECKED_GLYPH = "\uf14a";
/**
 * A permission menu row: an optional focus glyph, then nothing but a positive or negative label.
 *
 * One definition because five sites match it — the run scan that locates the menu (its first
 * line, its continuation, and the labels at either end) and the row build that reads it — and they
 * must agree on what a choice row is.
 */
const CHOICE_ROW = /^([\uf054\u276f\u25b6\s]*)(Approve|Deny|Yes|No)\s*$/;

function isMarker(glyph) {
	if (!glyph) return false;
	if (MARKER_GLYPHS.has(glyph)) return true;
	// Any other private-use glyph is tolerated as a marker so a font build with a
	// different icon set still parses; the glyph vote below then decides whether it
	// belongs to this dialog's option rows.
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
	const tokens = lowered.split(/[^a-z0-9]+/).filter(Boolean);
	// 1. The dictation IS a label (including a label like "Option 2").
	const byLabel = options.findIndex(option => option.label.toLowerCase() === lowered);
	if (byLabel >= 0) return byLabel;
	// 2. A label match on TOKENS, checked before any bare number. The dictation's
	// tokens must occur as a CONTIGUOUS RUN inside the label's tokens, anywhere:
	// a version-style dictation ("1.1" for `HTTP/1.1`, "2" for `HTTP/2`) is a
	// substring of the label, not a prefix of it. Checking this before the number
	// path is what stops "http 2" from being read as row 2.
	//
	// This run-matching is also what lets a wearer answer by what they SEE: omp
	// renders a recommended option as `Yes (Recommended)`, and the tokenizer treats
	// the parenthetical as separate tokens, so the dictation "yes" matches the
	// `["yes", "recommended"]` run. The suffix is display chrome, never part of
	// what the wearer says.
	//
	// The length gate applies only to a SINGLE short token: "s"/"ow" is a
	// misrecognition and must not auto-submit, but a multi-token dictation
	// ("ai agents", "osi model") is specific enough whatever the first token's
	// length.
	const specific = tokens.length >= 2 || (tokens[0]?.length ?? 0) >= 3;
	const partials = [];
	if (specific) {
		options.forEach((option, index) => {
			const labelTokens = option.label.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
			const hit = labelTokens.some((_, offset) =>
				tokens.every((token, position) => labelTokens[offset + position]?.startsWith(token)),
			);
			if (hit) partials.push(index);
		});
	}
	if (partials.length === 1) return partials[0];
	// An AMBIGUOUS label match must not fall through to the number path: the
	// dictation named label text, so reinterpreting its digits as a row index would
	// silently submit an option it never matched ("http 2" among `HTTP/2` and
	// `HTTP/2 (restated)` must refuse, not Enter row 2). Refuse instead.
	if (partials.length > 1) return -1;
	// 3. A bare number token ("2", "two", "option 2"). Reached only when the
	// dictation matched no label at all, so a numeric label reference cannot be
	// mistaken for a row index.
	// Ordinals count too. Without them "the second one" carried a single numeric token — the
	// `one` of `second one` — resolved to row 1, and Enter was pressed on the wrong row. With
	// both words present the text holds two numeric tokens and is refused as ambiguous, which is
	// what an ordinal-plus-cardinal mix is.
	const words = {
		one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
		first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
	};
	// A digit ordinal (`2nd`, `3rd`) counts as its cardinal: left alone it matched neither the
	// digit test nor the word map, so "the 2nd one" carried exactly one numeric token — the `one`
	// — and submitted row 1, the same wrong-row failure the spelled ordinals had.
	const numericTokens = tokens
		.map(token => token.replace(/^(\d+)(?:st|nd|rd|th)$/, "$1"))
		.filter(token => /^\d+$/.test(token) || token in words);
	if (numericTokens.length === 1) {
		const numeric = /^\d+$/.test(numericTokens[0]) ? Number(numericTokens[0]) : words[numericTokens[0]];
		if (numeric >= 1 && numeric <= options.length) return numeric - 1;
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
	let names;
	try {
		names = readdirSync(dir);
	} catch {
		// The bucket can be removed or replaced between the check and the read.
		return null;
	}
	let best = null;
	for (const name of names) {
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
