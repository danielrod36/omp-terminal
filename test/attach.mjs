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
