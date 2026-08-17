---
title: Per-line explanations
feature: 1
status: shipped
relates_to: [architecture, features/00-single-agent, features/04-let-me-try, reference/protocol]
---

# Feature 1 — every line, explained

> Chunk command / new code in lines as tokens: every token is explained as a line in its context.
> Worth considering chunking by word.

Shipped at **line** granularity. Token granularity is planned — Shiki's token tree already
supports it, so it becomes a rendering setting once the second window exists rather than new
plumbing.

## Why

A diff you cannot read teaches nothing. The unit matters: a summary of a change ("adds token
expiry") is something you can nod along to without understanding. A note per line forces the
explanation down to where the actual learning is.

## What counts as an explainable line

`src/core/lines.ts` turns a tool call into the lines that need notes:

| Tool | Lines |
|---|---|
| `Edit` | every line of `new_string` |
| `Write` | every line of `content` |
| `MultiEdit` | every line of every edit's `new_string`, flattened |
| `Bash` | every line of `command` |
| anything else | none — passes straight through |

Three deliberate exclusions:

- **The old side of an edit is never explained.** You learn from what is being written, not from
  what is being deleted.
- **Blank lines are exempt.** Demanding a note for them is noise the agent has to generate and
  you have to skip.
- **Unchanged context is exempt.** An `Edit` has to carry surrounding lines inside `new_string` so
  its match is unique. Requiring a note for them rejected *every* real code edit once, and made
  the agent narrate code it was not touching. Notes now land only on what actually changed.

  Context is detected by set membership against `old_string` rather than a real diff: a few lines,
  no dependency, and its one inaccuracy is benign — a new line whose text matches an old one is
  nearly always structural (`}`, `});`, `else {`), which deserves no note anyway.

## Coverage is shown, not enforced

This was once the load-bearing decision and it has been reversed — see
[decisions.md](../decisions.md). Coverage *was* validated at the tool boundary, on the reasoning
that a prompt is a request and validation is a guarantee. The mechanism was right; the cost was
not. The validator refused real explanations three times in a row, each for a different reason —
notes on unchanged context, numbering by file position, then simply *more* notes than the minimum
— and each fix revealed the next. A strict validator aimed at a model whose output shape varies
keeps finding new ways to say no, and every no costs a round trip and an error you have to decode.

So `src/core/explanation.ts` now accepts whatever notes arrive:

- `alignNotes()` matches notes to lines **by number when those numbers point at real lines**, and
  **in the order given** otherwise. The agent may number from 1 within the change or by position
  in the file; both work.
- A line with no note renders as `— not explained —` in the prompt and in the tutorial. You see
  the change with a visible hole rather than not seeing the change at all.
- `unexplained()` reports the gaps, which the daemon logs as `explain.coverage`.

What is still refused, because it is cheap for the agent to fix and unambiguous to check:

```console
$ # a 30-word note on code
{"ok":false,"error":"Note(s) on line(s) 1 exceed 25 words. Say the one thing that line does, plainly."}

$ # the tool called with no explanation at all
{"ok":false,"error":"Send at least one note — this is the explanation the learner reads."}
```

Every message names what to do next, not just what went wrong. That is what makes them work as
prompts rather than as complaints.

**Coverage did not stop mattering — it stopped being a gate.** The injected instructions still ask
for one note per changed line, and `let-me-explain stats` reports the share that arrived
explained, so under-explaining is visible instead of silent. The general rule: enforce what is
cheap to satisfy and unambiguous to check; measure what is neither.

## Brevity is enforced, because brevity is the product

From feature 3: *explanations need to be brief. No walls of text that are an eye-sore to read.*
That is a testable assertion, so it is one. `src/contracts/index.ts`:

| Limit | Value | Why |
|---|---|---|
| `maxNoteWords` | 25 | One line does one thing; 25 words is enough to say it |
| `maxShellNoteWords` | 45 | A command is one line but carries several flags, and each one is worth naming |
| `maxWhyWords` | 90 | The wider context is a paragraph, not an essay |

A shell command gets the larger budget because it is a single line standing in for a lot:

```
1  find . -name "*.tmp" -exec rm {} \;
   └ searches from here down; -name matches the pattern, -exec runs rm
     on each hit, \; ends the command
```

These caps are the part of feature 3 that ships today. The full instruction layer — curbing AI
lingo, banning filler phrases, stopping useless code comments — is planned, along with an eval
suite that scores explanations rather than trusting them.

## The two-part shape

Every explanation carries both halves the README asks for:

- `lines[]` — the mechanical what, one note per line.
- `why` — the wider context: the bug being fixed, the reason this feature needs this change.

The `why` is where the coding agent's advantage over a separate teacher model shows up. It knows
what it was trying to do; a second model would be reverse-engineering intent from a diff.

## Where it lives

| Part | File |
|---|---|
| Line extraction | `src/core/lines.ts` |
| Validation and error text | `src/core/explanation.ts` |
| Word caps | `src/contracts/index.ts` (`LIMITS`) |
| Tool schema and description | `src/mcp/server.ts` |
| Rendering for the learner | `src/cli.ts` (`pending`) |
| Tests | `test/explanation.test.ts` |

## Related

- [features/00-single-agent.md](00-single-agent.md) — who writes the explanations, and how they arrive
- [features/04-let-me-try.md](04-let-me-try.md) — what you do once you have read one
- [reference/protocol.md](../reference/protocol.md) — the `/explain` route
- [files.md](../files.md) — why validation lives at the boundary
