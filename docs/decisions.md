---
title: Design decisions
status: shipped
relates_to: [architecture, files, development]
---

# Decisions, and what lost

Each entry: the call, the alternatives rejected, and the consequence if it were reversed. These
are the things most likely to be "simplified" by someone who does not know why they are there.

---

## The daemon is a separate process from the MCP server

**Rejected:** folding the HTTP server into the MCP server, one per session. Claude Code already
owns that process's lifecycle, so all supervision code would disappear.

**Why it lost:** the daemon owns state that outlives and spans a single session — the on/off mode,
the cross-session `stats` log, and tickets that must survive an MCP server restart. One process
per session cannot hold any of that.

> **Correction.** This entry previously said the MCP server *never learns its own `session_id`*,
> and that the split existed to work around it. That was measured and found false: Claude Code
> passes `CLAUDE_CODE_SESSION_ID`, identical to the hook's `session_id`. The decision survives on
> the reasoning above; the original reasoning did not. See
> [architecture.md](architecture.md#session-identity).

**If reversed:** mode and stats fragment per session, and a restarted MCP server loses pending work.

---

## Explanations may arrive before the change they describe

**Rejected:** requiring a ticket for every explanation, which is what slice 1 shipped.

**Why it lost:** tickets are minted only by a denial, so requiring one forced *every* change
through `attempt → denied → explain → retry`. That is a wasted round trip and the content sent
twice, on every edit — directly against feature 0's purpose of spending fewer tokens. It also
pinned deny-rate at 100%, making the health metric unfalsifiable.

**How it is safe:** a pre-explanation is a claim about content the daemon has not seen, so it is
validated against the real lines at bind time. A stale or mispaired one fails the coverage check
and degrades to the deny path rather than approving the wrong change.

**Measured:** deny-rate 100% → 0% in live sessions once the instruction layer shipped alongside it.

---

## Instructions are injected by the SessionStart hook, not written to CLAUDE.md

**Rejected:** v1's approach of writing a managed block into the user's `CLAUDE.md`; also shipping
a skill or output-style, which need invoking or selecting.

**Why:** `SessionStart` stdout is injected as session context automatically, so it needs no user
action and the text is versioned with the plugin instead of living in the user's files. Uninstall
removes it completely.

**Why the daemon renders the text** rather than the hook: only the daemon knows the name the
harness actually gave our MCP tool. Instructions naming a tool that does not exist are worse than
no instructions.

**The constraint that shapes it:** this text is prepended to the model's context in *every*
session, so every extra sentence costs tokens forever and dilutes attention. Target ~250 words.

---

## The explanation goes in Claude Code's own permission prompt

**Rejected:** a browser window — a daemon SSE stream feeding a React + Vite + Shiki app. That was
planned in detail and abandoned before any of it was written.

**Why it lost:** it answered the wrong question. The goal is that the learner *sees* the
explanation, not that we own a surface. `permissionDecision: "ask"` escalates to Claude Code's own
approval prompt with `permissionDecisionReason` shown to the user, so the explanation appears
inline where they already are. The VS Code extension renders that same prompt, so VS Code comes
free with no second extension to build, install or publish.

It also **deletes** architecture instead of adding it: no browser, no SSE, no React, no bundler,
no npm workspaces — and no blocking, because the hook answers immediately instead of parking for
up to five minutes.

**What it bought for free:** the prompt already offers *"No, and tell Claude what to do
differently"*, and that text reaches the agent. That is feature 4 ("I'll write it myself") and
much of feature 5 (ask a question) with no decision route of our own.

**What it costs:** no syntax highlighting and no control over layout, and a long change has to be
truncated to keep the prompt usable. Feature 2 (choosing which lines to explain) has no surface
here at all — which is why `surface: window` is kept rather than deleted: it is the foundation a
VS Code panel would reuse.

---

## `ask` means the hook never learns the outcome

**The problem it created:** under `surface: prompt` the hook answers and exits, so it never finds
out what the learner chose. Slice 2's approve/reject counts would have silently gone to zero —
worse than not reporting them, because the number would still look authoritative.

**Fix:** recover the outcome after the fact from `PostToolUse` (it ran → approved) and
`PermissionDenied` (it did not → rejected), via a small observational hook that logs and exits.

**Habit worth naming:** when you hand a decision to another system, ask what telemetry you just
gave up. Metrics that quietly stop being fed are more dangerous than metrics you never had.

---

## The learner's typing is waited on in the hook, not in an MCP call

**Rejected:** blocking inside the `let_me_try` MCP tool, which is what shipped first.

**Why it lost:** the MCP SDK caps a request at 60 s (`DEFAULT_REQUEST_TIMEOUT_MSEC`), so a call
could only wait ~45 s before returning "still typing" for the agent to call again. Correct, but a
thirty-minute session became ~40 idle round trips — latency, tokens, and a transcript full of
nothing. The `PreToolUse` hook's budget is ours to set in `hooks.json`, so the same wait costs one
call.

**What made it safe:** the daemon's own wait is kept below the hook timeout so we answer first. If
the harness killed the hook it would treat that as a non-blocking error and let the tool run,
overwriting the file the learner had just typed — so this is the one place the fail-open rule is
deliberately inverted. Both outcomes deny.

**Still bounded, though.** The unbounded wait in the harness is the approval prompt, which has no
timeout at all because it waits on a human. Using it here would need "Yes" to mean something
harmless, which costs putting `Read` in the hook matcher — ~22 ms on the most frequent tool in the
system. Rejected for now; revisit if the hook budget proves too small.

---

## The control-command exemption matches a command, not a substring

**Rejected:** `command.includes('let-me-explain')`, which slice 1 shipped and this page previously
defended as "erring toward allowing, which is the safe direction here."

**Why it lost:** found live. Any command mentioning a *path* containing `let-me-explain` was
exempted — so working inside a directory of that name silently disabled interception. The safe
direction was the wrong direction: a false exemption stops the product teaching, while a missed
exemption costs one explanation and is recoverable via `LET_ME_EXPLAIN=0`.

**Now:** the name must appear as the command being invoked *and* be followed by one of our
subcommands. `grep -r let-me-explain src/` is intercepted; `let-me-explain off` is not.

---

## Single package, four build entries — not npm workspaces

**Rejected:** an npm-workspaces monorepo (`packages/contracts`, `packages/daemon`, …), which was
the original plan.

**Why it lost:** the only real constraint is that the hook shim must bundle with zero
dependencies while the daemon uses Hono and Zod. Separate `tsup` entries with `splitting: false`
deliver exactly that through tree-shaking. Workspaces earn their ceremony when the UI package
arrives with its own build — not before. Premature repo structure taxes every command you run.

**Revisit when:** the browser UI lands and needs a Vite build of its own.

---

## Zod in long-lived processes, hand-rolled guards in the shim

**Rejected:** Zod everywhere (consistent), or hand-rolled everywhere (v1's choice — see the
comment in the old `src/core/config.ts`).

**Why this split:** dependency weight is startup cost, and startup cost only matters where it is
paid repeatedly. The daemon and MCP server parse once per process lifetime. The shim spawns on
every single tool call, including when the plugin is off.

**Verify it, don't assume it:** `grep -oE 'from "[^".][^"]*"' dist/hook/pretooluse.js` should show
only Node builtins. Build tools silently do things you did not ask for.

---

## Everything fails open

**Rejected:** failing closed (blocking the tool call) when the daemon is unreachable or a payload
will not parse.

**Why it lost:** ask which direction is recoverable by the user. Fail-open degrades to plain
Claude Code — annoying but survivable, and obvious. Fail-closed means a bad release bricks
someone's editor with no way out short of uninstalling.

**The cost:** a fail-open system's tests can be green while testing nothing, because every failure
path produces the same answer as success. That is why `test/shim.test.ts` exists as a positive
control asserting a *deny*.

---

## `off` shares a code path with `daemon unreachable`

**Rejected:** a separate branch for the off switch.

**Why:** an escape hatch only exercised when someone types the command is an escape hatch that is
broken when they finally do. Defining `off` as "behave exactly as if the daemon were unreachable"
means every crash, restart and timeout is a live test of the disable path.

---

## The shim reads mode from disk, not from the daemon

**Rejected:** asking the daemon over HTTP, like everything else.

**Why:** `off` cost 50 ms via two round trips, versus ~22 ms reading a file — the same as not
having the plugin installed. An off switch that is perceptibly slow stops being trusted. It also
keeps working when the daemon is wedged, which is precisely when you want it.

**The cost:** mode-resolution logic is shared between shim and daemon, so it lives in exactly one
place (`src/core/mode-file.ts`) to stop the two drifting.

---

## JSONL, not SQLite

**Rejected:** `better-sqlite3`.

**Why it lost:** it is a native addon — node-gyp, a compiler toolchain, prebuilt binaries per
platform. For a plugin installed on other people's machines that is a large share of your
install-failure reports. JSONL costs queries we do not need yet.

**Revisit when:** we need real queries. `node:sqlite` is built into Node ≥22.5 with no native
install, and is the upgrade path.

---

## The denial reason is a prompt

**Rejected:** treating `permissionDecisionReason` as an error message for a human.

**Why:** the string lands in the model's context and the model acts on it. Writing it as a
repair instruction ("call `X` with ticket=Y, then retry unchanged") turns the permission system
into a self-correcting loop. Same for `explain()` rejections, which return `isError: true` with
text saying exactly which lines are missing.

**Consequence:** those strings are versioned, reviewed and iterated like prompts, in
`src/daemon/prompts.ts`.

---

## Coverage is validated at the tool boundary

**Rejected:** asking for per-line explanations in the instructions and trusting the model.

**Why:** a prompt is a request; validation is a guarantee. Feature 1 says "every line, explained"
— that is only true if something structurally prevents proceeding without it.

---

## The MCP tool name is learned, not hardcoded

**Rejected:** hardcoding `mcp__plugin_let-me-explain_lme__explain`.

**Why:** the harness decides the exposed name, and a wrong guess fails in the worst way — the
agent is told to call a tool that does not exist, the loop never closes, and every edit
deadlocks. Since the shim observes `tool_name` for every call, we learn the real name instead of
predicting it. Capability detection over version sniffing.

---

## Distribution

**Status: unresolved.** `dist/` is gitignored, and plugin install runs `npm ci --ignore-scripts`,
so a clone never builds itself. Local installs work because the installer copies your working
tree, build output included — a git- or URL-sourced install would ship nothing runnable.

Options, none chosen:

| Option | Cost |
|---|---|
| Commit `dist/` | Build output in git; noisy diffs; easy to forget to rebuild |
| Publish to npm, use an `npm` plugin source | A release step; cleanest for users |
| Use a `command` plugin source that builds on demand | Needs Claude Code ≥2.1.229; runs a build on the user's machine |

---

## Related

- [architecture.md](architecture.md) — what these decisions produced
- [files.md](files.md) — where each one lives in the tree
- [development.md](development.md) — the install path this affects
