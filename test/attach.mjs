/**
 * Attach-mode test.
 *
 * A pure-unit pass scrapes a canned `Allow tool:` pane; `--live` additionally
 * drives a real tmux-hosted omp TUI end to end (prompt injection, approval
 * surfaced from the pane, approval answered through the bridge, answer on the
 * SSE ring, file written by the desk agent).
 *
 * Usage:
 *   node test/attach.mjs          # unit only (no tmux, no omp)
 *   node test/attach.mjs --live   # + live tmux/omp round trip
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { createBridge } from "../src/server.js";
import { configureLog } from "../src/log.js";
import { readDialogFromPane } from "../src/attach.js";

const TMUX = `omp-attach-${Date.now().toString(36)}`;
const workDir = mkdtempSync(join(tmpdir(), "omp-terminal-attach-"));
configureLog({ level: "warn" });

let failures = 0;
const check = (label, condition, detail = "") => {
	if (condition) console.log(`  ✓ ${label}`);
	else {
		failures++;
		console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
	}
};

const tmux = (...args) => execFileSync("tmux", args).toString();

// --- unit: pane scraping -------------------------------------------------
console.log("pane scraping");
{
	const approvalPane = [
		"╭─── Write:  attach-probe2.txt ───────────────────────────────────────────────╮",
		"│   1 hello                                                                    │",
		"│ … (streaming)                                                                │",
		"╰──────────────────────────────────────────────────────────────────────────────╯",
		"",
		"╭─ Allow tool: write ──────────────────────────────────────────────────────────╮",
		"│                                                                              │",
		"│ Path: attach-probe2.txt                                                      │",
		"│ Content:                                                                     │",
		"│ hello                                                                        │",
		"│                                                                              │",
		"│   Approve                                                                   │",
		"│    Deny                                                                      │",
		"│                                                                              │",
		"│ ↑/↓ navigate  󰌑 select  󱊷 cancel                                             │",
		"│                                                                              │",
		"╰──────────────────────────────────────────────────────────────────────────────╯",
	].join("\n");
	const parsed = readDialogFromPane(approvalPane);
	check("approval box detected", parsed?.kind === "permission", JSON.stringify(parsed));
	check("tool name extracted", parsed?.toolName === "write", parsed?.toolName);
	check("body carries the detail", parsed?.body.includes("attach-probe2.txt"));

	const plain = "some\nordinary\noutput\n";
	check("no dialog on plain output", readDialogFromPane(plain) === null);
}

// --- dialog shape and answer-path properties -----------------------------
// These drive a modelled pane so the parser and the navigation are checked as a
// unit: an option row's physical position, not just its text, decides which row
// a dictated answer lands on.
console.log("dialog properties");
{
	const FOCUS = "\uf054";
	const MARK = "\uf10c";
	const SQUARE = "\uf096";
	const CHECK = "\uf14a";
	const ICON = "\uf2c7";
	// The marker glyph encodes the mode (measured by controlled A/B): a multi-select
	// dialog renders U+F096 (square), a single-select one U+F10C (circle), and a
	// selected row U+F14A.
	const build = ({ labels, focus = 0, checked = [], multi = false, headerIcon = false, question = "Which?", hint = "select" }) => {
		const shape = multi ? SQUARE : MARK;
		const lines = ["╭─ Ask ─╮"];
		if (multi) lines.push(`│ ${headerIcon ? ICON + " " : ""}colour  Submit │`);
		lines.push(`│ ${question} │`, "├──────┤");
		labels.forEach((label, index) => {
			const cursor = index === focus ? `${FOCUS} ` : "  ";
			const marker = checked.includes(index) ? CHECK : shape;
			lines.push(`│ ${cursor}${marker} ${label} │`);
		});
		lines.push("│      │", "├──────┤");
		if (hint !== null) lines.push(`│ ${hint} · ↑/↓ │`);
		lines.push("╰──────╯");
		return lines.join("\n");
	};

	// Valid dialogs must parse with the right options, focus, and mode.
	for (const [name, opts, wantMulti] of [
		["plain single-select", { labels: ["Red", "Blue"] }, false],
		["multi with header", { labels: ["Red", "Blue"], multi: true }, true],
		["multi, glyph-led header", { labels: ["Red", "Blue"], multi: true, headerIcon: true }, true],
		["focus on the last row", { labels: ["A", "B", "C"], focus: 2 }, false],
		["already-checked row", { labels: ["A", "B"], checked: [1], multi: true }, true],
		["labels that begin with a glyph", { labels: ["● Low", "★ Star", "□ Box"] }, false],
		["reworded hint bar", { labels: ["A", "B"], hint: "mark · confirm" }, false],
		["no hint bar", { labels: ["A", "B"], hint: null }, false],
		["question mentioning Submit", { labels: ["A", "B"], question: "Should I submit?" }, false],
	]) {
		const parsed = readDialogFromPane(build(opts));
		check(`parses: ${name}`, parsed?.options.length === opts.labels.length && parsed.multi === wantMulti, JSON.stringify(parsed && { o: parsed.options.map(x => x.label), m: parsed.multi }));
		if (opts.focus !== undefined && parsed) check(`focus row: ${name}`, parsed.focusedIndex === opts.focus, String(parsed.focusedIndex));
		if (opts.checked) check(`checked rows: ${name}`, JSON.stringify(parsed?.checked) === JSON.stringify(opts.checked), JSON.stringify(parsed?.checked));
	}

	// A glyph-led header must never register as an option row.
	{
		const parsed = readDialogFromPane(build({ labels: ["Red", "Blue"], multi: true, headerIcon: true }));
		check("glyph-led header adds no option", parsed?.options.length === 2, JSON.stringify(parsed?.options.map(o => o.label)));
		check("glyph-led header is not the prompt", parsed?.prompt === "Which?", JSON.stringify(parsed?.prompt));
	}

	// The transcript echo left by a closed dialog is not a live dialog.
	{
		const echo = [
			"╭─── Ask 1 questions ───╮",
			"├─── [colour] · options:2 ───┤",
			"│  Which?  │",
			`│  ${MARK} Red │`,
			`│  ${MARK} Blue │`,
			"╰────╯",
		].join("\n");
		check("transcript echo is not a dialog", readDialogFromPane(echo) === null);
		check("prose + numbered list is not a dialog", readDialogFromPane("Q?\n  1. a\n  2. b") === null);
		check("plain output is not a dialog", readDialogFromPane("some\nordinary\noutput\n") === null);
	}
}

// The answer paths move the pane's cursor, so the modelled pane mutates as keys
// are sent and the assertions read the state the desk TUI would actually be in.
console.log("answer paths");
{
	const FOCUS = "\uf054";
	const MARK = "\uf10c";
	const CHECK = "\uf14a";
	const SQUARE = "\uf096";
	const { AttachSession } = await import("../src/attach.js");
	// The marker glyph encodes the mode (measured by A/B): square for multi-select,
	// circle for single, checked box for a selected row.
	const render = (labels, focus, checked, multi) => {
		const shape = multi ? SQUARE : MARK;
		const lines = ["╭─ Ask ─╮"];
		if (multi) lines.push("│  q  Submit │");
		lines.push("│ Which? │", "├──────┤");
		labels.forEach((label, index) => {
			const cursor = index === focus ? `${FOCUS} ` : "  ";
			const marker = checked.includes(index) ? CHECK : shape;
			lines.push(`│ ${cursor}${marker} ${label} │`);
		});
		lines.push("│      │", "├──────┤", `│ ${multi ? "toggle · submit" : "select"} · ↑/↓ │`, "╰──────╯");
		return lines.join("\n");
	};

	const trial = async ({ labels, focus = 0, checked = [], multi = false, dictation, sendFailsAt = Infinity }) => {
		const pane = { labels: [...labels], focus, checked: [...checked] };
		let sends = 0;
		const session = new AttachSession({
			id: "tmux:props",
			tmuxSession: "props",
			cwd: "/tmp",
			provider: "p",
			config: { sessionsRoot: "/tmp", tailIntervalMs: 500 },
			transcriptPath: null,
		});
		session.capture = async () => render(pane.labels, pane.focus, pane.checked, multi);
		session.send = async key => {
			if (++sends > sendFailsAt) return false;
			if (key === "Down") pane.focus = Math.min(pane.focus + 1, pane.labels.length - 1);
			else if (key === "Up") pane.focus = Math.max(pane.focus - 1, 0);
			else if (key === "Space") pane.checked = pane.checked.includes(pane.focus) ? pane.checked.filter(i => i !== pane.focus) : [...pane.checked, pane.focus];
			return true;
		};
		const answered = await session.answerQuestion(dictation);
		return { answered, pane, sends, state: session.state };
	};

	for (const [dictation, labels, focus, wantIndex] of [
		["Green", ["Red", "Blue", "Green"], 0, 2],
		["Red", ["Red", "Blue", "Green"], 2, 0],
		["2", ["Red", "Blue", "Green"], 0, 1],
		["blue", ["Red", "Blue", "Green"], 0, 1],
		["http 2", ["HTTP/2", "HTTP/1.1"], 0, 0],
		["1.1", ["HTTP/2", "HTTP/1.1"], 0, 1],
	]) {
		const result = await trial({ labels, focus, dictation });
		check(`dictation "${dictation}" lands on the named row`, result.answered && result.pane.focus === wantIndex, JSON.stringify({ focus: result.pane.focus, want: wantIndex, answered: result.answered }));
	}

	for (const [dictation, checked, wantChecked] of [
		["Blue", [], [1]],
		["Green", [1], [1, 2]],
		["Blue", [1], [1]],
	]) {
		const result = await trial({ labels: ["Red", "Blue", "Green"], checked, multi: true, dictation });
		const got = [...result.pane.checked].sort().join(",");
		const want = [...wantChecked].sort().join(",");
		check(`multi "${dictation}" with pre-checked [${checked}] ends checked [${want}]`, result.answered && got === want, JSON.stringify({ got, want }));
	}

	// A recommended option renders as `Yes (Recommended)`; the wearer dictates what
	// they see, so the display suffix must not block the match.
	{
		const recommended = ["\u256d\u2500 Ask \u2500\u256e", "\u2502  tests    runner    Submit \u2502", "\u2502 Do you want tests? \u2502", "\u251c\u2500\u2500\u2500\u2504", `\u2502 ${FOCUS} ${SQUARE} Yes (Recommended) \u2502`, `\u2502   ${SQUARE} No \u2502`, `\u2502   ${MARK} Other (type your own) \u2502`, "\u2502  \u2502", "\u251c\u2500\u2500\u2500\u2504", "\u2502 select \u00b7 \u2190/\u2192 question \u00b7 \u2191/\u2193 \u2502", "\u2570\u2500\u2500\u2500\u256f"].join("\n");
		const parsed = readDialogFromPane(recommended);
		check("recommended suffix is kept in the label", parsed?.options[0]?.label === "Yes (Recommended)", JSON.stringify(parsed?.options.map(o => o.label)));
		check("recommended suffix is not read as a multi signal alone", parsed?.multi === true, String(parsed?.multi));
		const byVisible = await trial({ labels: ["Yes (Recommended)", "No"], dictation: "Yes" });
		check('dictating the visible row "Yes" resolves', byVisible.answered === true && byVisible.pane.focus === 0, JSON.stringify({ answered: byVisible.answered, focus: byVisible.pane.focus }));
	}

	// An ambiguous LABEL match must refuse rather than fall through to the number
	// path, which would Enter a row the dictation never clearly named.
	{
		const ambiguous = await trial({ labels: ["HTTP/2", "HTTP/2 (restated)"], dictation: "http 2" });
		check("ambiguous label match refuses instead of Entering a row", ambiguous.answered === false, JSON.stringify({ answered: ambiguous.answered, keys: ambiguous.sends }));
		const unambiguous = await trial({ labels: ["HTTP/2", "HTTP/1.1"], dictation: "http 2" });
		check("unambiguous label match still resolves", unambiguous.answered === true && unambiguous.pane.focus === 0);
	}

	// A stray framed row must never win regardless of where it sits or how the
	// option columns shifted, while a real option at a minority marker offset must
	// survive. The discriminator is the marker GLYPH (stable within a dialog), not
	// the column (which moves with the focus glyph and the terminal padding).
	{
		const mk = rows => ["╭─ Ask ─╮", "│  q  Submit │", "│ Which? │", "├────┤", ...rows, "│  │", "├────┤", "│ toggle · submit · ↑/↓ │", "╰────╯"].join("\n");
		const strayFirst = mk([`│ \uf2c7 note │`, `│ ${FOCUS} ${MARK} Only │`]);
		check("stray before the only option does not win", JSON.stringify(readDialogFromPane(strayFirst)?.options.map(o => o.label)) === JSON.stringify(["Only"]), JSON.stringify(readDialogFromPane(strayFirst)?.options.map(o => o.label)));
		const strayMid = mk([`│ ${FOCUS} ${MARK} A │`, `│ \uf2c7 note │`, `│   ${MARK} B │`]);
		check("stray between options is dropped, focus intact", JSON.stringify(readDialogFromPane(strayMid)?.options.map(o => o.label)) === JSON.stringify(["A", "B"]), JSON.stringify(readDialogFromPane(strayMid)?.options.map(o => o.label)));
		const offModal = mk([`│ ${FOCUS} ${MARK} A │`, `│   ${MARK} B │`, `│  ${MARK} C │`, `│   ${MARK} D │`]);
		check("an option at a minority offset survives", JSON.stringify(readDialogFromPane(offModal)?.options.map(o => o.label)) === JSON.stringify(["A", "B", "C", "D"]), JSON.stringify(readDialogFromPane(offModal)?.options.map(o => o.label)));
		const checkedPlusStray = mk([`│ ${FOCUS} ${CHECK} A │`, `│   ${MARK} B │`, `│   ${MARK} C │`, `│ \uf2c7 note │`]);
		const parsed = readDialogFromPane(checkedPlusStray);
		check("a checked row counts as an option", JSON.stringify(parsed?.options.map(o => o.label)) === JSON.stringify(["A", "B", "C"]) && JSON.stringify(parsed?.checked) === "[0]", JSON.stringify(parsed && { o: parsed.options.map(x => x.label), c: parsed.checked }));
	}

	// A render whose focused row sits one column off (leading padding is
	// terminal-width dependent) must still yield a usable dialog: the focused row is
	// never trimmed, or focusRow stays -1 and the dialog becomes unanswerable.
	{
		const splitPane = [
			"╭─ Ask ─╮", "│ Which? │", "├────┤",
			`│  ${FOCUS} ${MARK} Red │`,   // focused, shifted one column
			`│   ${MARK} Green │`,
			`│   ${MARK} Blue │`,
			"│  │", "├────┤", "│ select · ↑/↓ │", "╰────╯",
		].join("\n");
		const parsed = readDialogFromPane(splitPane);
		check("split marker offsets keep every row and the focus", parsed?.options.length === 3 && parsed.focusedIndex === 0, JSON.stringify(parsed && { o: parsed.options.map(x => x.label), f: parsed.focusedIndex }));
		const strayPane = [
			"╭─ Ask ─╮", "│ Which? │", "├────┤",
			`│ \uf2c7 note │`,            // a note row inside the block
			`│ ${FOCUS} ${MARK} Red │`,
			`│   ${MARK} Green │`,
			"│  │", "├────┤", "│ select · ↑/↓ │", "╰────╯",
		].join("\n");
		const strayParsed = readDialogFromPane(strayPane);
		check("a stray icon row is dropped without shifting focus", JSON.stringify(strayParsed?.options.map(o => o.label)) === JSON.stringify(["Red", "Green"]) && strayParsed.focusedIndex === 0, JSON.stringify(strayParsed && { o: strayParsed.options.map(x => x.label), f: strayParsed.focusedIndex }));
	}

	for (const dictation of ["s", "zz", "nope"]) {
		const result = await trial({ labels: ["Red", "Blue"], dictation });
		check(`short/unknown "${dictation}" is refused`, result.answered === false && result.state !== "busy", JSON.stringify({ answered: result.answered, state: result.state }));
	}

	for (const [name, failAt] of [["first key", 0], ["second key", 1], ["the submit key", 2]]) {
		const result = await trial({ labels: ["Red", "Blue", "Green"], dictation: "Green", sendFailsAt: failAt });
		check(`send failure on the ${name} does not report an answer`, result.answered === false && result.state !== "busy", JSON.stringify({ answered: result.answered, state: result.state }));
	}
}

// --- live attach ---------------------------------------------------------
const live = process.argv.includes("--live");
if (!live) {
	console.log("live attach (skipped: pass --live to exercise tmux + omp)");
} else {
	console.log("live attach");
}
let bridge;
try {
	if (!live) throw new Error("SKIP");
	if (live) {
		try {
			execFileSync("tmux", ["kill-session", "-t", TMUX]);
		} catch {
			/* no such session */
		}
		execFileSync("tmux", [
			"new-session",
			"-d",
			"-s",
			TMUX,
			"-c",
			workDir,
			"-x",
			"200",
			"-y",
			"45",
			"omp --approval-mode always-ask",
		]);
		await new Promise(resolve => setTimeout(resolve, 9000));
	}

	const config = loadConfig({
		flags: { port: 0, cwd: workDir, token: "attach-token", logLevel: "warn", attach: true },
	});
	bridge = createBridge(config);
	await bridge.listen();
	const { port } = bridge.server.address();
	const base = `http://127.0.0.1:${port}`;
	const auth = { Authorization: "Bearer attach-token" };

	const list = await (await fetch(`${base}/api/sessions`, { headers: auth })).json();
	const entry = list.sessions.find(session => session.attach?.tmuxSession === TMUX);
	check("tmux pane listed as attach session", Boolean(entry), JSON.stringify(list.sessions.slice(0, 3)));
	if (!entry) throw new Error("attach entry missing");

	const sid = entry.id;
	const stream = await fetch(`${base}/api/events?sessionId=${sid}&needReplay=true`, { headers: auth });
	const reader = stream.body.getReader();
	const frames = [];
	const pump = (async () => {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			for (const line of new TextDecoder().decode(value, { stream: true }).split("\n")) {
				if (!line.startsWith("data: ")) continue;
				try {
					frames.push(JSON.parse(line.slice(6)));
				} catch {
					/* partial */
				}
			}
		}
	})();

	const prompt = await fetch(`${base}/api/prompt`, {
		method: "POST",
		headers: { ...auth, "Content-Type": "application/json" },
		body: JSON.stringify({
			text: "Create attach-via-bridge.txt with content bridge-ok using the write tool. Then reply: attach-done",
			sessionId: sid,
		}),
	});
	check("prompt injected", prompt.status === 202);
	check("user_prompt echoed", frames.some(frame => frame.type === "user_prompt"));

	// 1) the pane's approval box must surface as a permission_request frame
	let approval = null;
	const approvalDeadline = Date.now() + 120_000;
	while (Date.now() < approvalDeadline && !approval) {
		approval = frames.find(frame => frame.type === "permission_request");
		if (!approval) await new Promise(resolve => setTimeout(resolve, 500));
	}
	check("permission_request surfaced from the pane", Boolean(approval), `frames: ${frames.map(f => f.type).join(",")}`);
	check("awaiting status emitted", frames.some(frame => frame.type === "status" && frame.state === "awaiting"));

	// 2) answering through the bridge must approve the desk dialog
	if (approval) {
		const answered = await fetch(`${base}/api/permission-response`, {
			method: "POST",
			headers: { ...auth, "Content-Type": "application/json" },
			body: JSON.stringify({ sessionId: sid, decision: "allow" }),
		});
		check("permission-response accepted", answered.status === 200, `status ${answered.status}`);
	}

	const doneDeadline = Date.now() + 120_000;
	while (Date.now() < doneDeadline && !frames.some(frame => frame.type === "result" && frame.text)) {
		await new Promise(resolve => setTimeout(resolve, 500));
	}
	check("assistant text committed", frames.some(frame => frame.type === "result" && frame.text));
	check(
		"answer reached the lens",
		frames.filter(frame => frame.type === "text_delta").map(frame => frame.text).join("").includes("attach-done"),
	);

	const file = join(workDir, "attach-via-bridge.txt");
	check("desk agent wrote the file", existsSync(file) && readFileSync(file, "utf8").includes("bridge-ok"));

	reader.cancel().catch(() => {});
	await pump.catch(() => {});
} catch (error) {
	if (error.message !== "SKIP") {
		failures++;
		console.log(`  ✗ attach test threw: ${error.message}`);
	}
} finally {
	if (bridge) await bridge.close();
	try {
		execFileSync("tmux", ["kill-session", "-t", TMUX]);
	} catch {
		/* already gone */
	}
	rmSync(workDir, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nATTACH PASS" : `\nATTACH FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
