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

## Coverage is shown, not enforced — reversing an earlier decision

**Superseded:** *"Coverage is validated at the tool boundary."* That decision rejected trusting
the model, on the grounds that a prompt is a request and validation is a guarantee. The mechanism
was right. The cost was wrong.

**What happened:** the validator refused real explanations three separate times, each for a
different reason, and each fix revealed the next one — notes for unchanged context lines, then
numbering by file position instead of position within the change, then more notes than the
minimum. Three rounds is a pattern rather than a run of bad luck: a strict validator aimed at a
model whose output *shape* varies will keep finding new ways to say no, and each no costs a
wasted round trip and an error the learner has to interpret.

**Now:** the tool accepts whatever notes arrive and pairs them to lines — by number when that
fits, in order otherwise. A line with no note renders as `— not explained —`. The learner sees
the change with a visible hole in it instead of not seeing the change at all.

**What is still enforced,** because it is cheap for the agent to fix and rare: an over-length
note, an over-length `why`, and calling the tool with no notes whatsoever.

**Coverage did not stop mattering — it stopped being a gate.** `explain.coverage` is logged at
the point the notes meet the real change, and `let-me-explain stats` reports the share of changed
lines that arrived explained. The instructions still ask for every changed line. The general
rule: enforce what is cheap to satisfy and unambiguous to check; measure what is neither.

---

## "Let me try" is offered through `AskUserQuestion`, not a fourth button

**Established, not assumed:** Claude Code's permission prompt cannot be extended. A `PreToolUse`
hook may return only `permissionDecision` (`allow` / `deny` / `escalate`),
`permissionDecisionReason`, `additionalContext` and `updatedInput`, plus `systemMessage` and
`continue`. The hooks reference states outright that hooks cannot define their own options, and
the Agent SDK's `canUseTool` is likewise binary (`allow` / `deny`). Sources checked 2026-08-17:
`code.claude.com/docs/en/hooks.md`, `.../agent-sdk/user-input`, `.../plugins-reference.md`.

**So the menu comes from elsewhere.** `AskUserQuestion` is a built-in Claude Code tool that renders
a real multiple-choice list. A plugin cannot call it — but the agent can, and we can ask the agent
to. The request rides in the `explain` tool's reply (`chooseHowToProceed` in
`src/daemon/prompts.ts`, returned as `next` from `POST /explain`) rather than in the session-start
instructions: just-in-time context arrives adjacent to the action and costs nothing in sessions
where no edit happens.

**Rejected: a tool that records the learner's answer.** It would collapse "Yes" to a single
keystroke by letting the hook allow silently. It would also let a model that skipped the menu call
it anyway and approve its own change, and the learner would never see the edit. The menu is
therefore purely additive — **nothing here reports a decision, so nothing here can fake one.** If
the model ignores the menu, the hook still asks, which is exactly the old behaviour. The price is
one extra keypress on the "Yes" path; "Let me try" costs nothing extra, and that is the path the
feature exists for.

**It degrades where the tool is absent.** `AskUserQuestion` does not exist in `-p` (print) mode —
measured, not assumed — so the reply ends with "No AskUserQuestion tool? Skip the menu and make the
tool call as normal." Without that line a headless agent would chase a tool it does not have.

**Compliance is measured, not assumed.** `test/live/journey.live.test.ts` asserts the menu reaches
the model. Whether the model *acts* on it is a model property that drifts silently, and can only be
seen in a real interactive session — the same reason deny-rate is tracked.

---

## A successful handback is an `allow`, not a `deny`

**Rejected:** keeping `deny` and rewording it so it reads less like a failure.

**Why:** the red block is not styling we can soften. From the 2.1.233 binary:

```
case "deny": u.blockingError = { blockingError: …permissionDecisionReason…, command: t }
```

**A denial *is* an error object.** `suppressOutput` is a documented no-op, `terminalSequence`
cannot restyle the transcript, and exit code 2 routes identically. So a flow that succeeded — the
learner did the exercise — was rendering as a failure, with no field able to change that.

**So the write is neutralised instead of refused.** `allow` + `updatedInput` rewrites the Write's
content to the bytes already on disk; the tool runs, changes nothing, and renders green. The
comparison rides in `additionalContext`, which reaches the model as a system reminder.

**Measured, not assumed** (Claude Code 2.1.233, `claude -p`, three runs each):

| Permission mode | `updatedInput` applied |
|---|---|
| `default` | 3 / 3 |
| `acceptEdits` | 1 / 3 |

Under `acceptEdits` the write is pre-approved, so the hook is no longer what satisfies the
permission interaction and the rewrite is often skipped. The hook payload carries `permission_mode`,
so the daemon decides per call: neutralise where it is reliable, deny everywhere else. A red block
is a cosmetic problem; the agent's version landing on the learner's file is not.

**Three cases keep denying on purpose.** `Edit`/`MultiEdit` need `old_string ≠ new_string`, so a
no-op edit cannot be expressed; `Bash` has no file to hand back; and the wait-expiry path *wants*
the retry, because retrying is how the wait is extended.

**The handback is phrased as statements, not commands.** Claude Code wraps `additionalContext` in a
system reminder, and text that reads like an out-of-band instruction trips the model's
prompt-injection defences — it surfaces the text to the user instead of acting on it. Measured: a
probe worded as an order (*"reply with exactly…"*) was refused outright, with the model correctly
noting it had arrived through a tool-result channel.

**A restore net backs it up**, because this is the one path that must not fail open. If the rewrite
were ever dropped, the daemon puts the learner's bytes back — but only when the file matches the
agent's version exactly, which is proof its write executed. An unconditional restore would clobber
edits made in the seconds after clicking done.

---

## `fs.watch` failing is a real state, not an impossibility

**Rejected:** `catch { /* no watcher: the CLI still works */ }`.

**Why:** it was silent, and the failure it hid is total — the learner ticks the box and nothing
happens, forever. It was found by accident: 236 leaked test daemons had exhausted the machine's 128
inotify instances, so `fs.watch` threw `EMFILE` and every tutorial checkbox stopped working. Network
filesystems never support it either.

Polling the tutorial once a second is a worse mechanism and a far better failure mode. The lesson
generalises past this file: **a catch block that swallows an error must leave the feature working,
or it is just a delayed bug report.**

The leak itself was a test-hygiene bug worth naming — `spawn('npx', …)` wraps `tsx` which wraps
node, so `child.kill()` reaps the wrapper and orphans the daemon. Every suite that spawns one now
uses `detached: true` and kills the process group.

---

## The newest intent wins, everywhere

Three separate bugs in one day turned out to be the same mistake, so the rule is written down
rather than rediscovered a fourth time: **when two pieces of state could describe "the change in
front of us", the most recently created one is the answer.**

- `POST /try` looked for a *ticket* before a pre-explanation. A pre-explanation means the agent has
  explained something it has not yet attempted, which is by definition newer — so a second "let me
  try" on the same file replayed the first round's code and notes.
- `viewFor` used `.find()` over a `Map`, which iterates in insertion order and therefore returned
  the *oldest* matching ticket. It now takes the newest, with `.reverse()` before the sort because
  two tickets minted in the same millisecond tie on `createdAt` and a stable sort would fall back
  to insertion order.
- The repeat gate fired on a genuine follow-up. It now stands aside whenever a try is armed or a
  fresh pre-explanation exists, because both mean a new round is under way.

**A finished try also retires its ticket.** `viewFor` deliberately keeps try-resolved tickets
visible so a tutorial can be reopened, and nothing told it when the try ended — so `createTryStore`
takes an `onFinished` callback wired to `store.consume`. Where one object's completion implies
another's, make the link explicit; two independent TTLs will not stay in agreement.

---

## The repeat gate compares the agent's code, not the learner's

**Rejected:** comparing the incoming tool call against what the learner typed.

**Why:** it reads more naturally — the function is called `alreadyWritten` — and it is wrong. The
learner's version is *usually different from the agent's*; that is the entire point of the feature.
Comparing against it would let the agent's identical retry sail through, and the learner would be
asked to approve overwriting their own work: exactly the bug the gate was added to prevent.

The gate answers "is this the agent re-attempting the change it already proposed?", so it compares
against `agentIntended`. Legitimate follow-ups are separated by the newness rule above, not by the
operand. This was reported as a bug with a proposed fix; the diagnosis was right and the fix would
have regressed. A correct root cause does not imply a correct patch.

---

## Notes are validated on both paths, not just the one that had the code

**Rejected:** validating only where an explanation is bound to a real change.

**Why:** the checks were written when a ticket was the only way to explain something, and then the
traffic moved. Once the agent explains *before* acting — now almost every explanation — the
pre-explanation branch accepted anything at all: zero notes, thousand-word walls. No error, no
failing test, just an invariant that quietly stopped holding. `validateNotes` is the part that
needs no code in hand (something was sent, it is short enough) and now runs on both paths;
`validateExplanation` adds only the line alignment used to number the error message.

The general shape, seen three times today: **a guarantee attached to one code path, and then a
second route added to the same operation.** Worth asking every time — which invariants did the old
path enforce, and does the new one enforce them too?

---

## A watcher has to prove it can show the choice

**Rejected:** treating any authenticated `GET /active` poll as evidence that someone can decide.

**Why:** that is what shipped first, and it caused a silent hang. On `surface: window` the daemon
holds the tool call open; the pre-buttons VS Code extension polled `/active` for tries alone, which
was enough to convince the daemon a decider existed. The change was held with nothing on screen and
no way to answer, and the learner just saw Claude Code stop. A poll proves someone is *watching*;
it does not prove they can *act*. So `/active` now counts a watcher only when the request carries
`x-let-me-explain-client: buttons/1`, and the hook falls back to Claude Code's prompt otherwise —
saying why, because a silent fallback is as confusing as the hang it replaces.

---

## The default surface, and why it moved twice

**Now `prompt`, after a round trip through `window`.** The flip to `window` was made for one
reason: let-me-try was unreachable on `prompt`, and holding the tool call open was the only way to
own the choice. The `AskUserQuestion` menu removes that reason, so the flip is undone rather than
left standing — the explanation goes back inline where the learner already is, and no tool call is
ever held open by default, which means nothing can hang.

`window` remains opt-in for anyone who would rather click in the editor than answer in the
terminal. There the VS Code status bar offers **✓ Allow** and **✎ Let me try**, and the
explanation moves to the button's tooltip.

**The lesson worth keeping:** the first fix treated a UI limitation as a reason to move the whole
decision out of the terminal. The limitation was real; the conclusion was too broad. Checking what
the harness actually offered — rather than assuming the prompt was the only interactive surface —
produced a smaller change that did not cost the inline explanation.

**A held ticket is not the same as a pending one.** On `prompt`, tickets sit in
`awaiting_decision` on purpose so a retry re-asks instead of demanding a fresh explanation — but
nobody is parked on them. `/active` therefore reports only tickets with a live waiter
(`store.isHeld`), or a button click would answer a question that was never put to us.

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
