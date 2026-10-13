/**
 * Frame constructors for the Even G2 firmware.
 *
 * The firmware understands a fixed, small set of SSE frame types and silently
 * drops anything else. Assistant text renders ONLY as a `text_delta` stream
 * bracketed by `status:text_start` / `status:text_end`, and the persisted
 * on-screen answer is committed from the `result` frame that follows — the
 * delta alone flashes and clears. Every status frame must carry `sessionId`,
 * and `text_delta` ships bare (no `ts`, no icon). See docs/PROTOCOL.md.
 *
 * Every function here is a pure constructor; the session drives emission.
 */

/** The four-part paint-and-persist sequence for one assistant answer. */
export function textCommitFrames(sessionId, text, { provider, usage, success = true } = {}) {
	return [
		{ type: "status", state: "text_start", sessionId },
		{ type: "text_delta", text },
		{ type: "status", state: "text_end", sessionId },
		{
			type: "result",
			success,
			text,
			sessionId,
			provider,
			costUsd: usage?.costUsd ?? 0,
			turns: usage?.turns ?? 0,
			durationMs: usage?.durationMs ?? 0,
			inputTokens: usage?.inputTokens ?? 0,
			outputTokens: usage?.outputTokens ?? 0,
		},
	];
}

export function statusFrame(sessionId, state, provider) {
	return { type: "status", state, sessionId, ...(provider ? { provider } : {}) };
}

export function userPromptFrame(sessionId, text) {
	return { type: "user_prompt", text, sessionId };
}

/**
 * Question frame. The Even App arms its native question UI off `user_question`
 * alone; without it the wearer sees option text but the App still believes a
 * turn is in flight, so answering requires quitting the wait first.
 */
export function questionFrame(sessionId, questions, toolUseId) {
	return {
		type: "user_question",
		questions: questions.map(question => ({
			question: String(question.question ?? ""),
			header: String(question.header ?? ""),
			multiSelect: question.multi === true,
			options: (question.options ?? []).map(option => ({
				label: String(option.label ?? ""),
				description: String(option.description ?? ""),
				preview: String(option.preview ?? ""),
			})),
		})),
		toolUseId: toolUseId ?? `omp-${sessionId}`,
		sessionId,
	};
}

export function questionAnswerFrame(sessionId, answers) {
	return { type: "question_answer", answers, sessionId };
}

/** Permission prompt with the stock option keys: allow / allowAlways / deny. */
export function permissionRequestFrame(sessionId, { toolName, description, detail, toolUseId, allowAlways = false, labels }) {
	// `key` is the decision the app posts back; `text` is what the wearer reads. The stock server
	// pairs Claude Code's `Yes`/`No` labels with these keys, but omp's approval card says
	// `Approve`/`Deny` (it answers `select(<Allow tool: …>, ["Approve", "Deny"])` and tests
	// `value === "Approve"`). Announcing words the desk does not show makes the wearer answer a
	// question they cannot see, so the card's own labels are passed in.
	//
	// A caller with something OTHER than two real labels gets the stock pair: a one-element array
	// leaves `labels[1]` undefined, which would announce `{ text: undefined }`, and a longer one
	// would silently drop every option past the second.
	const pair = Array.isArray(labels) && labels.length === 2 && labels.every(label => typeof label === "string" && label.length > 0)
		? labels
		: ["Yes", "No"];
	const options = [{ text: pair[0], key: "allow" }];
	if (allowAlways) options.push({ text: `Yes, always allow this tool`, key: "allowAlways" });
	options.push({ text: pair[1], key: "deny" });
	return {
		type: "permission_request",
		toolName,
		description,
		detail,
		toolUseId,
		options,
		suggestions: null,
		sessionId,
	};
}

export function permissionResultFrame(sessionId, { toolName, summary, decision }) {
	return { type: "permission_result", toolName, summary, decision, sessionId };
}

export function toolStartFrame(sessionId, { name, toolId, summary }) {
	return { type: "tool_start", name, toolId, ...(summary ? { summary } : {}), sessionId };
}

export function toolEndFrame(sessionId, { name, toolId, summary }) {
	return { type: "tool_end", name, toolId, ...(summary ? { summary } : {}), sessionId };
}

export function taskProgressFrame(sessionId, { completed, total, current }) {
	return { type: "task_progress", completed, total, current, sessionId };
}

export function runningStatsFrame(sessionId, { durationMs, inputTokens, outputTokens }) {
	return { type: "running_stats", durationMs, inputTokens, outputTokens, sessionId };
}

export function errorFrame(sessionId, message) {
	return { type: "error", message, sessionId };
}

/**
 * Lens-safe truncation. The HUD renders about a dozen short lines; anything
 * longer is unreadable on the 576x288 monochrome canvas.
 */
export function forDisplay(text, { maxLines = 12, maxChars = 1600 } = {}) {
	const normalized = String(text ?? "").replace(/\r\n/g, "\n").trim();
	if (!normalized) return "";
	const lines = normalized.split("\n");
	const clipped = lines.length > maxLines ? lines.slice(0, maxLines) : lines;
	let out = clipped.join("\n");
	if (out.length > maxChars) out = out.slice(0, maxChars - 1) + "…";
	if (lines.length > maxLines) out += `\n… (+${lines.length - maxLines} lines)`;
	return out;
}
