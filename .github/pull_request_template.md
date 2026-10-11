## What changed

<!-- One or two sentences. What behavior is different after this PR? -->

## Why

<!-- The problem, or the protocol fact that forced this. Link an issue if one exists. -->

## How it was verified

Every claim in this repo is backed by a command that was actually run. Paste the
output, or say exactly which command you ran and what it printed.

- [ ] `npm run check` — every file parses
- [ ] `npm run test:ci` — contract tests (auth, SSE frames, prompt round-trip, ask round-trip)
- [ ] `npm run test:attach` — pane-scraping unit tests

If this touches the live paths, the full loop (needs `omp`, and `tmux` for attach):

- [ ] `npm run test:live`

## Wire-contract checklist

Tick every line this PR touches. A change here can break the app silently —
the firmware drops frames it does not recognize, with no error and no log.

- [ ] **Frames** — any new/changed `type` is one the firmware knows
      (`status`, `text_delta`, `result`, `user_prompt`, `tool_start`/`tool_end`,
      `user_question`, `question_answer`, `permission_request`/`permission_result`,
      `task_progress`, `running_stats`, `info`, `error`, `notification`)
- [ ] **Paint sequence** — assistant text still emits
      `status:text_start` → bare `text_delta` → `status:text_end` → `result`
- [ ] **`sessionId`** — still present on every `status` and `result` frame
- [ ] **Provider label** — responses still report a name the app knows
      (`claude` / `claude-sync` / `codex`), never an invented one
- [ ] **Auth** — new routes sit behind the token check; only `/healthz` is open
- [ ] **Lens budget** — new on-screen text is truncated for 576×288 and uses
      monochrome-safe glyphs only

Not sure? Read [`docs/PROTOCOL.md`](../docs/PROTOCOL.md) before changing the emit path.

## Notes for the reviewer

<!-- Anything surprising, any deliberate tradeoff, anything you are unsure about.
     Say what you could NOT verify — a known gap is more useful than silence. -->
