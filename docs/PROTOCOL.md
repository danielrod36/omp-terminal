# omp-terminal wire protocol

Two protocols meet in this bridge. Every claim below was verified against the
shipped artifacts and live processes; the reproduction steps are included.

- **North side — Even App ⇄ bridge.** The stock Even App (Terminal Mode) speaks
  the `@evenrealities/even-terminal` HTTP/SSE contract. Frames are rendered on
  the G2's 576×288 monochrome canvas.
- **South side — bridge ⇄ omp.** The bridge drives `omp --mode rpc-ui` over
  NDJSON on stdin/stdout.

```
G2 glasses ──BLE──> Even App (phone) ──HTTP/SSE──> omp-terminal :3456 ──NDJSON──> omp --mode rpc-ui
```

---

## 1. North side — the Even contract

### 1.1 Auth and pairing

`/api/*` requires `Authorization: Bearer <token>` **or** `?token=<token>`.
`/healthz` is the only unauthenticated route, matching the stock server's
`auth` middleware mounted on `/api` only.

The app is paired by scanning a QR carrying:

```
http://<host>:<port>?token=<token>&defaultProvider=<provider>
```

`defaultProvider` is how the app learns which provider the host runs; we stamp
`omp`. (Stock: `dist/startup/common.js` `buildClientQuery`.)

### 1.2 Routes consumed by the app

| Route | Contract |
|---|---|
| `GET /api/events?sessionId=&needReplay=` | SSE stream; `id:`/`data:` frames, 500-entry ring, 15 s `:heartbeat`, `:ok` preamble |
| `GET /api/sessions?limit=&cwd=` | `{ sessions: [{ id, title, timestamp, cwd, provider, status }] }` |
| `GET /api/info` | `{ account, model, version, provider }` |
| `GET /api/sessions/:id/history?limit=` | `{ history: [{ role, text }] }` |
| `POST /api/prompt` | `{ text, sessionId?, cwd? }` → `202 { ok, sessionId, provider }` |
| `POST /api/permission-response` | `{ sessionId, decision: allow \| allowAlways \| deny }` |
| `POST /api/question-response` | `{ sessionId, answer }` |
| `POST /api/interrupt` | `{ sessionId }` |
| `GET /api/status?sessionId=` | `{ state: busy \| idle \| awaiting, sessionId, provider }` |
| `GET /api/messages?sessionId=&after=` | ring poll fallback |
| `GET /api/update-check` | `{ packageName, currentVersion, newestVersion, updateAvailable }` |

### 1.3 The paint-and-persist sequence

The firmware understands a fixed, small set of frame types and **silently drops
anything else**. Assistant text renders *only* as a delta stream bracketed by
status frames, and the persisted on-screen answer is **committed from the
`result` frame** — the delta alone flashes and clears.

```
status:text_start  (sessionId REQUIRED)
text_delta         (the whole answer, bare — no ts, no icon)
status:text_end    (sessionId REQUIRED)
result             (sessionId + text REQUIRED)  ← commits the message
status:idle
```

1. **`sessionId` on every status frame.** The glasses key the render buffer off
   it; a `text_start` without one never arms text rendering, so the body stays
   blank even though deltas arrive.
2. **`text_delta` must be bare.** A stray field between `busy` and the answer's
   `text_start` corrupts the render buffer.
3. **The finalizing `result` frame.** Streamed deltas are a transient preview;
   without `result` the answer flashes then clears on `idle`. Stats may ship as
   zero (shape over accuracy).

Other frame types the firmware understands: `user_prompt`, `tool_start` /
`tool_end`, `user_question`, `question_answer`, `permission_request` /
`permission_result`, `status`, `info`, `task_progress`, `running_stats`,
`error`, `notification`.

**Do not emit `tool_result` / `tool_call`.** The glasses render latest-frame-wins,
so a trailing tool result buries the answer that just painted.

### 1.4 Questions and the `awaiting` state

The app keys its "awaiting" mode off the `user_question` frame: only then does
the mic answer the question *directly* (POST `/api/question-response`) instead of
being read as an interrupt. Question shape:

```json
{"type":"user_question","questions":[{"question":"…","header":"",
  "multiSelect":false,"options":[{"label":"…","description":"","preview":""}]}],
 "toolUseId":"…","sessionId":"…"}
```

Answers come back as a JSON object keyed by the question text (`{"Which colour?":"Blue"}`),
a bare dictation string, or an option index. `parseQuestionAnswer()` accepts all
three, preferring label match, then 1-based index, then case-insensitive label.

### 1.5 SSE ring, replay, and the dark window

The glasses drop the SSE connection roughly every 30 s and are frequently dark
exactly when an answer lands. Replay cursor priority:

1. `Last-Event-ID` header (standard `EventSource` auto-reconnect cursor),
2. `needReplay=true` (explicit full-history load),
3. `lastDeliveredId` (the dark-window gap).

Without rule 3, a frame broadcast while the glasses were disconnected is lost
forever. A content frame (`text_delta` / `result`) broadcast with no live client
is logged as a warning, not silently swallowed.

A ring is freed once nothing can read it again — no attached client, and no live
id in its equivalence class — because a fresh conversation mints a fresh id and a
long-lived bridge would otherwise retain one 500-frame ring per conversation ever
started.

A client that completes the handshake and then stops reading never trips
`close`, so it is dropped once more than 4 MiB is buffered for it, during the
replay burst as well as live. Nothing is lost: the ring keeps the frames and a
reconnect replays them from the cursor above, which is the same path a dark-lens
reconnect already takes.

### 1.6 Pairing durability

The stock server persists a pairing token in `~/.even-terminal/config.json`
(`bin/config.js`, `DEFAULT_CONFIG_PATH`, written `0600`) and its first-run wizard
states the token "remains stable across restarts". A client that stores the QR's
token therefore keeps working across host restarts.

A bridge that mints a fresh random token per boot breaks that expectation
silently: the wearer re-pairs, the token changes again, and the session looks
flaky with no visible error. `omp-terminal` matches the stock behaviour —
generate once, persist to `~/.omp-terminal/config.json` (`0600`), reuse — and
reports the provenance in the banner (`(config)` / `(generated)` / `(flag)` /
`(env)`).

The store is written to a sibling temp file and renamed into place, so a crash or
a full disk during a save cannot leave a truncated file whose parse error would
be swallowed and whose next boot would rotate the token — the failure this
section exists to prevent.

Quick tunnels are the residue: pinggy and cloudflare **quick** tunnels mint a new
hostname per run (`*.free.pinggy.net`, `*.trycloudflare.com`), so the public URL
changes even though the token does not. Named Cloudflare tunnels or Tailscale
avoid that.

### 1.7 Lens glyph limits (576×288, monochrome BMP font)

Only monochrome BMP glyphs render; colour emoji and dingbats become tofu boxes.

| category | safe | dead |
|---|---|---|
| arrows | `→` `▶` `»` `->` `=>` `>>` | — |
| bullets | `•` `●` `○` `*` `-` | `◦` |
| boxes | `▫` `■` `□` | `▪` `█` `░` |
| stars | `★` `☆` | — |
| lines | `─` `├` `←` `↑` `↓` | `│` `↳` |
| checks | — | `✓` `✗` `✔` `✘` (dingbats tofu) |
| emoji | — | all colour emoji tofu |

Prefer full-size variants for markers the wearer must notice: `▶` (U+25B6)
reads at lens size, `▸` (U+25B8) paints but is too small to serve as a marker.

---

## 2. South side — the omp RPC contract

Verified live against omp v18.8.7 (`omp --mode rpc-ui`).

### 2.1 Handshake and framing

stdout is newline-delimited JSON. The first frame is `ready`:

```json
{"type":"ready","protocolVersion":1,"supportedProtocolVersions":[1,2],
 "maxFrameBytes":1048576,"maxReassembledFrameBytes":67108864}
```

Commands are written to stdin as `{"id":"…","type":"…"}`; each is answered by a
`{"type":"response","id":"…","command":"…","success":true,"data":{…}}` frame.
Unsolicited frames (`agent_start`, `message_update`, `extension_ui_request`, …)
arrive interleaved.

**`--mode rpc` vs `--mode rpc-ui` matters.** Plain `rpc` sets `hasUI=false`,
which disables the `ask` tool and every dialog frame; only `rpc-ui` wires the UI
context. This bridge always uses `rpc-ui`.

### 2.2 Prompt lifecycle

| Frame | Carries |
|---|---|
| `agent_start` | turn begins |
| `turn_start` / `turn_end` | per-turn boundaries; `turn_end.message` has `usage` and `duration` |
| `message_start` / `message_end` | one user or assistant message, with `messageId` |
| `message_update` | streaming; see below |
| `tool_execution_start` | `toolCallId`, `toolName`, `args`, `intent` |
| `tool_execution_end` | `toolCallId`, `toolName`, `result`, `isError` |
| `prompt_result` | terminal frame per accepted prompt: `{status: completed \| aborted \| error, agentInvoked, sessionSettled}` |
| `session_settled` | the session went fully quiet |

`message_update.assistantMessageEvent` types: `thinking_start/delta/end`,
`text_start/delta/end`, `toolcall_start/delta/end`. **`text_delta.delta` is the
display source**; `text_end` carries the accumulated `content`.

### 2.3 Approvals and questions

An approval arrives as an `extension_ui_request`:

```json
{"type":"extension_ui_request","id":"…","method":"select",
 "title":"Allow tool: write\nPath: probe-out.txt\nContent:\nhello",
 "options":["Approve","Deny"]}
```

Answer with `{"type":"extension_ui_response","id":"…","value":"Approve"}`.
The `title` carries the stock "Allow tool: …" body, so it maps straight onto the
Even `permission_request` frame's `description`/`detail`.

`options` is `string[]` — plain labels, not objects — and the reply is the chosen
LABEL, which omp tests as `value === "Approve"` (read off the shipped 18.10.1
binary: `N.select(<Allow tool: …>, ["Approve","Deny"])`). The Even frame's `options`
carry `{text, key}` instead, where `key` stays the stock `allow`/`allowAlways`/`deny`
decision and `text` must be the label the wearer answered with, so the announce
mirrors the card's own rows rather than a fixed `Yes`/`No`. Verified end to end:
answering `allow` runs the gated tool (`test/live-permission.mjs`).

Do not confuse this with the option IDs `allow_once`/`allow_always`/`reject_once`/
`reject_always`. Those belong to a different path — a host `requestPermission` hook
that resolves the reply through a registry and throws `Tool permission response used
unknown option ID` — and are not what the rpc-ui `select` dialog offers.

An `ask` question arrives as `method:"ask"` (**only after the host opts in with
`{"type":"set_ask_dialog","enabled":true}`**; otherwise the tool degrades to
`select`/`editor` dialogs). Answer with:

```json
{"type":"extension_ui_response","id":"…",
 "answers":[{"id":"colour","selectedOptions":["Blue"]}]}
```

`selectedOptions` entries are validated against the offered labels and an
unknown label **fails the whole tool call** (`Ask dialog answer "colour"
selected unknown option "…"`). Free text — a dictated label that matches no
option — must travel as `customInput` instead:

```json
{"type":"extension_ui_response","id":"…",
 "answers":[{"id":"colour","selectedOptions":[],"customInput":"Chartreuse"}]}
```

Verified live: that shape resolves with `User provided custom input: Chartreuse`
and `isError: false`, while the `selectedOptions` form errors.

`confirm` resolves with `{"confirmed": true}`, `input`/`editor` with
`{"value": "…"}`. omp also emits `method:"cancel"` with a `targetId` when it
settles a dialog itself (abort or timeout): the host must close that dialog,
and a late answer to it is ignored.

### 2.4 Sessions, busy handling, and abort

- `get_session_stats` returns `{ sessionFile, sessionId, userMessages, … }` —
  the bridge learns the canonical transcript path from it.
- **The transcript file is created only when the session settles.** Measured:
  `get_session_stats` names the path immediately, but the file appears (with
  content) ~14 s after the prompt, at `session_settled`. A history read
  immediately after `result` therefore races the write, which is why the bridge
  falls back to its SSE ring for history until the file exists.
- A second `prompt` while busy is **rejected** with
  `"Agent is already processing. Use steer() or followUp() to queue messages"`.
  The bridge retries it as `follow_up` so a dictated second prompt is queued
  rather than lost.
- `steer` injects a mid-turn correction; `abort` ends the turn
  (`turn_end.stopReason = "aborted"`, `prompt_result.status = "aborted"`).
- Resume is `omp --resume <path-or-id>`; the path resumes across cwd.
- `omp --version` prints `omp/<semver>`; `/api/info` reports it as
  `model: "omp <semver>"`.

### 2.5 Attach mode (desk/TUI sessions)

Verified live: a tmux pane whose `pane_current_command` is `omp` hosts the TUI.

- Prompt injection: `tmux send-keys -t <session> -l '<text>'` then `Enter`.
- The approval menu renders as a bordered box headed `Allow tool: <name>` with an
  `Approve` / `Deny` list and a `\uf054` focus marker on the highlighted row;
  `Enter` submits the highlighted row, `Down`/`Up` move it.
- An `ask` renders as a bordered `╭─ Ask ─…` box: the question, then one row per
  option as `\uf054 \uf10c <label>`. `\uf054` is the focus marker; the option
  marker is a private-use glyph that differs between Nerd Font revisions
  (`U+F096`, `U+F10C` both observed live).
- The block's marker is decided by the EMPTY markers its rows carry, on a strict
  lead only, because the marker is a constant function of the dialog's mode. Any
  other private-use glyph is a stray — an icon inside a wrapped question line —
  and admitting one would inflate `focusRow` and shift every dictated index. When
  the block renders no known marker at all the dialog uses an alternate icon set;
  its checked-variant glyph cannot be named, so it is indistinguishable from a
  stray and every row is kept rather than risking the loss of a real option. All
  twelve live captures use only the known markers.
- The dialog's key-hint bar distinguishes the two modes: `toggle` for
  multi-select, `select` for single-select — both draw the same marker when
  unchecked, so the hint bar is the only reliable signal.
- Answering single-select is `Down`/`Up` to the row, then `Enter`. Multi-select
  toggles the focused row with `Space` and submits with `Enter`.
- A closed dialog leaves a borderless echo box in the transcript (`╭─── Ask 1
  questions ─…`). It is not a live dialog: it has no focus marker and no framed
  option rows, and the parser requires both.
- Reads come from the transcript the TUI appends to, located via
  `pane_current_path` → `<sessionsRoot>/<encoded-cwd>/`. Line offsets are bytes
  (the transcript can contain non-ASCII), and a fresh assistant record is
  rewound to so a turn finishing around a transcript swap still paints.
- **Two TUIs in one cwd share one transcript.** Measured: starting a second
  `omp` in the same directory resumed the existing session file rather than
  minting a new one — both panes appended to the same bucket file. The "which
  pane owns this transcript" question is therefore moot for panes in one cwd:
  there is one conversation, and the newest file in the bucket is it. (A pane's
  open files cannot be used to disambiguate either: `omp` opens the transcript
  per append and holds no lasting descriptor.)

The bridge never owns the process in this mode: the desk agent stays the sole
writer of the transcript.

---

## 3. Provider vocabulary (which row to pick in the app)

The app's Terminal Mode picker offers only **claude** and **codex**, and the
stock server validates incoming provider values against a fixed set
(`SUPPORTED_PROVIDERS = ["claude", "claude-sync", "codex"]`, stock
`dist/session.js`). This is a *wire vocabulary*, not a statement about the host.

Consequences for a non-Claude backend:

- **Requests: pick either row.** The bridge never reads the `provider` field, so
  `claude` and `codex` behave identically. Verified: both return 200 on
  `/api/sessions`; a prompt posted with `provider: "claude"` runs unmodified.
- **Responses: report a known name.** The reference bridge — validated live
  against the glasses — reports `provider: "claude"` for its own GSD backend for
  exactly this reason. This bridge defaults to the same label (`--provider-label`
  overrides), and keeps the truth visible in `extra.backend` / `/healthz.backend`.
- **Pairing: seed a known name.** `defaultProvider` in the QR therefore carries
  the label, not `omp`.

## 4. WAN tunnels

`--expose <provider>` starts the tunnel and prints a second QR for the public
URL (`<public-url>?token=<token>&defaultProvider=<label>`). Providers and argv match
the stock bridge, plus `cloudflare`:

| provider | argv | URL source |
|---|---|---|
| `cloudflare` | `cloudflared tunnel --url http://127.0.0.1:<port> --no-autoupdate` | `https://<words>.trycloudflare.com` |
| `pinggy` | `ssh -T -o StrictHostKeyChecking=no -p 443 -R0:127.0.0.1:<port> a.pinggy.io` | `https://<name>.run.pinggy-free.link` |
| `bore` | `bore local <port> --to bore.pub` | `http://bore.pub:<port>` |
| `ngrok` | `ngrok http <port> --log=stdout --log-format=json` | JSON event `url` |

Verified live: pinggy served `/healthz`, `/api/sessions` (with the 401 gate on
missing/bad tokens), and a complete prompt round-trip (`text_start` →
`result` → `idle`, answer `"wan-ok"`) over the public URL.

### The intercepted-edge failure

cloudflared reaches its edge on `*.argotunnel.com:7844` over TLS and **verifies
the edge certificate**. A transparent TLS proxy in the path (observed here with
a `singbox_tun` VPN interface) terminates that connection and presents an origin
certificate instead:

```
subject=O=CloudFlare, Inc., OU=CloudFlare Origin CA, CN=CloudFlare Origin Certificate
issuer =C=US, ... OU=CloudFlare Origin SSL ECC Certificate Authority
Verify return code: 21 (unable to verify the first certificate)
```

The handshake then dies with `SSL alert number 42` and cloudflared reports
`Unable to establish connection with Cloudflare edge ... TLS handshake with edge
error: EOF`. It retries forever without a URL.

Distinguishing facts measured on the affected host:

- Plain `openssl s_client` / Node `tls` to `:7844` *do* connect (they skip chain
  verification) — so "the port is open" proves nothing.
- The same host's HTTP proxy (`:10808`) returns 200 for `trycloudflare.com` but
  never reaches the tunnel edge; `HTTPS_PROXY`/`ALL_PROXY` do not change
  cloudflared's path.
- `--protocol http2`, `--edge-ip-version 4`, and post-quantum off all fail the
  same way; `--pq` is already off by default.

Because of this, the `cloudflare` provider runs a `preflight()` TLS check and
fails fast with `edge presented an untrusted certificate (transparent TLS
proxy?)` rather than hanging. `pinggy` (plain SSH on 443) is unaffected and is
the working choice on such hosts.

## 5. Mapping table

| Even frame | omp source |
|---|---|
| `status:busy` / `idle` | `agent_start` → `session_settled` |
| `status:awaiting` | dialog frames (`select`, `ask`, `confirm`, `input`, `editor`) |
| `text_start` → `text_delta` → `text_end` → `result` | `message_update` (`text_start`/`text_delta`/`text_end`) |
| `user_prompt` | echo at `POST /api/prompt` time (the app shows the wearer's own words immediately) |
| `tool_start` / `tool_end` | `tool_execution_start` / `tool_execution_end`, summarized |
| `task_progress` | `todo` tool args (`op: init`) |
| `permission_request` | `extension_ui_request{method:"select"\|"confirm"}` |
| `question_answer` | `extension_ui_response` for `method:"ask"` |
| `running_stats` | periodic timer while busy |

## 6. Reproduction

```bash
# North side: shipped artifact + reference bridge
npm pack @evenrealities/even-terminal@0.10.5   # dist/routes/{events,core}.js, dist/claude/session.js
# https://github.com/Luc3as/even-g2-gsd-bridge docs/PROTOCOL.md (live-verified 0.8.1)

# South side: live probes
omp --mode rpc-ui --no-session --auto-approve      # ready → prompt → prompt_result
omp --mode rpc-ui --no-session --approval-mode always-ask --tools write
    # → extension_ui_request select "Allow tool: write" → respond Approve → tool runs
omp --mode rpc-ui --no-session --tools ask         # set_ask_dialog → method:"ask" → answers

# Attach side
tmux new-session -d -s desk -c <dir> 'omp --approval-mode always-ask'
tmux send-keys -t desk -l 'prompt text' \; send-keys -t desk Enter
tmux capture-pane -p -t desk                       # scrape the Allow-tool box

# This bridge
node test/smoke.mjs
```
