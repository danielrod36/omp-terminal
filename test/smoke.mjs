#!/usr/bin/env node
/**
 * End-to-end smoke test for the omp-terminal bridge.
 *
 * Drives the real HTTP surface with the real omp binary and asserts the Even
 * wire contract: bearer auth, session listing, a prompt round-trip whose SSE
 * stream carries the four-part paint-and-persist burst, and an ask-dialog
 * round-trip through /api/question-response.
 *
 * Usage: node test/smoke.mjs [--no-omp]
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { createBridge } from "../src/server.js";
import { configureLog } from "../src/log.js";

const withOmp = !process.argv.includes("--no-omp");
const workDir = mkdtempSync(join(tmpdir(), "omp-terminal-smoke-"));
const config = loadConfig({
	flags: {
		port: 0,
		cwd: workDir,
		token: "smoke-token",
		logLevel: "warn",
		attach: false,
		// A temp store: nothing here may read or write the host's real ~/.omp/agent or
		// ~/.omp-terminal, both of which hold the wearer's own data.
		sessionsRoot: join(workDir, "sessions"),
	},
	store: {},
	storePath: join(workDir, "config.json"),
});
mkdirSync(config.sessionsRoot, { recursive: true });
configureLog({ level: "warn" });

// Port 0 means "pick a free port"; probe the bound port after listen().
const bridge = createBridge(config);
await bridge.listen();
const { port } = bridge.server.address();
const base = `http://127.0.0.1:${port}`;
const auth = { Authorization: `Bearer ${config.token}` };

let failures = 0;
const check = (label, condition, detail = "") => {
	if (condition) {
		console.log(`  ✓ ${label}`);
	} else {
		failures++;
		console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
	}
};

console.log("auth");
{
	const unauth = await fetch(`${base}/api/sessions`);
	check("401 without token", unauth.status === 401, `got ${unauth.status}`);
	// The wire vocabulary is the app's fixed set; the real backend is named in
	// healthz/extra so the label alone never hides what is running.
	const health = await fetch(`${base}/healthz`);
	const body = await health.json();
	check(
		"healthz names the wire label + real backend",
		health.status === 200 && body.provider === config.providerLabel && body.backend === "omp",
		JSON.stringify(body),
	);
}

console.log("sessions");
{
	const response = await fetch(`${base}/api/sessions?limit=5`, { headers: auth });
	const body = await response.json();
	check("200 with session list", response.status === 200 && Array.isArray(body.sessions));
	check(
		"session shape",
		body.sessions.every(s => s.id && s.provider === config.providerLabel && "status" in s),
	);
}

if (withOmp) {
	console.log("prompt round-trip (real omp child)");
	const streamed = [];
	const prompt = await fetch(`${base}/api/prompt`, {
		method: "POST",
		headers: { ...auth, "Content-Type": "application/json" },
		body: JSON.stringify({ text: "Reply with exactly: smoke-ok" }),
	});
	const promptBody = await prompt.json();
	check("prompt accepted", prompt.status === 202 && promptBody.ok === true, JSON.stringify(promptBody));
	// The bridge adopts omp's canonical id and returns it, like the stock bridge
	// returning the SDK-resolved id. Subscribe with that id — the ring replay
	// then covers the frames emitted before the subscription attached.
	const canonicalId = promptBody.sessionId;
	check("prompt response names a session", Boolean(canonicalId));

	const stream = await fetch(`${base}/api/events?sessionId=${canonicalId}&needReplay=true`, { headers: auth });
	const reader = stream.body.getReader();
	const decoder = new TextDecoder();
	const pump = (async () => {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			const text = decoder.decode(value, { stream: true });
			for (const line of text.split("\n")) {
				if (!line.startsWith("data: ")) continue;
				try {
					streamed.push(JSON.parse(line.slice(6)));
				} catch {
					/* partial frame */
				}
			}
		}
	})();

	const deadline = Date.now() + 120_000;
	while (Date.now() < deadline && !streamed.some(frame => frame.type === "result")) {
		await new Promise(resolve => setTimeout(resolve, 400));
	}
	reader.cancel().catch(() => {});
	await pump.catch(() => {});

	const states = streamed.filter(frame => frame.type === "status").map(frame => frame.state);
	check("user_prompt echoed", streamed.some(frame => frame.type === "user_prompt"));
	check("busy status emitted", states.includes("busy"));
	check("text_start emitted with sessionId", streamed.some(frame => frame.type === "status" && frame.state === "text_start" && frame.sessionId === canonicalId));
	check("text_delta is bare", streamed.some(frame => frame.type === "text_delta" && typeof frame.text === "string" && !("ts" in frame)));
	check("result commits the answer", streamed.some(frame => frame.type === "result" && frame.text));
	check("answer text reached the lens", streamed.filter(frame => frame.type === "text_delta").map(frame => frame.text).join("").includes("smoke-ok"));
	check("idle status closes the turn", states.includes("idle"));

	console.log("status + history");
	{
		const status = await fetch(`${base}/api/status?sessionId=${canonicalId}`, { headers: auth });
		const body = await status.json();
		check("status is terminal", status.status === 200 && ["idle", "busy", "awaiting"].includes(body.state));
		const history = await fetch(`${base}/api/sessions/${canonicalId}/history`, { headers: auth });
		const historyBody = await history.json();
		check("history returns the exchange", history.status === 200 && historyBody.history.some(item => item.role === "user"));
	}

	console.log("ask round-trip");
	{
		const askResponse = await fetch(`${base}/api/prompt`, {
			method: "POST",
			headers: { ...auth, "Content-Type": "application/json" },
			body: JSON.stringify({
				text: "Use the ask tool exactly once: ask which colour I prefer, options Red and Blue. Then reply done.",
			}),
		});
		const askBody = await askResponse.json();
		const askSession = askBody.sessionId;
		check("ask prompt accepted", askResponse.status === 202 && Boolean(askSession));
		const askStream = await fetch(`${base}/api/events?sessionId=${askSession}&needReplay=true`, { headers: auth });
		const askReader = askStream.body.getReader();
		const askFrames = [];
		const askPump = (async () => {
			while (true) {
				const { done, value } = await askReader.read();
				if (done) break;
				for (const line of new TextDecoder().decode(value, { stream: true }).split("\n")) {
					if (!line.startsWith("data: ")) continue;
					try {
						askFrames.push(JSON.parse(line.slice(6)));
					} catch {
						/* partial */
					}
				}
			}
		})();
		const askDeadline = Date.now() + 120_000;
		let questionFrame = null;
		while (Date.now() < askDeadline && !questionFrame) {
			questionFrame = askFrames.find(frame => frame.type === "user_question");
			if (!questionFrame) await new Promise(resolve => setTimeout(resolve, 400));
		}
		check("user_question emitted", Boolean(questionFrame), "no question frame within 120s");
		if (questionFrame) {
			const answer = await fetch(`${base}/api/question-response`, {
				method: "POST",
				headers: { ...auth, "Content-Type": "application/json" },
				body: JSON.stringify({ sessionId: askSession, answer: { [questionFrame.questions[0].question]: "Blue" } }),
			});
			check("question-response accepted", answer.status === 200);
			const doneDeadline = Date.now() + 90_000;
			while (Date.now() < doneDeadline && !askFrames.some(frame => frame.type === "result" && frame.text)) {
				await new Promise(resolve => setTimeout(resolve, 400));
			}
			check("answer committed after question", askFrames.some(frame => frame.type === "result" && frame.text));
		}
		askReader.cancel().catch(() => {});
		await askPump.catch(() => {});
	}
} else {
	console.log("(omp child skipped: --no-omp)");
}

console.log("parseQuestionAnswer unit checks");
{
	const { parseQuestionAnswer } = await import("../src/provider.js");
	const questions = [{ id: "colour", question: "Which colour?", options: [{ label: "Red" }, { label: "Blue" }] }];
	const byText = parseQuestionAnswer({ "Which colour?": "Blue" }, questions);
	check("text-keyed answer resolves by label", byText[0]?.selectedOptions[0] === "Blue");
	const byIndex = parseQuestionAnswer("2", questions);
	check("bare index resolves to the second option", byIndex[0]?.selectedOptions[0] === "Blue");
	const byCase = parseQuestionAnswer("red", questions);
	check("case-insensitive label resolves", byCase[0]?.selectedOptions[0] === "Red");
}

console.log("tunnel provider parsing");
{
	const { PROVIDERS, providerNames } = await import("../src/expose.js");
	check("cloudflare provider registered", providerNames().includes("cloudflare"));
	check(
		"cloudflared argv targets the bridge port",
		JSON.stringify(PROVIDERS.cloudflare.buildArgs(3456)) ===
			JSON.stringify(["tunnel", "--url", "http://127.0.0.1:3456", "--no-autoupdate"]),
	);
	// Real cloudflared output: the URL sits inside a bordered box.
	const cfOutput = [
		"2026-10-11T06:24:51Z INF +-----------------------------------------------------------+",
		"2026-10-11T06:24:51Z INF |  Your quick Tunnel has been created! Visit it at:           |",
		"2026-10-11T06:24:51Z INF |  https://might-murray-calculation-remain.trycloudflare.com  |",
		"2026-10-11T06:24:51Z INF +-----------------------------------------------------------+",
	].join("\n");
	check(
		"cloudflared URL parsed from the box",
		PROVIDERS.cloudflare.parseUrl(cfOutput) === "https://might-murray-calculation-remain.trycloudflare.com",
		PROVIDERS.cloudflare.parseUrl(cfOutput),
	);
	// Real pinggy output (free tunnels use either suffix).
	check(
		"pinggy URL parsed (.link)",
		PROVIDERS.pinggy.parseUrl("https://mmskd-85-235-64-221.free.pinggy.link") ===
			"https://mmskd-85-235-64-221.free.pinggy.link",
	);
	check(
		"pinggy URL parsed (.net)",
		PROVIDERS.pinggy.parseUrl("https://ryaih-85-235-64-221.free.pinggy.net") ===
			"https://ryaih-85-235-64-221.free.pinggy.net",
	);
	check(
		"bore URL parsed",
		PROVIDERS.bore.parseUrl("2026/01/01 listening at bore.pub:41234") === "http://bore.pub:41234",
	);
	check(
		"ngrok URL parsed from JSON log",
		PROVIDERS.ngrok.parseUrl('{"addr":"http://localhost:3456","url":"https://abc123.ngrok-free.app"}') ===
			"https://abc123.ngrok-free.app",
	);
	check("unknown provider is rejected", !providerNames().includes("nope"));
	try {
		const { startTunnel } = await import("../src/expose.js");
		await startTunnel({ providerName: "nope", port: 1 });
		check("startTunnel throws on unknown provider", false);
	} catch (error) {
		check("startTunnel throws on unknown provider", /unknown expose provider/.test(error.message), error.message);
	}
	// A missing program must reject with the override hint, not hang.
	try {
		const { startTunnel } = await import("../src/expose.js");
		process.env.BORE_PROGRAM_PATH = "/nonexistent/bore-xyz";
		await startTunnel({ providerName: "bore", port: 3456 });
		check("missing program rejects", false);
	} catch (error) {
		check("missing program rejects with a fix hint", /BORE_PROGRAM_PATH/.test(error.message), error.message);
	} finally {
		delete process.env.BORE_PROGRAM_PATH;
	}
}

console.log("auth and path confinement");
{
	// An empty token must never disable auth: `?token=` would satisfy it from any caller.
	// A scratch store path: generating a token must never write the host's real
	// ~/.omp-terminal/config.json, which would rotate the pairing of a paired wearer.
	const empty = loadConfig({ flags: { token: "" }, store: {}, storePath: join(workDir, "empty-token.json") });
	check("an empty --token generates one instead of disabling auth", empty.token.length > 0 && empty.tokenSource === "generated", `${JSON.stringify(empty.token)}/${empty.tokenSource}`);

	// A session id is opaque. A path that escapes the sessions root must not be read,
	// even though it exists and ends in .jsonl.
	const { findOmpSession, listOmpSessions } = await import("../src/sessions.js");
	const outside = join(workDir, "outside.jsonl");
	writeFileSync(outside, `${JSON.stringify({ type: "title", title: "outside" })}\n`);
	check("a transcript outside the sessions root is never resolved", findOmpSession(config, outside) === null);
	// The escape target must EXIST, or the check passes for the wrong reason (nothing to
	// find) rather than because the path was refused.
	const escape = join(config.sessionsRoot, "..", "outside.jsonl");
	writeFileSync(escape, `${JSON.stringify({ type: "title", title: "escaped" })}\n`);
	check("nor via a traversal out of the root to a real file", existsSync(escape) && findOmpSession(config, escape) === null);
	check("a non-string session id is an unknown id, not a throw", findOmpSession(config, 123) === null);
	check("the store scan still returns sessions", Array.isArray(listOmpSessions(config, { limit: 1 })));
	// A listing must not parse every transcript to return a few: the options object is the
	// signature, and `limit` bounds the WORK, not just the result slice.
	check("the store scan honours limit", listOmpSessions(config, { limit: 1 }).length <= 1, String(listOmpSessions(config, { limit: 1 }).length));
}

console.log("sse ring lifecycle");
{
	// A long-lived bridge mints a fresh id per conversation, so a ring that is never
	// freed retains every conversation's frames for the life of the process. The ring
	// is dropped only once nothing can read it again: an attached client or a live
	// alias must hold it open.
	const events = await import("../src/events.js");
	const fake = { write() {}, end() {}, on() {}, once() {}, setHeader() {}, flushHeaders() {}, writableEnded: false, destroyed: false };
	events.emit("ring-test", { type: "user_prompt", text: "hi" });
	check("a ring with no client is reclaimable", events.dropSession("ring-test") === true);
	const live = "ring-live";
	events.emit(live, { type: "user_prompt", text: "hi" });
	events.addClient(live, fake, false, null);
	check("a ring with an attached client is not reclaimed", events.dropSession(live) === false);
	check("its history stays readable for the reconnect", events.historyFromRing(live).length > 0);
	// A linked class is one session under two names: dropping only the canonical leaves
	// the alias holding a full copy of every frame.
	events.linkSessions("ring-alias", "ring-canon");
	events.emit("ring-canon", { type: "user_prompt", text: "x" });
	check("a linked class drops as a unit", events.dropSession("ring-canon") === true);
	// A client that stops reading must be dropped rather than buffered without bound:
	// its frames stay in the ring and a reconnect replays them from the cursor.
	const stalled = {
		writableLength: 8 * 1024 * 1024,
		// The `:ok` primer is sent before the client is registered, so it is expected;
		// anything carrying a frame id is not.
		write(chunk) {
			if (String(chunk).startsWith("id: ")) throw new Error("must not buffer frames for a stalled client");
		},
		end() { this.ended = true; },
		on() {}, once() {}, setHeader() {}, flushHeaders() {}, writableEnded: false, destroyed: false,
	};
	events.emit("ring-stall", { type: "user_prompt", text: "hi" });
	events.addClient("ring-stall", stalled, false, null);
	const before = events.totalClients();
	events.emit("ring-stall", { type: "text_delta", text: "x" });
	// The primer is sent before registration, so only the FRAME write is forbidden; the
	// `write` above throws if one is attempted.
	check("a client too far behind is dropped, not buffered", stalled.ended === true && events.totalClients() === before);

	// Dropping a stalled client must also stop its heartbeat: a timer still writing after
	// end() raises ERR_STREAM_WRITE_AFTER_END asynchronously, which is an unhandled 'error'
	// event and took the whole bridge down. The teardown is observable via the dispose
	// marker, so assert it ran rather than waiting 15 s for the tick.
	const stalledRes = {
		writableLength: 0, // starts healthy, so it registers and gets a heartbeat
		write() {},
		end() { this.ended = true; },
		on() {}, once() {}, setHeader() {}, flushHeaders() {}, writableEnded: false, destroyed: false,
	};
	events.emit("ring-hb", { type: "user_prompt", text: "hi" });
	events.addClient("ring-hb", stalledRes, false, null);
	// It falls behind only once attached, which is the case the emit-path drop handles.
	stalledRes.writableLength = 8 * 1024 * 1024;
	const marker = Symbol.for("omp-terminal.dispose");
	const armed = typeof stalledRes[marker] === "function";
	events.emit("ring-hb", { type: "text_delta", text: "x" });
	// `armed` proves it was registered with a heartbeat; the marker disappearing proves the
	// teardown ran. Nothing here waits out a 15 s tick, so asserting only `ended` would pass
	// without the teardown and miss the write-after-end crash entirely.
	check(
		"dropping a stalled client stops its heartbeat",
		armed && stalledRes.ended === true && stalledRes[marker] === undefined,
		`armed=${armed} ended=${stalledRes.ended} tornDown=${stalledRes[marker] === undefined}`,
	);

	// A class is capped: every member costs a frame write on every emit, so a caller
	// rotating prefix ids must not be able to make each frame O(invented ids).
	events.emit("cap", { type: "user_prompt", text: "hi" });
	for (let i = 0; i < 200; i++) events.linkSessions(`cap-alias-${i}`, "cap");
	events.emit("cap", { type: "text_delta", text: "x" });
	const fanned = events.getMessages("cap-alias-199", 0).length > 0;
	check("an id class is capped rather than grown without bound", fanned === false, `alias199 fanned=${fanned}`);
	check("a client's own id still receives the canonical session's frames",
		events.getMessages("cap-alias-0", 0).length > 0, "first aliases should share the ring");

	events.linkSessions("ring-alias2", "ring-canon2");
	events.emit("ring-canon2", { type: "user_prompt", text: "x" });
	events.addClient("ring-alias2", fake, false, null);
	check("a client on the alias holds the whole class open", events.dropSession("ring-canon2") === false);
}

await bridge.close();
rmSync(workDir, { recursive: true, force: true });

console.log(failures === 0 ? "\nSMOKE PASS" : `\nSMOKE FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
