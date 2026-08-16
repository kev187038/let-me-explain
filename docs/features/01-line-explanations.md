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

Two deliberate exclusions:

- **The old side of an edit is never explained.** You learn from what is being written, not from
  what is being deleted.
- **Blank lines are exempt.** Demanding a note for them is noise the agent has to generate and
  you have to skip.

## Coverage is an invariant, not a request

This is the load-bearing decision. Feature 1 says "every line, explained" — a prompt asking for
that is a *request* the model may partially satisfy. `src/core/explanation.ts` validates the
explanation at the tool boundary and rejects it otherwise, so the model structurally cannot
proceed without full coverage.

Rejections are returned to the agent as tool errors, which it reads and acts on:

```console
$ # explained only line 1 of 2
{"ok":false,"error":"Missing notes for line(s): 2. Every non-blank line needs exactly one note."}

$ # a 30-word note
{"ok":false,"error":"Note(s) on line(s) 1 exceed 25 words. Say the one thing that line does, plainly."}

$ # numbered past the end of the change
{"ok":false,"error":"Line 9 does not exist — this change has 3 line(s). Number lines from 1 within the new content only."}
```

Every message names what to do next, not just what went wrong. That is what makes them work as
prompts rather than as complaints.

## Brevity is enforced, because brevity is the product

From feature 3: *explanations need to be brief. No walls of text that are an eye-sore to read.*
That is a testable assertion, so it is one. `src/contracts/index.ts`:

| Limit | Value | Why |
|---|---|---|
| `maxNoteWords` | 25 | One line does one thing; 25 words is enough to say it |
| `maxWhyWords` | 90 | The wider context is a paragraph, not an essay |

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
