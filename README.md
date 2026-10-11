# omp-terminal — Even G2 Terminal Mode for oh-my-pi

Run **oh-my-pi (omp)** coding sessions on Even Realities **G2** smart glasses.
The bridge speaks the stock `@evenrealities/even-terminal` HTTP/SSE protocol, so
the **unmodified Even App** (Terminal Mode) pairs with it by scanning a QR — no
sideloading, no re-pairing.

```
G2 glasses ──BLE──> Even App (phone) ──HTTP/SSE──> omp-terminal :3456 ──NDJSON──> omp
```

Two ways to drive omp:

| Mode | What it does |
|---|---|
| **Owned** | The bridge spawns `omp --mode rpc-ui` per session and owns the process. Works standalone. |
| **Attach** | The bridge steers an interactive omp TUI already running under `tmux` (`send-keys` + pane scraping). The desk agent stays the sole writer of its transcript. |

Attach wins when a session id matches a live tmux-hosted omp pane; otherwise the
bridge spawns an owned child, resuming the transcript when one exists.

## Requirements

- **Node ≥ 18** (no dependencies).
- **omp** on `PATH` (verified against v18.8.7) — `--mode rpc-ui` and the RPC wire
  are the integration surface.
- **tmux** for attach mode.
- **Even G2 + R1 ring** paired through the Even app; the phone must reach the
  bridge host — same Wi-Fi, Tailscale, or a tunnel.
- `qrencode` (optional) to print the scannable pairing QR.

## Install

```bash
git clone <this repo> omp-terminal && cd omp-terminal
node bin/omp-terminal.js --help      # no install step; the CLI is a plain Node script
```

Optionally link it:

```bash
npm link        # then: omp-terminal
```

## Run

```bash
omp-terminal
```

Prints the pairing QR:

```
  ██  ████████     omp-terminal v0.1.0 (oh-my-pi bridge)
  ████             Local:  http://localhost:3456
  ██  ████████     LAN:    http://192.168.1.42:3456
  ████             Token:  a1b2c3d4...9f0e
  ██  ████████     CWD:    /home/you/project
```

Scan it in the Even App → **Terminal Mode**. The QR carries
`https://<host>:3456?token=<token>&defaultProvider=claude`.

### What to pick in the app (it only offers claude/codex)

The Even App's Terminal Mode picker is a fixed list — **claude / codex** — built
against the stock server's `SUPPORTED_PROVIDERS`. That list is a
*wire vocabulary*, not a description of what runs on the host.

**Choose either one; both work.** This bridge ignores the `provider` field on
every request and always drives omp. Verified: `GET /api/sessions?provider=claude`
and `?provider=codex` both return 200, and a prompt posted with
`provider: "claude"` runs normally.

By default the bridge also *reports* `claude` on the wire (in sessions, status,
results, and `/api/info`), matching the reference bridge that was validated live
against real glasses — so nothing downstream rejects an unknown name. The real
backend is always named separately:

```json
GET /api/info   → { "provider": "claude", "extra": { "backend": "omp", ... } }
GET /healthz    → { "ok": true, "provider": "claude", "backend": "omp" }
```

Override with `--provider-label codex` (or `claude-sync`) if you prefer the other
row in the picker; it changes only the label, never the behavior.

Common flags:

```bash
omp-terminal --port 8080              # different port
omp-terminal --token mytoken123       # stable token so glasses never re-pair
omp-terminal --cwd ~/project          # workspace for new sessions
omp-terminal --tailscale              # advertise the Tailscale IPv4
omp-terminal --no-attach              # owned sessions only
omp-terminal --approval-mode yolo     # always-ask | write | yolo
omp-terminal --expose pinggy          # public WAN tunnel + second pairing QR
```

Run the foreground server yourself; stop it with `Ctrl+C`. It does not install a
background service.

### The pairing token persists

On first run the token is generated and saved to `~/.omp-terminal/config.json`
(mode `0600`); every later start reuses it, so **the glasses stay paired across
restarts**. The banner shows where the token came from:

```
  Full token: a7c353ddb8b3914a58516a98fc90db68  (config)
```

`(config)` = reloaded from disk · `(generated)` = new, just saved · `(flag)` /
`(env)` = supplied by `--token` / `BRIDGE_TOKEN`. Precedence: flag > env >
saved config > generated-and-saved.

A public tunnel is the one thing that does **not** survive a restart: pinggy and
cloudflare quick tunnels mint a fresh hostname each run, so the QR URL changes
even though the token does not. If a previous pairing stops working, compare the
`Full token` line before re-pairing — a changed token means the running instance
was started with an explicit `--token` or `BRIDGE_TOKEN` override.

## WAN access (public tunnels)

`--expose <provider>` starts a quick public tunnel on the same port and prints a
**second pairing QR** for the public URL, so the glasses can reach the bridge
from any network — no Tailscale required:

```bash
omp-terminal --expose cloudflare   # no account needed
omp-terminal --expose pinggy       # no account needed (system ssh)
omp-terminal --expose bore         # self-hostable
omp-terminal --expose ngrok        # free account + authtoken required
```

| provider | program | account | notes |
|---|---|---|---|
| `cloudflare` | `cloudflared` | none | prints `https://<words>.trycloudflare.com` |
| `pinggy` | `ssh` | none | 60-minute free tunnels; prints `*.pinggy-free.link` / `*.free.pinggy.net` |
| `bore` | `bore` | none | self-hostable relay (`bore.pub`) |
| `ngrok` | `ngrok` | required | needs `ngrok config add-authtoken <TOKEN>` |

Override the executable path with `CLOUDFLARED_PROGRAM_PATH`,
`PINGGY_PROGRAM_PATH`, `BORE_PROGRAM_PATH`, or `NGROK_PROGRAM_PATH`.

**A tunnel only works if this host can reach the provider's edge.** `cloudflare`
runs a preflight check and reports the reason instead of hanging; on a host whose
traffic is intercepted by a transparent TLS proxy (a VPN/tun that substitutes
certificates) cloudflared's edge handshake fails and no tunnel can form — use
`pinggy` there. See `docs/PROTOCOL.md` §3 for the failure signature.

The tunnel URL is **a public address guarded only by the pairing token** — anyone
with the URL can prompt your agent. Treat the QR as a secret, and stop the
server (`Ctrl+C`) when you are done; killing the process also stops the tunnel.

## What you can do from the glasses

- **Pick a session** — the native list merges live bridge sessions, tmux-hosted
  desk sessions, and every on-disk omp transcript (newest first).
- **See the answer** — assistant text renders through the four-part
  paint-and-persist sequence and is committed from the `result` frame, so it
  stays on the lens instead of flashing and clearing.
- **Dictate a prompt** — lands as a real omp turn. A prompt dictated while the
  agent is busy is queued as a follow-up, not dropped.
- **Answer approvals** — `write`/`bash` prompts render on the lens as an
  `Allow tool: …` card with Yes / No. (Owned mode: `--approval-mode always-ask`.)
- **Answer agent questions** — `ask` dialogs arrive as the app's native question
  UI; answer by voice by label ("Blue") or by number ("two").
- **Interrupt** a runaway turn.

## Endpoints (even-terminal contract)

All under `/api`, authenticated by `Authorization: Bearer <token>` or `?token=`:

`GET /api/events` (SSE) · `GET /api/sessions` · `GET /api/sessions/:id/history` ·
`GET /api/info` · `GET /api/status` · `GET /api/messages` · `GET /api/update-check` ·
`POST /api/prompt` · `POST /api/permission-response` · `POST /api/question-response` ·
`POST /api/interrupt`

`GET /healthz` is the only unauthenticated route.

## Config

All optional; flags override environment variables.

| env | default | meaning |
|---|---|---|
| `BRIDGE_TOKEN` | saved config, else generated | fixed value = glasses never re-pair across restarts |
| `PORT` / `BIND_HOST` | `3456` / `0.0.0.0` | `0.0.0.0` = reachable over the LAN/tailnet |
| `PROJECT_DIR` | cwd | workspace for new sessions |
| `OMP_TERMINAL_OMP_COMMAND` | `omp` | omp executable |
| `OMP_TERMINAL_APPROVAL_MODE` | `always-ask` | `always-ask` \| `write` \| `yolo` |
| `OMP_TERMINAL_SESSIONS_ROOT` | `~/.omp/agent/sessions` | omp transcript root |
| `OMP_TERMINAL_ATTACH` | `true` | list and steer tmux-hosted omp TUIs |
| `OMP_TERMINAL_PROVIDER_LABEL` | `claude` | provider name on the wire (`claude` \| `claude-sync` \| `codex`) |
| `OMP_TERMINAL_BUSY_WINDOW_MS` | `120000` | freshness window before a trailing unfinished turn reads idle |
| `OMP_TERMINAL_TAIL_INTERVAL_MS` | `500` | attach-mode transcript poll interval |
| `OMP_TERMINAL_LOG_LEVEL` | `info` | `debug` \| `info` |
| `EVEN_ALLOW_CORS` | `0` | allow cross-origin browser requests |

A `.env` file in the working directory is read at startup (real environment
variables take precedence).

## Verify

```bash
npm run check        # every file parses (no dependencies, no build)
npm run test:ci      # contract tests — what CI runs
npm run test:attach  # pane-scraping unit tests (also CI)
npm run test:live    # full loop: real omp child + real tmux TUI
```

`npm run test:ci` drives the real HTTP surface and asserts the Even wire
contract: 401 without a token, session listing, the four-part paint-and-persist
burst on the SSE ring, the canonical session id in the `202` response, history,
and the `ask` question round-trip. It needs no `omp` and no network.

`npm run test:live` adds the parts that need a real agent: a live `omp` child for
the smoke tests, and for attach a tmux-hosted omp TUI is listed as a session, a
dictated prompt is submitted with `send-keys`, its approval box surfaces as a
`permission_request` frame, answering through the bridge approves the desk
dialog, and the desk agent writes the file.

## Verify it on the glasses

1. Run `omp-terminal` on the host; confirm the QR and the `Token:` line.
2. Open Even App → Terminal Mode → scan the QR.
3. Pick the session (or start one from the desk): `tmux new -s desk` + `omp`.
4. Dictate "list the files here"; the answer should paint and **stay** on the
   lens, then the session returns to idle.
5. Ask for a `write` with `--approval-mode always-ask`; approve with the ring.

## Docs

- [`docs/PROTOCOL.md`](docs/PROTOCOL.md) — both wire contracts with evidence
  (frame inventory, paint-and-persist rules, lens glyph limits, omp RPC frames,
  attach-mode scraping) and reproduction commands.
- [`docs/EVIDENCE.md`](docs/EVIDENCE.md) — claim-to-source index for every
  protocol statement, with the exact commands to re-derive each one.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — checks, workflow, and what a good change
  looks like here.

## Layout

```
bin/omp-terminal.js      CLI entry
src/cli.js               flags, host resolution, pairing QR banner
src/server.js            HTTP routes, auth, session manager (owned + attach)
src/events.js            SSE ring, replay cursors, heartbeats, id linking
src/frames.js            Even frame constructors + lens truncation
src/expose.js            quick public tunnels (cloudflare, pinggy, bore, ngrok)
src/provider.js          owned omp child; frame mapping; answer parsing
src/attach.js            tmux-hosted TUI steering; pane dialog scraping
src/omp-rpc.js           NDJSON client for `omp --mode rpc-ui`
src/sessions.js          omp transcript discovery and history
src/store.js             persisted config (stable pairing token, mode 0600)
src/config.js            flag/env/store precedence
scripts/check-syntax.mjs parse every source and test file
test/smoke.mjs           contract tests (no omp) + live smoke (with omp)
test/attach.mjs          pane-scraping unit tests + live tmux round trip
docs/                    protocol and evidence notes
```

## License

[MIT](LICENSE)
