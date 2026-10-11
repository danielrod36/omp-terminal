# Evidence index

Where each protocol claim comes from, so it can be re-checked independently.

## Shipped artifact (north side)

`@evenrealities/even-terminal@0.10.5`, unpacked to a scratch directory:

```bash
npm pack @evenrealities/even-terminal@0.10.5 && tar xzf evenrealities-even-terminal-0.10.5.tgz
```

| Claim | File | Detail |
|---|---|---|
| Route inventory | `package/dist/routes/core.js` | 14 `/api/*` routes |
| Auth model | `package/dist/index.js` | `auth` middleware on `/api` only; Bearer or `?token=` |
| SSE ring + replay | `package/dist/routes/events.js` | 500-entry ring, 15 s heartbeat, `needReplay` |
| Paint-and-persist | `package/dist/claude/session.js` | `processStreamEvent` / `emitResult` |
| Frame types | `package/dist/claude/session.js` | `status`, `text_delta`, `result`, `user_prompt`, `tool_start/end`, `user_question`, `permission_request`, `running_stats` |
| QR contents | `package/dist/startup/common.js` | `buildClientQuery`: `token` + `defaultProvider` |
| Provider contract | `package/dist/claude/provider.js` | `listSessions`, `getSessionStatus`, `getInfo`, `getHistory` |
| Codex parity | `package/dist/codex/session.js` | same frame set, `provider: "codex"` |

Static structure confirmed with REA (`analyze_javascript_application` over the
extracted tree): 40 parsed JS files, 440 findings, `11` request relations, `4`
child-process relations, zero parse failures.

## Live-verified reference bridge

`https://github.com/Luc3as/even-g2-gsd-bridge` — a third-party bridge that
attaches the stock app to GSD-PI. Its `docs/PROTOCOL.md` records the same
paint-and-persist sequence, the `tool_result` warning, the replay-cursor
priority, and the lens glyph table, all validated live on 0.8.1. Its
`src/server/events.ts` `emitText()` is the reference emitter.

## omp RPC (south side)

omp v18.8.7, binary on `PATH`; source types from the packed npm tarball.

| Claim | Evidence |
|---|---|
| `ready` -> `negotiate_protocol` -> v2 | live probe transcript |
| `prompt` -> `agent_start`/`turn_*`/`message_*`/`prompt_result` | live probe |
| `message_update.assistantMessageEvent` subtypes | live probe: `thinking_start/delta/end`, `text_start/delta/end`, `toolcall_*` |
| Tool frames | live probe: `tool_execution_start{toolCallId,toolName,args,intent}`, `_end{result,isError}` |
| Approval as `extension_ui_request{method:"select"}` | live probe: `"Allow tool: write\nPath: …"`, options `["Approve","Deny"]`; answering Approve let the write run |
| `ask` requires `set_ask_dialog` | live probe: `{"type":"set_ask_dialog","enabled":true}` then `method:"ask"` with `answers:[{id,selectedOptions}]` |
| `--mode rpc` disables UI/`ask` | `src/tools/index.ts` + `src/sdk.ts` `canPromptUser`; error `Built-in tool unavailable in this session: ask` |
| Busy rejection | live probe: `"Agent is already processing. Use steer() or followUp()…"` |
| Queue + abort | live probe: `queue_update`, `steer`, `abort` -> `turn_end.stopReason="aborted"` |
| Canonical id + transcript path | live probe: `get_session_stats` -> `{sessionId, sessionFile}` — held across `--resume` |
| Resume across cwd | live probe: `--resume <bare-id>` from a different cwd restored the session |

## Attach mode

| Claim | Evidence |
|---|---|
| Pane identifies an omp TUI | `tmux list-panes -F '#{pane_current_command}'` -> `omp` |
| Prompt injection | `tmux send-keys -t <s> -l '<text>'` then separate `send-keys -t <s> Enter`; the trailing literal arg otherwise gets typed |
| Approval box shape | live `capture-pane`: `╭─ Allow tool: write ─…` with `❯ Approve` / `Deny` |
| `Enter` approves | live: file written after `Enter` |
| Transcript location | `<sessionsRoot>/<encoded-cwd>/*.jsonl`; `pane_current_path` -> encoded bucket |

## Bridge self-test

`test/smoke.mjs` (owned path) and `test/attach.mjs` (attach path) re-derive the
north-side contract from the running bridge rather than trusting these notes.
