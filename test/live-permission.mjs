// Live permission approval through the bridge: does a real omp approval card get
// surfaced, and does answering "allow" actually let the gated tool run?
const R = new URL("..", import.meta.url).pathname;
const { execFileSync } = await import("node:child_process");
const { rmSync, mkdirSync, readFileSync, existsSync } = await import("node:fs");
const { loadConfig } = await import(`${R}/src/config.js`);
const { createBridge } = await import(`${R}/src/server.js`);
const { configureLog } = await import(`${R}/src/log.js`);
configureLog({ level: "warn" });

const TMUX = `permlive-${Date.now().toString(36)}`;
const workDir = `/tmp/${TMUX}`;
rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => { ok ? pass++ : fail++; console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`); };

execFileSync("tmux", ["new-session", "-d", "-s", TMUX, "-c", workDir, "-x", "150", "-y", "45", "omp --approval-mode always-ask"]);
await new Promise(r => setTimeout(r, 11000));

const cfg = loadConfig({ flags: { port: 0, token: "pl", attach: true, cwd: workDir, tailIntervalMs: 300 } });
const bridge = createBridge(cfg);
await bridge.listen();
const base = `http://127.0.0.1:${bridge.server.address().port}`;
const auth = { Authorization: "Bearer pl", "Content-Type": "application/json" };

const list = await (await fetch(`${base}/api/sessions`, { headers: auth })).json();
const entry = list.sessions.find(s => s.attach?.tmuxSession === TMUX);
check("desk pane listed", Boolean(entry), JSON.stringify(list.sessions.slice(0, 2)));
if (!entry) { execFileSync("tmux", ["kill-session", "-t", TMUX]); await bridge.close(); process.exit(1); }
const sid = entry.id;

const stream = await fetch(`${base}/api/events?sessionId=${sid}&needReplay=true`, { headers: auth });
const reader = stream.body.getReader();
const frames = [];
const pump = (async () => {
  const dec = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const l of dec.decode(value, { stream: true }).split("\n")) if (l.startsWith("data: ")) { try { frames.push(JSON.parse(l.slice(6))); } catch {} }
  }
})();

// Ask for a gated write so omp raises its Approve/Deny card on the pane.
const target = `${workDir}/approved.txt`;
await fetch(`${base}/api/prompt`, {
  method: "POST", headers: auth,
  body: JSON.stringify({ text: `Use the write tool to create ${target} containing the word ok`, sessionId: sid }),
});

// Wait for the card to paint and for the bridge to announce it.
const deadline = Date.now() + 150000;
let announced = null;
while (Date.now() < deadline) {
  await new Promise(r => setTimeout(r, 1500));
  const pane = execFileSync("tmux", ["capture-pane", "-p", "-t", TMUX]).toString();
  if (!announced) announced = frames.find(f => f.type === "permission_request");
  if (announced && /Allow tool/.test(pane)) break;
}

check("a permission_request was announced", Boolean(announced), JSON.stringify(announced && { toolName: announced.toolName, options: announced.options?.map(o => o.text) }));
check("the announced rows match the desk card", JSON.stringify(announced?.options?.map(o => o.text)) === JSON.stringify(["Approve", "Deny"]), JSON.stringify(announced?.options?.map(o => o.text)));

const pane = execFileSync("tmux", ["capture-pane", "-p", "-t", TMUX]).toString();
check("the desk shows an Allow tool card", /Allow tool/.test(pane), pane.split("\n").find(l => /Allow tool/.test(l))?.slice(0, 70) ?? "");

// Answer "allow" the way the glasses do.
const ans = await fetch(`${base}/api/permission-response`, {
  method: "POST", headers: auth,
  body: JSON.stringify({ sessionId: sid, decision: "allow" }),
});
check("permission-response accepted", ans.status === 200, `${ans.status} ${JSON.stringify(await ans.json().catch(() => null))}`);

// The proof: the gated tool actually ran.
let written = false;
for (let i = 0; i < 60 && !written; i++) {
  await new Promise(r => setTimeout(r, 1000));
  written = existsSync(target);
}
check("the approved tool actually ran (file created)", written, target);

reader.cancel().catch(() => {});
execFileSync("tmux", ["kill-session", "-t", TMUX]);
await bridge.close();
console.log(fail === 0 ? `LIVE PERM PASS (${pass} passed)` : `LIVE PERM FAIL (${fail})`);
process.exit(fail === 0 ? 0 : 1);
