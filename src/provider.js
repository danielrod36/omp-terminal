import { join } from "node:path";
import { OmpRpc } from "./omp-rpc.js";
import { createLogger } from "./log.js";
import {
	errorFrame,
	forDisplay,
	permissionRequestFrame,
	permissionResultFrame,
	questionAnswerFrame,
	questionFrame,
	runningStatsFrame,
	statusFrame,
	taskProgressFrame,
	textCommitFrames,
	toolEndFrame,
	toolStartFrame,
	userPromptFrame,
} from "./frames.js";
import { emit } from "./events.js";

const log = createLogger("provider");

const TOOL_SUMMARY = {
	read: args => `Read ${shortPath(args?.path)}`,
	write: args => `Write ${shortPath(args?.path)}`,
	edit: args => `Edit ${shortPath(args?.path)}`,
	bash: args => `Bash ${truncate(args?.command, 60)}`,
	grep: args => `Grep "${truncate(args?.pattern, 30)}"`,
	glob: args => `Glob ${truncate(args?.path ?? args?.pattern, 40)}`,
	task: args => `task ${truncate(args?.description ?? args?.prompt, 40)}`,
	web_search: args => `Search "${truncate(args?.query, 30)}"`,
	todo: args => `todo ${args?.op ?? ""}`.trim(),
};

function shortPath(value) {
	if (typeof value !== "string" || !value) return "";
	const parts = value.split("/");
	return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : value;
}

function truncate(value, max) {
	if (typeof value !== "string" || !value) return "";
	return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function summarizeTool(name, args) {
	const formatter = TOOL_SUMMARY[name];
	if (formatter) return formatter(args ?? {});
	return name;
}

function usageFrom(message) {
	const usage = message?.usage ?? {};
	return {
		inputTokens: (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0),
		outputTokens: usage.output ?? 0,
		costUsd: usage.cost?.total ?? 0,
		durationMs: message?.duration ?? 0,
	};
}

/**
 * One Even session backed by one owned `omp --mode rpc-ui` process.
 *
 * Emission contract (docs/PROTOCOL.md): assistant text is a
 * `status:text_start` → `text_delta` → `status:text_end` → `result` burst; the
 * `result` frame commits the persisted on-screen answer. Tool frames are kept
 * summarised so they cannot bury that answer.
 */
export class OwnedSession {
	constructor({ id, cwd, provider, config, ompArgs = [] }) {
		this.id = id;
		this.cwd = cwd;
		this.provider = provider;
		this.config = config;
		this.ompArgs = ompArgs;
		this.state = "idle";
		this.title = "";
		this.lastActivity = Date.now();
		this.lastAssistantText = "";
		this.pendingDialogs = new Map();
		this.statsTimer = null;
		this.turnStart = 0;
		this.turnUsage = { inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 0 };
		this.textBuffer = "";
	}

	async start() {
		this.rpc = new OmpRpc({
			command: this.config.ompCommand,
			args: [
				"--cwd",
				this.cwd,
				"--approval-mode",
				this.config.approvalMode,
				...this.ompArgs,
			],
			cwd: this.cwd,
		});
		this.rpc.on("frame", frame => this.#handleFrame(frame));
		this.rpc.on("exit", () => {
			this.state = "idle";
			this.#stopStats();
		});
		await this.rpc.start();
		// Own the canonical identity: omp mints its own session id, and the
		// transcript it appends to is keyed by it. Learning both here makes
		// history/resume work off the same id the app was told.
		try {
			const stats = await this.rpc.send({ type: "get_session_stats" });
			this.ompSessionId = stats?.sessionId ?? null;
			this.sessionFile = stats?.sessionFile ?? null;
		} catch (error) {
			log.warn(`get_session_stats failed: ${error.message}`);
		}
		// Opt into the rich ask dialog so `ask` questions arrive as one frame
		// instead of the select/editor fallback pair.
		await this.rpc.send({ type: "set_ask_dialog", enabled: true }).catch(error => {
			log.warn(`set_ask_dialog failed: ${error.message}`);
		});
		return this;
	}

	#handleFrame(frame) {
		this.lastActivity = Date.now();
		switch (frame.type) {
			case "agent_start":
				this.state = "busy";
				this.turnStart = Date.now();
				this.turnUsage = { inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 0 };
				emit(this.id, statusFrame(this.id, "busy", this.provider));
				this.#startStats();
				break;
			case "turn_end": {
				const usage = usageFrom(frame.message);
				this.turnUsage.inputTokens += usage.inputTokens;
				this.turnUsage.outputTokens += usage.outputTokens;
				this.turnUsage.costUsd += usage.costUsd;
				this.turnUsage.durationMs += usage.durationMs;
				break;
			}
			case "agent_end":
				this.#stopStats();
				break;
			case "session_settled":
				if (this.state !== "idle") {
					this.state = "idle";
					emit(this.id, statusFrame(this.id, "idle", this.provider));
				}
				break;
			case "message_update":
				this.#handleMessageUpdate(frame);
				break;
			case "tool_execution_start":
				this.#handleToolStart(frame);
				break;
			case "tool_execution_end":
				this.#handleToolEnd(frame);
				break;
			case "extension_ui_request":
				this.#handleDialog(frame);
				break;
			case "prompt_result":
				if (frame.status === "error" && frame.error?.message) {
					log.warn(`prompt error: ${frame.error.message}`);
					emit(this.id, errorFrame(this.id, forDisplay(frame.error.message, { maxLines: 4 })));
				}
				break;
			default:
				break;
		}
	}

	#handleMessageUpdate(frame) {
		const event = frame.assistantMessageEvent;
		if (!event) return;
		switch (event.type) {
			case "text_start":
				this.textBuffer = "";
				break;
			case "text_delta":
				this.textBuffer += event.delta ?? "";
				break;
			case "text_end": {
				const text = forDisplay(event.content ?? this.textBuffer);
				this.textBuffer = "";
				if (!text) break;
				this.lastAssistantText = text;
				for (const out of textCommitFrames(this.id, text, {
					provider: this.provider,
					usage: this.turnUsage,
				})) {
					emit(this.id, out);
				}
				break;
			}
			default:
				break;
		}
	}

	#handleToolStart(frame) {
		emit(
			this.id,
			toolStartFrame(this.id, {
				name: frame.toolName,
				toolId: frame.toolCallId,
				summary: summarizeTool(frame.toolName, frame.args),
			}),
		);
		if (frame.toolName === "todo") {
			const progress = todoProgress(frame.args);
			if (progress) emit(this.id, taskProgressFrame(this.id, progress));
		}
	}

	#handleToolEnd(frame) {
		emit(
			this.id,
			toolEndFrame(this.id, {
				name: frame.toolName,
				toolId: frame.toolCallId,
				summary: summarizeTool(frame.toolName, frame.args),
			}),
		);
	}

	#handleDialog(frame) {
		const { id, method } = frame;
		this.pendingDialogs.set(id, frame);
		if (method === "select") {
			const lines = String(frame.title ?? "").split("\n");
			const toolName = lines[0]?.replace(/^Allow tool:\s*/, "") ?? "tool";
			this.state = "awaiting";
			emit(
				this.id,
				permissionRequestFrame(this.id, {
					toolName,
					description: lines.slice(1).join(" ").trim(),
					detail: lines.slice(1).join("\n"),
					toolUseId: id,
				}),
			);
			emit(this.id, statusFrame(this.id, "awaiting", this.provider));
			return;
		}
		if (method === "ask") {
			this.state = "awaiting";
			emit(this.id, questionFrame(this.id, frame.questions ?? [], id));
			emit(this.id, statusFrame(this.id, "awaiting", this.provider));
			return;
		}
		if (method === "confirm") {
			this.state = "awaiting";
			emit(
				this.id,
				permissionRequestFrame(this.id, {
					toolName: "confirm",
					description: String(frame.message ?? ""),
					detail: String(frame.message ?? ""),
					toolUseId: id,
				}),
			);
			emit(this.id, statusFrame(this.id, "awaiting", this.provider));
			return;
		}
		if (method === "input" || method === "editor") {
			this.state = "awaiting";
			emit(this.id, questionFrame(this.id, [{ id, question: String(frame.title ?? ""), options: [] }], id));
			emit(this.id, statusFrame(this.id, "awaiting", this.provider));
			return;
		}
		// setWidget / setTitle / notify / setStatus / open_url are host chrome;
		// the lens has no surface for them.
	}

	#startStats() {
		this.#stopStats();
		this.statsTimer = setInterval(() => {
			if (this.state !== "busy") return;
			emit(
				this.id,
				runningStatsFrame(this.id, {
					durationMs: Date.now() - this.turnStart,
					inputTokens: this.turnUsage.inputTokens,
					outputTokens: this.turnUsage.outputTokens,
				}),
			);
		}, 10_000);
		this.statsTimer.unref?.();
	}

	#stopStats() {
		clearInterval(this.statsTimer);
		this.statsTimer = null;
	}

	async prompt(text) {
		emit(this.id, userPromptFrame(this.id, forDisplay(text, { maxLines: 6 })));
		if (!this.title) this.title = text.slice(0, 64);
		try {
			await this.rpc.send({ type: "prompt", message: text });
		} catch (error) {
			if (!/already processing/i.test(error.message)) throw error;
			// The agent is mid-turn: the stock app has no separate queue command,
			// so a prompt while busy becomes a queued follow-up.
			await this.rpc.send({ type: "follow_up", message: text });
		}
	}

	async answerPermission(decision) {
		const entry = [...this.pendingDialogs.entries()].find(
			([, frame]) => frame.method === "select" || frame.method === "confirm",
		);
		if (!entry) return false;
		const [id, frame] = entry;
		this.pendingDialogs.delete(id);
		const approved = decision === "allow" || decision === "allowAlways";
		if (frame.method === "select") this.rpc.respond(id, { value: approved ? "Approve" : "Deny" });
		else this.rpc.respond(id, { confirmed: approved });
		emit(
			this.id,
			permissionResultFrame(this.id, {
				toolName: String(frame.title ?? "tool").split("\n")[0],
				summary: decision,
				decision: approved ? "allowed" : "denied",
			}),
		);
		this.state = "busy";
		emit(this.id, statusFrame(this.id, "busy", this.provider));
		return true;
	}

	async answerQuestion(rawAnswer) {
		const entry = [...this.pendingDialogs.entries()].find(([, frame]) => frame.method === "ask");
		if (!entry) return false;
		const [id, frame] = entry;
		this.pendingDialogs.delete(id);
		const picked = parseQuestionAnswer(rawAnswer, frame.questions ?? []);
		this.rpc.respond(id, { answers: picked });
		emit(
			this.id,
			questionAnswerFrame(
				this.id,
				Object.fromEntries(picked.map(answer => [answer.id, answer.selectedOptions.join(", ")])),
			),
		);
		this.state = "busy";
		emit(this.id, statusFrame(this.id, "busy", this.provider));
		return true;
	}

	async interrupt() {
		await this.rpc.send({ type: "abort" });
	}

	kill() {
		this.#stopStats();
		this.rpc?.kill();
	}
}

/* ------------------------------------------------------------------ */
/* Answer parsing                                                      */
/* ------------------------------------------------------------------ */

/**
 * The Even App answers a question by POSTing a JSON object keyed by the
 * question text, a bare dictation string, or an option label/index. Extract
 * one selection set per question id, the shape `ask` expects.
 */
export function parseQuestionAnswer(rawAnswer, questions) {
	const answers = [];
	const text = typeof rawAnswer === "string" ? rawAnswer.trim() : rawAnswer;
	if (text && typeof text === "object" && !Array.isArray(text)) {
		for (const [index, question] of questions.entries()) {
			const value = text[question.question] ?? text[question.id] ?? text[String(index)];
			if (value !== undefined) {
				answers.push({ id: question.id, selectedOptions: normalizeSelection(value, question) });
			}
		}
		if (answers.length) return answers;
	}
	for (const [index, question] of questions.entries()) {
		answers.push({
			id: question.id,
			selectedOptions: normalizeSelection(index === 0 ? text : "", question),
		});
	}
	return answers;
}

function normalizeSelection(value, question) {
	const values = Array.isArray(value) ? value : [value];
	const options = question.options ?? [];
	return values
		.filter(item => item !== undefined && item !== null && item !== "")
		.map(item => {
			const asString = String(item).trim();
			const byLabel = options.find(option => option.label === asString);
			if (byLabel) return byLabel.label;
			// A dictated digit is 1-based ("say a number" on the option rows);
			// 0 also accepts the first option for a wearer who counts from zero.
			if (/^\d+$/.test(asString)) {
				const numeric = Number(asString);
				if (numeric >= 1 && numeric <= options.length) return options[numeric - 1].label;
				if (numeric === 0 && options.length > 0) return options[0].label;
			}
			const byCase = options.find(option => option.label.toLowerCase() === asString.toLowerCase());
			return byCase ? byCase.label : asString;
		});
}

function todoProgress(args) {
	const list = args?.list;
	if (!Array.isArray(list) || list.length === 0) return null;
	const tasks = list.flatMap(entry => entry?.items ?? []);
	if (tasks.length === 0) return null;
	return { completed: 0, total: tasks.length, current: String(tasks[0]) };
}
