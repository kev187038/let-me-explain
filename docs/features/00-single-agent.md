---
title: One agent teaches and codes
feature: 0
status: shipped
relates_to: [architecture, decisions, features/01-line-explanations, reference/hook-contract]
---

# Feature 0 — the Teacher Agent *is* the Coding Agent

> Ideally Teacher Agent and actual Coding Agent coincide to use less tokens.

## Why

A separate teacher model would have to be handed the diff, the file, the surrounding code and the
conversation so far — and would still be guessing at intent. The coding agent already knows why
it wrote what it wrote. Asking it directly costs one tool call and no context reconstruction.

The trade-off is real and worth stating: explanations consume the coding agent's own context
window. A bring-your-own-key teacher on a cheap model stays on the roadmap as a fallback for when
context is tight.

## How it works

The agent explains its own work through an MCP tool, `explain()`. That tool is a **side-channel**:
it carries the model's reasoning out to the daemon instead of into your terminal, so the
explanation never clutters the session you are reading.

This is worth naming, because it generalises: an MCP tool used as an *output channel* rather than
an input source is how you get structured data out of a model without polluting the visible
conversation.

## The happy path

The `SessionStart` hook injects instructions teaching the convention, so the agent explains
first and nothing is wasted:

```
1. agent → explain({ target: "src/auth.ts", lines: [...], why: "..." })
2. agent → Edit(src/auth.ts)
3. hook  → blocks, waiting for you
```

## The compliance problem

A model can simply not call an optional tool. Instructions do not guarantee tool use, and a
teaching plugin that silently stops teaching is worse than no plugin. So when nothing explains a
change, the denial reason doubles as a prompt:

```
1. agent → Edit(src/auth.ts)
2. hook  → deny: "Call `mcp__…__explain` with ticket=t_a1b2 first, then retry unchanged."
3. agent → explain({ ticket: "t_a1b2", lines: [...], why: "..." })
4. agent → Edit(src/auth.ts)      ← same content hash, now has an explanation
5. hook  → blocks, waiting for you
```

That is the fallback, not the norm. Slice 1 shipped *only* this path — `explain()` required a
ticket, and tickets are minted only by denials — so every single change cost a wasted call and
sent its content twice.

**Deny-rate is the health metric**, and `let-me-explain stats` reports it: the fraction of changes
that needed a denial. It was 100% by construction before the instruction layer existed, and 0% in
live sessions after. A rising deny-rate means the instructions have drifted — and instructions
drift invisibly, because nothing crashes when a model quietly stops following them.

## Why the agent never re-sends the code

`explain()` takes `lines: [{ n, note }]` — notes keyed by line number, no code. The daemon already
holds the diff from the intercepted call in step 2. Echoing the content back would roughly double
the token cost of every edit, which directly undercuts the point of this feature.

## How an explanation finds its change

Ahead of the change, by `(sessionId, target)` — the MCP server reads `CLAUDE_CODE_SESSION_ID`
from its environment, which is the same id the hook reports. After a denial, by ticket. See
[architecture.md](../architecture.md#session-identity).

## Never intercept our own tools

`explain()` is itself a tool call, so it passes the PreToolUse hook. Without an exemption, calling
`explain()` would trigger a fresh interception demanding an explanation of the explanation —
infinite regress. `src/hook/policy.ts` exempts `mcp__*__explain` and `mcp__*__answer`.

## Where it lives

| Part | File |
|---|---|
| The `explain()` tool | `src/mcp/server.ts` |
| Injected instructions | `src/daemon/instructions.ts`, `src/hook/session-start.ts` |
| Denial text | `src/daemon/prompts.ts` |
| Shelving, minting and matching | `src/daemon/tickets.ts` |
| The exemption | `src/hook/policy.ts` |
| Learning the real tool name | `src/daemon/tool-name.ts` |
| Deny-rate | `src/core/stats.ts` |

## Related

- [features/01-line-explanations.md](01-line-explanations.md) — what a valid explanation must contain
- [features/04-let-me-try.md](04-let-me-try.md) — what happens after the block
- [architecture.md](../architecture.md) — the enforcement loop in context
- [decisions.md](../decisions.md) — why the denial reason is written as a prompt
