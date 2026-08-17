---
title: Let-me-try
feature: 4
status: shipped
relates_to: [architecture, features/00-single-agent, features/01-line-explanations, reference/cli]
---

# Feature 4 — type it yourself

> The teacher agent also allows the choice to the user to write the command or the code
> themselves to learn by hand and memory as well.

Named **let-me-try** (it was `let-me-write`).

## Why

Reading an explanation and being able to write the thing are different skills, and only the
second one survives. Recognition feels like understanding while you are reading; typing it out is
where you find out whether you actually understood.

The first version of this feature was the *absence* of help — the agent stood down and you were
on your own. That satisfies the sentence in the README and teaches nothing. What it should
recreate is following a good video: the instructor shows the code and explains it, **and you type
it**, with the explanation still on screen.

## How to reach it

**A menu, right after the explanation.** Claude Code's permission prompt has three fixed entries —
yes, yes-and-don't-ask, no — and a plugin cannot add a fourth; that is settled, not a gap waiting
to be filled (see [decisions.md](../decisions.md)). But `AskUserQuestion` is a built-in Claude Code
tool that renders a genuine multiple-choice list, and the agent can call it. The `explain` tool's
reply asks it to:

```
  How do you want to handle src/auth.ts?
  ❯ 1. Yes, go ahead
    2. Let me try — I'll type it myself
    3. Explain more first
```

The wording lives in `chooseHowToProceed` in `src/daemon/prompts.ts`, beside every other
agent-facing string, and reaches the agent as the `next` field of `POST /explain`. It is *not* in
the session-start instructions: just-in-time context lands adjacent to the action and costs nothing
in a session where no edit happens.

**Nothing reports the answer back to us, on purpose.** A tool that recorded "the learner said yes"
would let the hook allow silently and save a keypress — and would also let a model that never
showed the menu approve its own change. The menu is additive: skip it and you get the ordinary
prompt, where *"No, and tell Claude what to do differently"* plus **"let me try"** still works.

**On `surface: window`** the VS Code status bar carries the same choice as buttons — **✓ Allow**
and **✎ Let me try** — with the explanation in the tooltip. From a terminal that is
`let-me-explain pending`, then `allow` or `try`.

## How it works

1. The agent explains the change; the explanation appears inline under `prompt`, or in the
   button's tooltip under `window`.
2. You pick **Let me try** from the menu (or the status-bar button, or reject and say so).
   Choosing from the menu happens *before* the agent has made its tool call, so the daemon has
   your notes but not yet the code. It remembers the choice and writes the tutorial the instant
   the tool call brings the code — see `status: "armed"` in
   [reference/protocol.md](../reference/protocol.md).
3. The agent calls `let_me_try({ target })` — the injected instructions tell it to. It opens the
   tutorial and your file and **returns immediately**.
4. The agent retries the original tool call. The hook sees a try in flight and **parks**.
5. You type. You save.
6. You say when you are done — see below.
7. The hook denies the retry and hands the agent **what you wrote** next to **what it intended**,
   and the instructions tell it to compare briefly and kindly rather than rewrite your file.
8. The tutorial stays, with a **Handed back ✓** footer. It used to be deleted the instant you
   ticked the box, which pulled the document out from under you while it was open in your editor
   — and took the explanation with it exactly when you were reading the feedback. It ages out
   with the rest, or goes on `let-me-explain clean`.
9. The same tool call is refused from then on. The ticket used to outlive the try, so the agent's
   next identical call asked you to approve overwriting the file you had just typed. A *different*
   change to the same file is unaffected — the match is on content, not filename.

Nothing new is generated for the tutorial. Under `surface: prompt` the ticket is deliberately kept
after the prompt is shown, so the daemon still holds the code (from `toolInput`) and the notes
(from `explain()`).

## The split

| Surface | Holds | Lives for |
|---|---|---|
| Tutorial | what to type, why, per-line notes | until the try finishes |
| Editor | the file you are typing into | yours afterwards |
| Claude terminal | progress, then the review | the session |

One surface is read-only reference, one is yours to type in, one is conversation — so nothing
appears twice and nothing has to be kept in sync.

**In VS Code** (detected from `TERM_PROGRAM=vscode` or `CLAUDE_CODE_SSE_PORT`):

```bash
code -r "<state>/tutorials/<session>/TRY-auth.ts.md"   # reference, first
code -r -g "src/auth.ts:1"                             # target, takes focus
```

Order matters: the last file opened takes focus, and focus has to land where you type. `-g
file:line` puts the caret where the change starts. The file is created empty first so the editor
never opens a phantom buffer.

**The `code` CLI has no flag to force a split**, so whether those land as two tabs or side by side
is VS Code's choice — press `Ctrl+\` to split. The tutorial is named `TRY-<file>.md` so the two
tabs are never confused.

**Without VS Code**, a second terminal opens on the file with `$EDITOR` (falling back to whatever
of `nano`/`vim`/`nvim`/`micro`/`helix` exists), through `gnome-terminal` →
`x-terminal-emulator` → `konsole` → `alacritty` → `kitty` → `xterm`, or `open -a Terminal` on
macOS and `wt` on Windows.

## Why the tutorial is shaped the way it is

It is read in a ~50 column editor split, not on a full screen (`src/core/tutorial.ts`):

- Prose wraps at 60 columns; a test asserts no rendered line is longer.
- **Line-by-line is the primary layout** — it is what you read *while* typing.
- A copyable code block goes on top **only for changes of 15 lines or fewer**. Past that it costs
  a row per line and pushes the notes off screen, and the line-by-line contains every line anyway.
- Wrapped notes align under the `└` rather than repeating it.

## Telling Claude you have finished

Three ways, in order of how little they interrupt you:

| Signal | Where |
|---|---|
| **Status-bar button** | VS Code, with the optional extension installed |
| **Tick the checkbox** | the tutorial's `- [ ] I'm done`, then save |
| **`let-me-explain done`** | any terminal — no arguments needed |

**Nothing else ends the wait**, and that is deliberate. An earlier version treated three seconds
of quiet after saving your code as "finished" — but a pause in typing is *thinking*, and firing
early handed Claude a half-written file and consumed the try, which cannot be undone. The code
file is no longer watched at all.

The checkbox has to be an *edit* rather than a plain save: an unmodified file is not written to
disk when you press save, so watching for a save of the tutorial would never fire. Ticking a box
changes the file, so it always does.

`done` takes no arguments: with one try in flight it finishes that one. Only when several are
open does it ask you to name one with `--target`, because that is the only case where guessing
would be wrong. (It used to send a placeholder session id that could never match, so it *always*
reported nothing was waiting — the one finish signal outside VS Code, broken, and untested.)

VS Code's built-in markdown preview renders checkboxes as **visual only** — they are not
clickable, and the preview is owned by VS Code, so no plugin can change that. A genuine button
therefore needs an editor extension, which is what `vscode-extension/` is.

## Turning the plugin off does not abandon a try

`let-me-explain off` stops *future* interception; it does not cancel work you are part-way
through. The hook checks for a try in flight **before** it checks the mode, because reaching the
mode check would return `allow` and let the agent's write land on top of what you are typing.
Switching off mid-try is a plausible thing to do, and losing your work for it would not be.

## Where the waiting happens, and why

**In the PreToolUse hook, not in the MCP call.** The two have very different budgets:

| Mechanism | Wait it allows |
|---|---|
| MCP tool call | 60 s — the SDK's `DEFAULT_REQUEST_TIMEOUT_MSEC` |
| PreToolUse hook | whatever `hooks.json` sets |
| The approval prompt | unbounded — it waits on a human |

An earlier version blocked inside `let_me_try` and returned `waiting` every 45 s so the agent
could call again. It worked, but a thirty-minute session meant ~40 idle round trips filling the
transcript. Parking in the hook gives one long wait instead.

Two rules come out of that:

- **The daemon's wait must be shorter than the hook timeout**, so *we* answer rather than the
  harness killing the hook. A killed hook is treated as a non-blocking error and the tool would
  proceed — overwriting the file the learner just typed.
- **Neither outcome may `allow`.** Finished → deny, carrying their code back for review. Not
  finished → deny, saying they are still typing so the agent retries. This is the one place the
  project's usual fail-open rule is inverted, because failing open here destroys work.

The try is also checked **before anything ticket-shaped**. A try in flight outlives the ticket
that started it — tickets expire after 10 minutes, and a slow typist does not.

The file is watched through its *directory*, not directly: a file that does not exist yet cannot
be watched, and many editors save by replacing the inode rather than writing in place.

## Cleaning up

Tutorials live in `<state>/tutorials/<session>/`, outside the project, so there is no repo
pollution and no `.gitignore` entry. They are removed at three levels:

| When | What goes |
|---|---|
| A try finishes | that tutorial |
| `SessionEnd` | every tutorial for that session |
| Daemon start | anything older than 7 days |

Plus `let-me-explain clean`, and `let-me-explain clean --list` to see what is there first.

## Where it lives

| Part | File |
|---|---|
| Tutorial rendering | `src/core/tutorial.ts` |
| Which editor, which argv | `src/core/open-editor.ts` |
| Orchestration and the wait | `src/daemon/try.ts` |
| Routes | `src/daemon/routes.ts` (`/try`, `/done`, `/clean`, `/tutorials`) |
| The tool the agent calls | `src/mcp/server.ts` |
| Cleanup | `src/core/cleanup.ts`, `src/hook/session-end.ts` |
| The VS Code button | `vscode-extension/src/extension.ts` |
| Tests | `test/try.test.ts`, `test/tutorial.test.ts`, `test/e2e.test.ts` |

## Related

- [features/01-line-explanations.md](01-line-explanations.md) — where the notes come from
- [features/07-toggle.md](07-toggle.md) — when you want none of this
- [architecture.md](../architecture.md) — surfaces and the ticket
- [reference/cli.md](../reference/cli.md) — `try`, `done`, `clean`
