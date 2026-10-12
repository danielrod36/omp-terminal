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

	// A permission CARD's body can contain anything, including a line that is exactly `Yes` or
	// `No`. Those must never become options: the list would inflate, the focus index shift, and
	// answerPermission would move the cursor onto the phantom row and submit it instead of
	// Approve/Deny — the wearer says "allow" and a different row is chosen.
	{
		const card = body => [
			"╭─ Allow tool: bash ───────────────────────────────────────────────────────────╮",
			...body,
			"╰──────────────────────────────────────────────────────────────────────────────╯",
		].join("\n");
		const withBody = card([
			"│ Command: ./check.sh                                                          │",
			"│ output: Yes                                                                  │",
			"│                                                                              │",
			"│  \uf054 Approve                                                                   │",
			"│    Deny                                                                      │",
			"│                                                                              │",
			"│ ↑/↓ navigate  󰌑 select  󱊷 cancel                                             │",
			"│                                                                              │",
		]);
		const ok = readDialogFromPane(withBody);
		check("a body line reading Yes is not an option",
			JSON.stringify(ok?.options.map(o => o.label)) === JSON.stringify(["Approve", "Deny"]) && ok?.focusedIndex === 0,
			JSON.stringify(ok?.options.map(o => o.label)) + " focus=" + ok?.focusedIndex);

		// The same, with the body line directly above the choices and no blank row between them.
		const adjacent = card([
			"│ Command: ./check.sh                                                          │",
			"│ Yes                                                                          │",
			"│  \uf054 Approve                                                                   │",
			"│    Deny                                                                      │",
			"│ ↑/↓ navigate  󰌑 select  󱊷 cancel                                             │",
		]);
		const ok2 = readDialogFromPane(adjacent);
		check("a bare Yes directly above the choices is not an option",
			JSON.stringify(ok2?.options.map(o => o.label)) === JSON.stringify(["Approve", "Deny"]),
			JSON.stringify(ok2?.options.map(o => o.label)));

		// The hint bar is located from the CHOICES, not as the last keyword-bearing line: a body
		// line that merely mentions `select` (a shell command, a diff) or a wrapped hint bar used
		// to move the boundary below the real choices and empty the option list, so the card was
		// answered blind — an "allow" pressing Enter on whatever the cursor happened to sit on.
		const mentions = card([
			"│ Command: grep select data                                                    │",
			"│                                                                              │",
			"│  \uf054 Approve                                                                   │",
			"│    Deny                                                                      │",
			"│                                                                              │",
			"│ ↑/↓ navigate  󰌑 select  󱊷 cancel                                             │",
		]);
		const m = readDialogFromPane(mentions);
		check("a body line mentioning select does not move the choice boundary",
			JSON.stringify(m?.options.map(o => o.label)) === JSON.stringify(["Approve", "Deny"]),
			JSON.stringify(m?.options.map(o => o.label)));

		// A wrapped bar whose FIRST fragment carries no keyword: anchoring the scan on the bar alone
		// would stop above the real choices, so the menu is located from the choice rows instead.
		const wrappedKeywordless = card([
			"│ Command: x                                                                   │",
			"│  \uf054 Approve                                                                   │",
			"│    Deny                                                                      │",
			"│ ↑/↓ to choose then press                                                     │",
			"│ select                                                                       │",
		]);
		// The announce must name the rows the CARD shows, not a fixed Yes/No pair: the wearer
		// answers by voice using words they can see.
		check("an Approve/Deny card is announced with its own vocabulary",
			JSON.stringify(readDialogFromPane(wrappedKeywordless)?.options.map(o => o.label)) === JSON.stringify(["Approve", "Deny"]),
			JSON.stringify(readDialogFromPane(wrappedKeywordless)?.options.map(o => o.label)));

		const wk = readDialogFromPane(wrappedKeywordless);
		check("a keywordless first bar fragment still yields the choices",
			JSON.stringify(wk?.options.map(o => o.label)) === JSON.stringify(["Approve", "Deny"]) && wk?.focusedIndex === 0,
			JSON.stringify(wk?.options.map(o => o.label)) + " focus=" + wk?.focusedIndex);

		const wrapped = card([
			"│ Command: x                                                                   │",
			"│  \uf054 Approve                                                                   │",
			"│    Deny                                                                      │",
			"│ ↑/↓ navigate                                                                 │",
			"│ press select to confirm                                                      │",
		]);
		const w = readDialogFromPane(wrapped);
		check("a wrapped hint bar still yields the choices",
			JSON.stringify(w?.options.map(o => o.label)) === JSON.stringify(["Approve", "Deny"]),
			JSON.stringify(w?.options.map(o => o.label)));

		// `Approve`/`Deny` is the card's own vocabulary and `Yes`/`No` is what a body line looks
		// like. Taking the pair nearest the hint bar let a body Yes/No below the real choices
		// displace them, so a dictated "allow" pressed `Yes` instead of Approve.
		const bothPairs = card([
			"│  \uf054 Approve                                                                   │",
			"│    Deny                                                                      │",
			"│ Yes                                                                          │",
			"│ No                                                                           │",
			"│ ↑/↓ navigate  󰌑 select  󱊷 cancel                                             │",
		]);
		const bp = readDialogFromPane(bothPairs);
		check("Approve/Deny wins over a body Yes/No pair",
			JSON.stringify(bp?.options.map(o => o.label)) === JSON.stringify(["Approve", "Deny"]) && bp?.focusedIndex === 0,
			JSON.stringify(bp?.options.map(o => o.label)) + " focus=" + bp?.focusedIndex);

		// Rank must beat LENGTH, not merely position: a body run of three rows (No,Yes,No) sitting
		// above the two-row menu wins on length alone, and the scan then announces the body pair
		// with focus -1 — unanswerable, so every dictated answer is refused. The pair-order fixture
		// above cannot catch this, because a single contiguous run is resolved by the pair rule
		// regardless of how it was ranked.
		const longerBodyRun = card([
			"│ No                                                                           │",
			"│ Yes                                                                          │",
			"│ No                                                                           │",
			"│                                                                              │",
			"│  \uf054 Approve                                                                   │",
			"│    Deny                                                                      │",
			"│ ↑/↓ navigate  󰌑 select  󱊷 cancel                                             │",
		]);
		const lb = readDialogFromPane(longerBodyRun);
		check("a longer non-canonical body run does not outrank the menu",
			JSON.stringify(lb?.options.map(o => o.label)) === JSON.stringify(["Approve", "Deny"]) && lb?.focusedIndex === 0,
			JSON.stringify(lb?.options.map(o => o.label)) + " focus=" + lb?.focusedIndex);

		// A body `Yes` that TOUCHES the menu joins it into `Yes, Approve, Deny`. Reading canonicalness
		// off the run's ends then calls the real menu non-canonical, and it loses to a bare body run.
		const strayTouching = card([
			"│ Yes                                                                          │",
			"│ No                                                                           │",
			"│                                                                              │",
			"│ Yes                                                                          │",
			"│  \uf054 Approve                                                                   │",
			"│    Deny                                                                      │",
			"│ ↑/↓ navigate  󰌑 select  󱊷 cancel                                             │",
		]);
		const st = readDialogFromPane(strayTouching);
		check("a stray choice word touching the menu does not hide it",
			JSON.stringify(st?.options.map(o => o.label)) === JSON.stringify(["Approve", "Deny"]) && st?.focusedIndex === 0,
			JSON.stringify(st?.options.map(o => o.label)) + " focus=" + st?.focusedIndex);

		// An unfocused lone row must not fabricate focus 0: a dictated deny would then submit it.
		const lone = card(["│ Approve                                                                    │", "│ ↑/↓ navigate  󰌑 select  󱊷 cancel                                             │"]);
		const lo = readDialogFromPane(lone);
		check("an unfocused lone row is not answerable",
			(lo?.options ?? []).length === 0,
			JSON.stringify(lo?.options.map(o => o.label)));

		// A genuine Yes/No card must still parse.
		const yesNo = card([
			"│ Continue?                                                                    │",
			"│  \uf054 Yes                                                                      │",
			"│    No                                                                        │",
			"│ ↑/↓ navigate  󰌑 select  󱊷 cancel                                             │",
		]);
		const ok3 = readDialogFromPane(yesNo);
		check("a Yes/No permission card still parses",
			JSON.stringify(ok3?.options.map(o => o.label)) === JSON.stringify(["Yes", "No"]),
			JSON.stringify(ok3?.options.map(o => o.label)));
	}
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
	const build = ({ labels, focus = 0, checked = [], multi = false, headerIcon = false, question = "Which?", hint = "" }) => {
		// The hint bar follows the mode as it does live (measured: `toggle` on every multi
		// capture, `select` on every single one), so it is derived unless the caller passes one.
		// An explicit `null` means "this card has NO bar", which is a real render — a mid-repaint
		// pane shows the rows before the bar paints — and the default used to overwrite it, so no
		// fixture could express that case at all.
		const noHint = hint === null;
		if (!noHint && hint === "") hint = multi ? "toggle" : "select";
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
		if (!noHint) lines.push(`│ ${hint} · ↑/↓ │`);
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
		// A bar-less MULTI card: before the `hint` sentinel was fixed this render could not be
		// expressed at all. It does not isolate the glyph branch — the builder writes the multi
		// marker AND a `Submit` header, so `headerSubmit` would reach the same answer if the glyph
		// signal were removed — it pins that the no-bar multi path parses at all.
		["no hint bar, multi form", { labels: ["A", "B"], multi: true, hint: null }, true],
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
		const recommended = ["\u256d\u2500 Ask \u2500\u256e", "\u2502  tests    runner    Submit \u2502", "\u2502 Do you want tests? \u2502", "\u251c\u2500\u2500\u2500\u2504", `\u2502 ${FOCUS} ${SQUARE} Yes (Recommended) \u2502`, `\u2502   ${SQUARE} No \u2502`, `\u2502   ${MARK} Other (type your own) \u2502`, "\u2502  \u2502", "\u251c\u2500\u2500\u2500\u2504", "\u2502 toggle \u00b7 \u2190/\u2192 question \u00b7 \u2191/\u2193 \u2502", "\u2570\u2500\u2500\u2500\u256f"].join("\n");
		const parsed = readDialogFromPane(recommended);
		check("recommended suffix is kept in the label", parsed?.options[0]?.label === "Yes (Recommended)", JSON.stringify(parsed?.options.map(o => o.label)));
		check("recommended suffix is not read as a multi signal alone", parsed?.multi === true, String(parsed?.multi));
		const byVisible = await trial({ labels: ["Yes (Recommended)", "No"], dictation: "Yes" });
		check('dictating the visible row "Yes" resolves', byVisible.answered?.ok === true && byVisible.pane.focus === 0, JSON.stringify({ answered: byVisible.answered, focus: byVisible.pane.focus }));
	}

	// A permission card whose menu could not be located must NOT be answered. The old code fell
	// back to `approved ? 0 : 1` relative to a target of -1 and pressed Enter, which submits
	// whatever the cursor sits on — a dictated "allow" can land on Deny.
	{
		const session = new AttachSession({
			id: "tmux:perm",
			tmuxSession: "perm",
			cwd: "/tmp",
			provider: "p",
			config: { sessionsRoot: "/tmp", tailIntervalMs: 500 },
			transcriptPath: null,
		});
		// Recording must be ARMED BEFORE the call: installing it afterwards made the
		// `!keys.includes("Enter")` half of the check below vacuous, so a guard regression that
		// pressed Enter blind would still have passed.
		let keys = [];
		session.send = async key => { keys.push(key); return true; };

		// A parsed pair with NO focused row: the cursor delta would be 0, no key sent, and Enter
		// would submit whichever row the desk cursor sits on — so the answer is refused.
		session.capture = async () => [
			"╭─ Allow tool: bash ─╮", "│ Command: x │", "│ Approve │", "│ Deny │",
			"│ ↑/↓ navigate  󰌑 select  󱊷 cancel │", "╰────────────────────╯",
		].join("\n");
		const noFocus = await session.answerPermission("allow");
		check("a permission pair with no focused row is refused, with a reason",
			noFocus.ok === false && /selected/.test(noFocus.reason) && keys.length === 0,
			JSON.stringify({ noFocus, keys }));

		// The app names a question answer three ways and cannot know whether the session is owned
		// or attached, so both must accept the same three. A keyed object used to stringify to
		// "[object Object]", match no option, and drop the wearer's answer.
		// Copied from the live `Ask` dialog in /tmp/realpane.txt: a bare `Ask` header, the question,
		// then option rows that carry a leading bar but no trailing one. The border shapes matter —
		// a hand-drawn box with trailing bars does not parse at all, so a fixture that "looks like"
		// a card can test nothing.
		// The option rows carry a leading bar only — the label runs to the end of the line, with no
		// closing bar. Adding one makes the label itself contain `│` and it matches no option, which
		// is how a fixture that looks like a card tests nothing.
		const questionPane = [
			"╭─ Ask ─╮",
			"│  colours    Submit",
			"│ Which colour do you prefer?",
			"├────────",
			"│    Red",
			"│     Green",
			"│     Blue",
			"│",
			"├────────",
			"│   select · 󰌑 submit · ↑/↓ move",
			"╰────────",
		].join("\n");
		for (const [shape, answer, want] of [
			["a bare label", "Green", true],
			// Keyed by the question text exactly as the pane renders it — the same key the app reads
			// off the `user_question` frame it was sent.
			["an object keyed by the question", { "Which colour do you prefer?": "Green" }, true],
			["an object keyed by index", { 0: "Green" }, true],
			["a label no row carries", "Purple", false],
		]) {
			session.capture = async () => questionPane;
			keys = [];
			const got = await session.answerQuestion(answer);
			const ok = Boolean(got?.ok ?? got) === want;
			check(`a question answer as ${shape} is ${want ? "accepted" : "refused"}`,
				ok && (want ? keys.length > 0 : keys.length === 0),
				JSON.stringify({ got, keys }));
		}

		// A number word names a row, and an ordinal names one too — but a mix of both ("the second
		// one") names two different rows and must be refused, not silently resolved to whichever
		// word the map happened to contain. It used to find only `one`, answer row 1, and press
		// Enter on the wrong row.
		for (const [dictated, wantIndex] of [
			["first", 0],
			["second", 1],
			["third", 2],
		]) {
			session.capture = async () => questionPane;
			keys = [];
			const got = await session.answerQuestion(dictated);
			// The focused row is row 1, so the right answer is proved by the NET cursor movement
			// reaching the wanted row: `first` sends only Enter, the others move down and back.
			const net = keys.filter(k => k === "Down").length - keys.filter(k => k === "Up").length;
			check(`the ordinal "${dictated}" names row ${wantIndex + 1}`,
				Boolean(got?.ok ?? got) && keys.includes("Enter") && net === wantIndex,
				JSON.stringify({ got, keys, net }));
		}
		for (const mixed of ["the second one", "the third one"]) {
			session.capture = async () => questionPane;
			keys = [];
			const got = await session.answerQuestion(mixed);
			check(`an ordinal/cardinal mix ("${mixed}") is refused, not guessed`,
				!(got?.ok ?? got) && keys.length === 0,
				JSON.stringify({ got, keys }));
		}

		// The hint bar is a precondition, not decoration: a card caught mid-repaint can show the
		// rows before the bar paints, and answering it would submit a row the wearer has not
		// finished reading. Such a card must be unanswerable.
		session.capture = async () => [
			"╭─ Allow tool: bash ─╮", "│ Command: x │", "│  \uf054 Approve │", "│    Deny │", "╰────────────────────╯",
		].join("\n");
		keys = [];
		const noBar = await session.answerPermission("allow");
		check("a card whose hint bar has not painted is refused, with a reason",
			noBar.ok === false && typeof noBar.reason === "string" && noBar.reason.length > 0 && keys.length === 0,
			JSON.stringify({ noBar, keys }));

		// A permission card whose choices the parser cannot find (no hint bar, no choice rows at
		// the end): the menu is unknown, so nothing may be submitted.
		session.capture = async () => ["╭─ Allow tool: bash ─╮", "│ Command: x │", "│ │", "╰────────────────────╯"].join("\n");
		const allowed = await session.answerPermission("allow");
		check("an unparseable permission card is refused, not Entered",
			allowed.ok === false && keys.length === 0,
			JSON.stringify({ allowed, keys }));
	}

	// An ambiguous LABEL match must refuse rather than fall through to the number
	// path, which would Enter a row the dictation never clearly named.
	{
		const ambiguous = await trial({ labels: ["HTTP/2", "HTTP/2 (restated)"], dictation: "http 2" });
		check("ambiguous label match refuses instead of Entering a row", ambiguous.answered === false, JSON.stringify({ answered: ambiguous.answered, keys: ambiguous.sends }));
		const unambiguous = await trial({ labels: ["HTTP/2", "HTTP/1.1"], dictation: "http 2" });
		check("unambiguous label match still resolves", unambiguous.answered?.ok === true && unambiguous.pane.focus === 0);
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

	// An alternate icon set (no known marker anywhere) must stay answerable even when
	// its checked glyph is the focused row's: nothing is known to compare against, so
	// its rows cannot be told from a stray and all of them are kept.
	{
		const X = "\uf2c7";       // alternate empty marker
		const XC = "\uf2c9";      // alternate checked marker
		const box = rows => ["╭─ Ask ─╮", "│ Which? │", "├────┤", ...rows, "│  │", "├────┤", "│ select · ↑/↓ │", "╰────╯"].join("\n");
		const altFont = box([`│ ${FOCUS} ${XC} A │`, `│   ${X} B │`]);
		const alt = readDialogFromPane(altFont);
		check("alternate font with a checked focused row keeps its siblings", JSON.stringify(alt?.options.map(o => o.label)) === JSON.stringify(["A", "B"]), JSON.stringify(alt?.options.map(o => o.label)));
		// A checked SIBLING in the same font must survive too: its variant glyph is
		// unnameable, and dropping it would shift every later index.
		const sib = box([`│ ${FOCUS} ${X} A │`, `│   ${X} B │`, `│   ${XC} C │`]);
		const got = readDialogFromPane(sib);
		check("alternate font keeps a checked sibling", JSON.stringify(got?.options.map(o => o.label)) === JSON.stringify(["A", "B", "C"]), JSON.stringify(got?.options.map(o => o.label)));
	}

	// An alternate icon set with a TIED glyph vote keeps every row. This is a deliberate
	// policy, not an oversight: {focused X, sibling X, sibling Z} with Z unnameable is
	// also the shape of a checked sibling whose variant glyph we cannot name, and no
	// pane-only rule separates the two. Keeping a phantom costs a mis-dictated index;
	// dropping a real option loses it outright, which is the worse failure. All twelve
	// real captures use only the known glyphs, and 1,280 realistic dialogs (single- and
	// multi-select, every focus position, every checked combination, 2-6 options)
	// resolve without ever reaching this path.
	{
		const X = "\uf2c7";
		const Y = "\uf2c8";
		const box = rows => ["╭─ Ask ─╮", "│ Which? │", "├────┤", ...rows, "│  │", "├────┤", "│ select · ↑/↓ │", "╰────╯"].join("\n");
		const tied = readDialogFromPane(box([`│ ${FOCUS} ${X} A │`, `│   ${X} B │`, `│ ${Y} note │`]));
		check("a tied alternate-font glyph vote keeps every row", JSON.stringify(tied?.options.map(o => o.label)) === JSON.stringify(["A", "B", "note"]), JSON.stringify(tied?.options.map(o => o.label)));
	}

	// The same stray in a KNOWN font: every row checked leaves no marker to compare
	// against, but the font is known, so an exotic row is still a stray and must not
	// inflate the option list — focusRow and the Down-press arithmetic depend on it.
	{
		const X = "\uf2c7";
		const box = rows => ["╭─ Ask ─╮", "│ Which? │", "├────┤", ...rows, "│  │", "├────┤", "│ select · ↑/↓ │", "╰────╯"].join("\n");
		const strayed = box([`│ ${FOCUS} ${CHECK} A │`, `│   ${CHECK} B │`, `│ ${X} note │`]);
		const kept = readDialogFromPane(strayed);
		check("an all-checked known font drops an exotic stray", JSON.stringify(kept?.options.map(o => o.label)) === JSON.stringify(["A", "B"]), JSON.stringify(kept?.options.map(o => o.label)));
	}

	// A KNOWN font names every marker, so a row whose glyph is neither the empty marker
	// nor the checked one is provably a stray — even when it ties the vote — and is
	// dropped. Keeping it would shift every later dictated index. (The alternate-font
	// keep-all policy above does NOT apply here: nothing is unnameable.)
	{
		const X = "\uf2c7";
		const box = rows => ["╭─ Ask ─╮", "│ Which? │", "├────┤", ...rows, "│  │", "├────┤", "│ select · ↑/↓ │", "╰────╯"].join("\n");
		// A tie between two KNOWN empty glyphs is itself the proof: the marker is a
		// constant function of the mode, so only one of them can be the block's, and the
		// focused row's own empty glyph settles which. The differing row is a stray.
		const tied = box([`│ ${FOCUS} ${MARK} A │`, `│   ${SQUARE} B │`, `│   ${X} note │`]);
		const got = readDialogFromPane(tied);
		check("a known font drops a stray that ties the vote", JSON.stringify(got?.options.map(o => o.label)) === JSON.stringify(["A"]), JSON.stringify(got?.options.map(o => o.label)));
		const multi = box([`│ ${FOCUS} ${SQUARE} A │`, `│   ${SQUARE} B │`, `│ ${X} note │`]);
		const got2 = readDialogFromPane(multi);
		check("a known font keeps a strict-lead row list and drops the stray", JSON.stringify(got2?.options.map(o => o.label)) === JSON.stringify(["A", "B"]), JSON.stringify(got2?.options.map(o => o.label)));
	}

	// The key-hint bar leads the mode decision because it is ASCII and the marker glyph is not.
	// Before this, a dialog whose glyph and hint disagreed took the glyph's word: a multi-select
	// question rendered with the circle glyph was answered as single, so every row the wearer named
	// except the focused one was silently dropped. All twelve live captures agree on both signals,
	// so this changes nothing on real dialogs and only helps a font that draws another glyph.
	{
		const mk = (glyph, hint) => [
			"╭─ Ask ─╮", "│ Which? │", "├────┤",
			`│ ${FOCUS} ${glyph} Blue │`, `│   ${glyph} Green │`,
			"│ │", "├────┤", `│ ${hint} · ↑/↓ · cancel │`, "╰────╯",
		].join("\n");
		check("a toggle hint beats a circle marker",
			readDialogFromPane(mk(MARK, "toggle"))?.multi === true,
			String(readDialogFromPane(mk(MARK, "toggle"))?.multi));
		check("a select hint beats a square marker",
			readDialogFromPane(mk(SQUARE, "select"))?.multi === false,
			String(readDialogFromPane(mk(SQUARE, "select"))?.multi));
		check("circle + select stays single", readDialogFromPane(mk(MARK, "select"))?.multi === false);
		check("square + toggle stays multi", readDialogFromPane(mk(SQUARE, "toggle"))?.multi === true);
	}

	// The tab bar is the LAST resort, not a primary signal. It is consulted only when neither
	// the hint bar nor the marker glyph could decide, because a multi-QUESTION dialog renders
	// that bar while each question is independently single- or multi-select. No live capture
	// reaches this branch (all twelve carry a hint bar and the known markers), so this pins the
	// ordering rather than an observed render.
	{
		const tabOnly = [
			"╭─ Ask ─╮", "│  tests    runner    Submit │", "│ Continue? │", "├────┤",
			`│ ${FOCUS}  Yes │`, `│    No │`,
			"│ │", "├────┤", "╰────╯",
		].join("\n");
		const d = readDialogFromPane(tabOnly);
		check("an unknown font with a tab bar still yields a dialog", d?.options.length === 2, JSON.stringify(d?.options.map(o => o.label)));
		check("and the tab bar is what decided the mode", d?.multi === true, String(d?.multi));
	}

	// A multi-question dialog renders a tab bar ending in `Submit`, but each question
	// is independently single- or multi-select. The tab-bar `Submit` must not promote a
	// single-select question — the marker glyph decides. Captured live from omp 18.8.9.
	{
		const F = "\uf054";
		const C = "\uf10c";
		const tabbed = [
			"╭─ Ask ─────────────────────────────────────",
			"│  tests    runner    Submit                ",
			"│ Do you want tests?                        ",
			"├───────────────────────────────────────────",
			`│ ${F} ${C} Yes                                   `,
			`│   ${C} No                                    `,
			`│   ${C} Other (type your own)                 `,
			"│                                           ",
			"│                                           ",
			"│                                           ",
			"├───────────────────────────────────────────",
			"│ select · n note · ↑/↓ move · ←/→ question  ",
			"╰───────────────────────────────────────────",
		].join("\n");
		const parsed = readDialogFromPane(tabbed);
		check("tab-bar Submit does not promote a single-select question", parsed?.multi === false, String(parsed?.multi));
		check("tabbed question text and options parse", parsed?.prompt === "Do you want tests?" && JSON.stringify(parsed.options.map(o => o.label)) === JSON.stringify(["Yes", "No"]), JSON.stringify(parsed && { p: parsed.prompt, o: parsed.options.map(x => x.label) }));
	}

	// A checked row is a SELECTED option, not a different kind of row. When the focused
	// row is the checked one, seeding the marker vote from it made the checked glyph the
	// block's marker and trimmed every unchecked sibling that shared the dialog's real
	// (empty) glyph — the row the wearer would dictate next simply vanished.
	{
		const mk = rows => ["╭─ Ask ─╮", "│  q  Submit │", "│ Which? │", "├────┤", ...rows, "│  │", "├────┤", "│ toggle · submit · ↑/↓ │", "╰────╯"].join("\n");
		const checkedFocus = mk([`│ ${FOCUS} ${CHECK} A │`, `│   ${SQUARE} B │`]);
		const parsed = readDialogFromPane(checkedFocus);
		check("a checked focused row does not trim its empty sibling", JSON.stringify(parsed?.options.map(o => o.label)) === JSON.stringify(["A", "B"]) && JSON.stringify(parsed?.checked) === "[0]", JSON.stringify(parsed && { o: parsed.options.map(x => x.label), c: parsed.checked }));
		const twoChecked = mk([`│ ${FOCUS} ${CHECK} A │`, `│   ${CHECK} B │`, `│   ${SQUARE} C │`]);
		check("two checked rows plus an empty one keeps all three", JSON.stringify(readDialogFromPane(twoChecked)?.options.map(o => o.label)) === JSON.stringify(["A", "B", "C"]), JSON.stringify(readDialogFromPane(twoChecked)?.options.map(o => o.label)));
		const allChecked = mk([`│ ${FOCUS} ${CHECK} A │`, `│   ${CHECK} B │`]);
		check("a fully checked dialog keeps every row", JSON.stringify(readDialogFromPane(allChecked)?.options.map(o => o.label)) === JSON.stringify(["A", "B"]), JSON.stringify(readDialogFromPane(allChecked)?.options.map(o => o.label)));
		// Exercise the `>1 checked` fallback itself: an EMPTY marker that is neither the
		// square nor the circle leaves glyphMulti null, so only the fallback can decide,
		// and a single-line header plus a `select`-only hint remove the other signals.
		// (With a circle marker the glyph short-circuits and this branch is never read —
		// the check would pass even with the fallback reverted.)
		const EXOTIC = "\uf2c7";
		const fallbackPane = [
			"╭─ Ask ─╮",
			"│ Which? │",
			"├──────┤",
			`│ ${FOCUS} ${CHECK} A │`,
			`│   ${EXOTIC} B │`,
			"│  │",
			"├──────┤",
			"╰──────╯",
		].join("\n");
		const fallback = readDialogFromPane(fallbackPane);
		check("one checked row does not promote via the fallback", fallback?.multi === false, String(fallback?.multi));
		const twoCheckedPane = fallbackPane.replace(`│   ${EXOTIC} B │`, `│   ${CHECK} B │`);
		check("two checked rows do promote via the fallback", readDialogFromPane(twoCheckedPane)?.multi === true, String(readDialogFromPane(twoCheckedPane)?.multi));
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
