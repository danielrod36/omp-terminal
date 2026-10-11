# Contributing

This project sits between two protocols it does not own: the Even App's
HTTP/SSE contract and omp's RPC wire. Most bugs are a silent mismatch with one
of them, so the workflow below is built around proving behavior, not around
running tests that merely pass.

Read [`docs/PROTOCOL.md`](docs/PROTOCOL.md) before touching the emit path or the
frame constructors. [`docs/EVIDENCE.md`](docs/EVIDENCE.md) maps every protocol
claim to its source.

## Setup

Node 18+ and nothing else — there are no dependencies and no build step.

```bash
git clone <repo> && cd omp-terminal
node bin/omp-terminal.js --help
```

Optionally put it on `PATH`:

```bash
ln -sfn "$PWD/bin/omp-terminal.js" ~/.local/bin/omp-terminal
```

## Checks

| command | what it proves | needs |
|---|---|---|
| `npm run check` | every file parses | Node |
| `npm run test:ci` | contract tests: auth gate, session list, SSE paint-and-persist burst, canonical session id, history, `ask` round-trip | Node |
| `npm run test:attach` | the `Allow tool:` pane scraper against real captured pane text | Node |
| `npm run test:live` | the whole loop against a real omp child and a real tmux-hosted TUI | Node, `omp`, `tmux` |

CI runs the first three. `test:live` is manual because it needs a local `omp`
and a tmux server; run it before merging anything that touches session
management, the RPC client, or attach mode.

## Workflow

`main` is protected: every change lands through a pull request with CI green.
Direct pushes are blocked, including your own.

```bash
git switch -c fix/short-description
# work
npm run check && npm run test:ci && npm run test:attach
git commit -am "fix: what changed"
git push -u origin fix/short-description
gh pr create --fill
```

## What a good change looks like here

**Prove it, don't assert it.** Every behavior claim in this repo traces to a
command that was run. If you say the answer paints, show the frames. If you say
a tunnel works, show the response over the public URL.

**Prefer evidence over plausibility.** "The port is open" proves nothing about
whether a TLS handshake will succeed. Two documented traps in this codebase came
from exactly that shortcut:

- A `status:text_start` without `sessionId` never arms text rendering — the
  frame arrives, the lens stays blank.
- cloudflared's edge can be reachable by plain TLS clients (which skip
  verification) while its own verified handshake fails behind a transparent
  proxy.

**Fail loudly, never silently.** The firmware drops unknown frames with no
error. Prefer refusing to start, or logging a warning, over emitting something
that quietly does nothing.

**Record what you could not verify.** A stated gap is more useful than
confidence the code has not earned. `docs/PROTOCOL.md` marks measured facts and
their caveats separately.

## Style

Match the surrounding code. Two project-specific points:

- No runtime dependencies. CI fails the build if `package.json` gains one; the
  bridge must stay installable with zero network access.
- Comments explain *why*, especially where a value looks oddly specific — most
  of those are protocol constraints that were painful to find.
