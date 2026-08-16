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

## The compliance problem

A model can simply not call an optional tool. Instructions do not guarantee tool use, and a
teaching plugin that silently stops teaching is worse than no plugin.

The fix is a **deny-and-retry loop** in which the denial reason doubles as a prompt:

```
1. agent → Edit(src/auth.ts)
2. hook  → deny: "Call `mcp__…__explain` with ticket=t_a1b2 first, then retry unchanged."
3. agent → explain({ ticket: "t_a1b2", lines: [...], why: "..." })
4. agent → Edit(src/auth.ts)      ← same content hash, now has an explanation
5. hook  → blocks, waiting for you
```

Step 2 is a guard rail, not the happy path. Once the agent has learned the convention it calls
`explain()` first and no denial occurs.

**Deny-rate is the health metric.** A rising deny-rate means the instruction set has drifted —
and instructions drift invisibly, because nothing crashes when a model quietly stops following
them. This is the number to watch when feature 3's instruction layer lands.

## Why the agent never re-sends the code

`explain()` takes `lines: [{ n, note }]` — notes keyed by line number, no code. The daemon already
holds the diff from the intercepted call in step 2. Echoing the content back would roughly double
the token cost of every edit, which directly undercuts the point of this feature.

## The ticket

Step 3 needs to know *which* pending change it is explaining, and the MCP server cannot work it
out: it never learns its own `session_id`. So the hook — which does know — mints a ticket and
hands it over inside the denial text. See [architecture.md](../architecture.md#the-ticket).

## Never intercept our own tools

`explain()` is itself a tool call, so it passes the PreToolUse hook. Without an exemption, calling
`explain()` would trigger a fresh interception demanding an explanation of the explanation —
infinite regress. `src/hook/policy.ts` exempts `mcp__*__explain` and `mcp__*__answer`.

## Where it lives

| Part | File |
|---|---|
| The `explain()` tool | `src/mcp/server.ts` |
| Denial text | `src/daemon/prompts.ts` |
| Ticket minting and matching | `src/daemon/tickets.ts` |
| The exemption | `src/hook/policy.ts` |
| Learning the real tool name | `src/daemon/tool-name.ts` |

## Related

- [features/01-line-explanations.md](01-line-explanations.md) — what a valid explanation must contain
- [features/04-let-me-write.md](04-let-me-write.md) — what happens after the block
- [architecture.md](../architecture.md) — the enforcement loop in context
- [decisions.md](../decisions.md) — why the denial reason is written as a prompt
