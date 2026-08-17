---
title: File map
status: shipped
relates_to: [architecture, decisions, development]
---

# Every file, and why it exists

The *what* of each file is recoverable by reading it. The *why* is not — several of these
decisions look arbitrary until you know what breaks without them.

Layers, outermost first: `hook/` and `mcp/` and `cli.ts` are entry points; `daemon/` is the
server; `core/` is pure logic with no I/O; `io/` is the only place that touches the filesystem
and environment.

---

## Entry points

### `src/hook/pretooluse.ts`
The PreToolUse shim. Reads the harness payload on stdin, decides, prints JSON, exits.

**Why it carries zero dependencies:** it spawns on *every intercepted tool call*, including when
the plugin is off. Its cold start is a tax on all your work. It bundles to ~5 KB importing only
`node:fs/promises`, `node:path` and `node:os` — no Zod, no Hono, no MCP SDK — and runs in ~22 ms.
`tsup.config.ts` sets `splitting: false` so it is a single self-contained file.

**Why every failure path ends in `allow`:** a broken plugin must degrade to plain Claude Code,
never to a blocked agent. Fail-closed here would mean a bad release bricks someone's editor.

### `src/mcp/server.ts`
The MCP server exposing `explain()` over stdio. A thin client of the daemon.

**Why the tool *description* carries the format rules** rather than leaving them to the schema:
the description is what the model reads before deciding how to call the tool. Schema enforces
shape; the description shapes behaviour.

**Why a rejected explanation returns `isError: true`:** a tool error lands in the model's context
and it corrects itself. That is the self-repair loop — no retry code of ours involved.

### `src/cli.ts`
`status`, `on`/`off`, `start`/`stop`, `pending`, `allow`, `write`, `stats`, `surface`.

**Why it renders pending work with the code inline:** under `surface: window` this *is* how the
learner reads and answers, so `pending` and `allow` are feature 4 rather than debugging aids.

### `src/hook/session-start.ts`
Runs at session start: makes sure the daemon is up, fetches the instruction text, prints it.

**Why it prints nothing but the instructions:** Claude Code injects a `SessionStart` hook's
stdout into the session as context. The previous version ran `cli.js start`, which printed
`"started"` — that string was going into every session's context. Anything this hook writes, the
model reads.

**Why it fails silently:** a session with no instructions still works; a session with a crashed
hook is worse.

---

## `src/daemon/` — the server

### `src/daemon/main.ts`
Process entry: take the lock, bind, publish the port file, clean up on exit.

**Why an `O_EXCL` lock file:** creation is atomic, so two daemons racing to start cannot both
win. The lock stores its pid, so a lock left by a crash is detected (`process.kill(pid, 0)`)
rather than deadlocking forever.

**Why an ephemeral port (`:0`) and a token file at `0600`:** a fixed port collides across
projects. The token authorises approving file edits, so it is owner-readable only, and the server
binds `127.0.0.1` — never `0.0.0.0`.

### `src/daemon/routes.ts`
The seven HTTP routes.

**Why `createApp(deps)` returns a Hono app instead of starting a server:** tests drive the entire
protocol through `app.request()` without binding a port or spawning anything. `test/loop.test.ts`
is the whole product in one fast test because of this seam.

### `src/daemon/tickets.ts`
The ticket store: content-addressed lookup, the state machine, the deferred-promise registry.

**Why tickets are keyed by `(sessionId, hash)` and not by hash alone:** two sessions making a
byte-identical edit must each get their own approval.

**Why `viewFor` returns the newest match:** a Map iterates in insertion order, so a bare `.find()`
handed back the *oldest* ticket for a file — which made a second change in one session get answered
with the first change's code, deterministically. Deterministically wrong is still wrong.

**Why a decision is *stored* on the ticket, not just signalled:** you can approve before the agent
gets round to retrying. `resolve()` fired with nobody listening is lost, and the retry would then
park until timeout. State survives the gap; a signal does not.

**Why approval is consumed:** an approval authorises exactly one tool call. Without consumption a
stale approval could wave through a later edit that merely hashes the same.

### `src/daemon/prompts.ts`
The strings sent back to the agent.

**Why these live in their own file:** they are *prompts*, not error messages. They are the only
thing steering the model back into the loop, and wording changes here change behaviour. They
deserve to be found, diffed and iterated on without hunting through route handlers.

`chooseHowToProceed` is the one that produces the learner's menu. It belongs here rather than in
the MCP server for the same reason as the rest — and because the real, *learned* MCP tool name is
available on this side, so the text can name the tool the agent should actually call.

### `src/daemon/instructions.ts`
Renders the text injected into every session.

**Why it lives in the daemon** and not in the hook that prints it: only the daemon knows the name
the harness actually gave our MCP tool (see `tool-name.ts`). Instructions that name a tool which
does not exist are worse than none.

**Why it is deterministic and short:** same input → byte-identical output, so it is
snapshot-testable; and it is prepended to the model's context in *every* session, so every extra
sentence costs tokens forever and dilutes attention. A test asserts it stays under 320 words.

### `src/daemon/tool-name.ts`
Learns the real name the harness gave our MCP tool.

**Why not just hardcode it:** the harness decides. Claude Code exposes plugin tools as
`mcp__plugin_<plugin>_<server>__<tool>` — verified against the installed Stripe plugin, whose
`authenticate` surfaces as `mcp__plugin_stripe_stripe__authenticate`. If the name in our denial
reason is wrong, we are pointing the agent at a tool that does not exist, and the loop silently
never closes. The shim sees `tool_name` for every call, so the daemon records the first one
matching `/__explain$/` and uses it verbatim thereafter. The computed default covers only the
very first call.

### `src/daemon/mode.ts`
Persistence wrapper around the mode file.

**Why it is separate from `core/mode-file.ts`:** this half needs `FsIo`; the other half is pure
and is imported by the dependency-free shim. Splitting them lets both be tested independently and
keeps Zod out of the shim's bundle.

### `src/daemon/log.ts`
Append-only JSONL, one file per session.

**Why JSONL and not a rewritten JSON blob:** appends survive a crash mid-write; a rewritten file
can be truncated. It is also replayable and greppable, and needs no native dependency.

**Why it swallows its own errors:** losing a log line must never cost you an edit.

---

## `src/core/` — pure logic, no I/O

### `src/core/canonical.ts`
Recursively sorts object keys, then hashes.

**Why:** a retried tool call is a *fresh generation* from the model, so key order can differ from
the first attempt. `sha256(JSON.stringify(x))` would produce different bytes for the same value,
the retry would never match its own ticket, and **every edit would be denied forever with no
visible cause**. This is the single likeliest place the design could have failed silently, which
is why `test/hash.test.ts` tests reordering explicitly.

### `src/core/lines.ts`
Turns a tool call into the lines that need explaining.

**Why only the *new* side of an edit:** you learn from what is being written, not from what is
being deleted. **Why blank lines are excluded:** demanding a note for them would be noise the
agent has to generate and you have to skip. **Why unknown tools return `null`:** anything we do
not understand passes through untouched.

### `src/core/explanation.ts`
Validates an explanation against the change it claims to explain.

**Why this exists at all:** it is what turns feature 1 from an aspiration into an invariant. A
prompt asking for every line is a request; validation at the tool boundary is a guarantee the
model structurally cannot skip.

**Why the error strings are so specific** (`"Missing notes for line(s): 2, 7"`): they are returned
verbatim to the agent, so each one has to say what to do next, not just what went wrong.

### `src/core/mode-file.ts`
Parses and resolves the on/off mode. Shared by daemon and shim.

**Why hand-rolled instead of Zod:** the shim imports it, and the shim carries no dependencies.

**Why the shim reads mode from disk at all**, rather than asking the daemon: it drops the cost of
`off` from ~50 ms (two round trips) to ~22 ms — the same as not having the plugin installed. It
also means the off switch keeps working when the daemon is wedged, which is exactly when you most
want it.

### `src/hook/outcome.ts`
Observational only: reports what the learner chose back to the daemon.

**Why it exists:** under `surface: prompt` the PreToolUse hook answers and exits, so it never
learns the outcome. Without this, `stats` would report zero decisions forever — a number that
still looks authoritative. `PostToolUse` means the tool ran; `PermissionDenied` means it did not.

**Why it is `async: true` in `hooks.json`:** it must never delay a tool call for a metric.

### `src/core/tutorial.ts`
Renders the markdown the learner types from.

**Why it is built for ~50 columns:** it is read in an editor split beside the code, not on a full
screen. Prose wraps at 60 and a test asserts no line is longer. The copyable code block is dropped
above 15 lines because past that it costs a row per line and pushes the notes off screen — and the
line-by-line section contains every line anyway.

### `src/core/open-editor.ts`
Decides *what* to launch; `try.ts` does the launching.

**Why the split:** every platform's argv can be asserted in tests without a window ever opening.
The tests assert *full argv*, not just the command name — an earlier version checked only the name
and so shipped a macOS branch that handed the file to Terminal as an argument instead of opening
an editor on it.
**Why the tutorial is opened first:** the last file opened takes focus, and focus has to land where
the learner types.

### `src/core/cleanup.ts`
Removes tutorial files by session, by age, or all.

**Why three levels:** a try that finishes cleans itself, a session that ends cleans its own, and
the age sweep catches sessions that were killed rather than closed.

### `src/hook/session-end.ts`
Asks the daemon to clean this session's tutorials.

**Why it is so tight-lipped:** `SessionEnd` hooks share a small timeout budget, and nothing here
is worth delaying a shutdown for.

### `src/daemon/try.ts`
Writes the tutorial, opens the surfaces, watches the file, hands back what the learner wrote.

**Why the launcher is injected:** otherwise running the tests opens real editor windows.

**Why it watches the directory rather than the file:** a file that does not exist yet cannot be
watched, and many editors save by replacing the inode instead of writing in place.

**Why a finished try retires its ticket (`onFinished`):** the ticket store deliberately keeps
try-resolved tickets visible so a tutorial can be reopened, and nothing ever told it the try had
ended. Two stores held state about one change and only one learned the outcome — so the agent's
next call found a ticket still awaiting a decision and the learner was asked to approve
overwriting the file they had just typed.

**Why the fields are `learnerWrote` / `agentIntended` and not `yours` / `theirs`:** the old names
were perspective-relative, and "theirs" meant the agent's code inside `Attempt` but the learner's
in the prompt. That ambiguity is exactly how the repeat-gate came to compare the wrong operand.
Names that state whose code they hold make the mistake unwriteable.

**Why the wait is 45 s:** the MCP SDK's `DEFAULT_REQUEST_TIMEOUT_MSEC` is 60 s. A call returns
`waiting` before that expires and the agent calls again — expiry is a normal outcome, not an error.

### `src/core/stats.ts`
Aggregates the JSONL event log into the numbers `let-me-explain stats` prints.

**Why it is a pure function over parsed lines**, with the file reading left to the CLI: it is
unit-testable against fixture strings with no filesystem, which is how the deny-rate arithmetic
and the wait-time median are checked.

**Why it tolerates a truncated last line:** the log is appended to while being read. Refusing to
report because of a half-written line would make the metric useless exactly when it is busiest.

### `src/core/paths.ts`
XDG path resolution.

**Why `Env` is a plain value passed in** rather than reading `process.env`: every path function
becomes testable with a fake env, and `test/killswitch.test.ts` can point a whole subprocess at a
temp directory.

**Why runtime and state are different directories:** they have different lifetimes. The port file
is meaningless after a reboot (`$XDG_RUNTIME_DIR`, cleared on logout); your chosen mode and your
session logs are not (`$XDG_STATE_HOME`).

### `src/core/discovery.ts`
Reads the daemon's port and token file.

**Why it is not in `daemon/main.ts`:** `main.ts` starts a daemon at import time, so importing it
to reuse one function would boot a daemon as a side effect. The shim and the CLI both need this,
and the shim needs it dependency-free.

---

## `src/io/` — the only impure layer

### `src/io/fs-io.ts`
The single module that touches the filesystem, injected as a dependency.

**Why write-to-temp-then-rename:** `rename` within a directory is atomic on POSIX, so a crash
mid-write can never leave a half-written mode file. Readers see the old file or the new one.

**Why injected rather than imported directly:** flow tests run against a real temp directory with
the real implementation, so there are no filesystem mocks anywhere in this repo.

### `src/io/env.ts`
The single place `process.env` is read.

**Why:** one boundary to fake in tests, and `core/` stays pure by construction rather than by
discipline.

---

## Small files

| File | Why |
|---|---|
| `src/contracts/index.ts` | One wire vocabulary shared by daemon, MCP server and shim. A harness adapter's whole job becomes mapping its payload onto these, which is what makes Codex/OpenCode cheap later. Also holds `LIMITS` — the word caps that make feature 3 testable |
| `src/hook/policy.ts` | The never-intercept list. Extracted from the shim purely so it is unit-testable without a build step. Its regex requires our name *as the command* plus one of our subcommands — a plain substring test exempted every command that merely mentioned a path containing `let-me-explain`, which was found live |
| `src/version.ts` | Reads `__TOOL_VERSION__`, injected by tsup at build time and by Vitest's `define`; falls back to `'dev'` under `tsx` where neither applies |
| `src/globals.d.ts` | Declares that injected global for TypeScript |

---

## The editor extension

### `vscode-extension/src/daemon.ts`
Everything the buttons *do*: find the daemon, poll `/active`, POST `/decision` for **✓ Allow** and
**✎ Let me try**, POST `/done` for **✓ I'm done**.

**Why it is split out of `extension.ts`:** with the logic inside `activate()` nothing could reach
it, so the button was untestable. With no `vscode` import, the end-to-end test presses the button
by running its real code rather than a copy — which is how the target-identity bug was caught.

**What is still untested:** the VS Code wiring itself — that the status bar item appears and the
command is registered. That needs `@vscode/test-electron`, a ~200 MB download and a display.

### `vscode-extension/src/extension.ts`
The VS Code wiring: three status-bar items and their commands — **✓ Allow** and **✎ Let me try**
while a change is held, **✓ I'm done** while a try is in flight. All daemon traffic lives in
`daemon.ts`.

**Why the explanation is in the tooltip:** the status bar has room for a verb and a filename.
Hovering is where reading happens, so the rendered line-by-line explanation rides along in
`/active` and goes straight into a `MarkdownString` — no second request when you hover.

**Why it exists at all:** VS Code's built-in markdown preview draws task-list checkboxes but does
not make them clickable, and the preview is owned by VS Code — no plugin can change it. A real
button needs an extension.

**Why it polls rather than holds a connection:** the daemon may not be running, may restart, and
gets a fresh port every time. A 2 s poll of a loopback endpoint costs nothing and needs no
reconnection logic; an absent daemon just means the button stays hidden.

**Why it duplicates the path and discovery rules** instead of importing them: it is a separate
build for the VS Code runtime. The duplication is deliberate and is called out in its README —
it has to stay in step with `src/core/paths.ts` and `src/core/discovery.ts`.

**Why it is optional:** the tutorial checkbox and `let-me-explain done` cover every other editor,
so nothing depends on it being installed.

## Tests

| File | What it protects |
|---|---|
| `test/loop.test.ts` | The whole protocol end to end, no agent involved: deny → same ticket on retry → explain → block → allow |
| `test/tickets.test.ts` | The state machine, TTL, session scoping, and the approve-before-retry race |
| `test/hash.test.ts` | That key reordering does not change the hash |
| `test/explanation.test.ts` | Line extraction per tool, and every validation rejection |
| `test/killswitch.test.ts` | Modes, the never-intercept list, and that the shim fails open |
| `test/shim.test.ts` | **The positive control** — a real daemon and a real shim producing a *deny*. Every other shim test asserts `allow`, which a shim that did nothing would also pass |
| `test/prebind.test.ts` | Explaining before the change: binding, one-change-per-explanation, the coverage-mismatch fallback, session and target scoping, and that the instruction text stays short |
| `test/surface.test.ts` | The `prompt` surface returning `ask`, the prompt formatter and its truncation, and that the pre-surface mode-file format still parses |
| `test/try.test.ts` | The try flow end to end, what the learner wrote coming back, and all three cleanup levels |
| `test/tutorial.test.ts` | Tutorial rendering inside a narrow pane, and the launch argv for every platform |
| `test/e2e.test.ts` | The whole journey with everything real but the model — shim, daemon, MCP server over a real MCP client, CLI, and the button's own module. It found the button posting an identity `/done` could not match |
| `test/live/journey.live.test.ts` | The same journey against a real `claude -p` session. Opt-in via `npm run test:e2e`; reports deny-rate |
| `test/cli.test.ts` | The CLI as a subprocess against a real daemon. Added because `cli.ts` had no coverage at all, which is where `done` was silently broken |
| `test/stats.test.ts` | The deny-rate arithmetic, reason grouping, wait medians, and tolerance of a truncated log line |
| `test/paths.test.ts` | **Every route a learner can take, walked as a sequence** — indexed in [reference/test-matrix.md](reference/test-matrix.md). Single rounds, two rounds on one file, repeat protection, each finish signal, concurrency, and degenerate input. Added because every bug that reached real use was a *sequence* bug — a second round replaying the first, a finished try leaving its ticket alive, a fix mistaken for a repeat — and unit suites test components, not orderings. Writing it out found an unreported gap: the pre-explanation path validated nothing at all |

---

## Related

- [architecture.md](architecture.md) — how these fit together at runtime
- [decisions.md](decisions.md) — the calls behind several of these whys
- [development.md](development.md) — building and testing
