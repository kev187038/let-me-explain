---
title: Architecture
status: shipped
relates_to: [files, decisions, features/00-single-agent, features/07-toggle, reference/protocol, reference/hook-contract]
---

# Architecture

Three processes. The daemon is a singleton per user; the MCP server and the hook shim are both
just clients of it.

```
Claude Code ──spawns──► MCP server ──POST /explain────►┐
     │                                                 │
     └──PreToolUse──► hook shim ──POST /hook──────────► daemon (127.0.0.1)
                                 ◄──blocks, then────── │
                                    allow / deny        │
                                                        │
                          you ──── CLI ─────────────────┘
                                (pending / allow / write)
```

## Why three processes

Two integration points exist, and they do opposite jobs:

- A **hook** is control flow. It runs outside the model and can veto a tool call, so it is the
  only thing that can make an agent wait for a human.
- An **MCP tool** is data flow. It runs because the model chose to call it, so it is the only
  thing that can carry the model's own reasoning out of the model.

You need both. A hook cannot ask the model "why did you write this?" — only the model knows. An
MCP tool cannot stop an edit. The daemon is the third process because it is the only thing both
can reach, and because it has to outlive an individual tool call.

### Why the daemon is not folded into the MCP server

Claude Code owns the MCP server's lifecycle, so one server per session would need no supervision
code. The daemon is still a separate singleton because it owns things that outlive and span
sessions: the on/off mode, cross-session `stats`, and state that survives an MCP server restart.

> **Correction.** Earlier versions of this page justified the split by claiming *the MCP server
> never learns its own `session_id`*. That is false — see below. The decision stands, but not for
> that reason.

## Session identity

Both sides know the session id, which is what allows an explanation to arrive *before* the change
it describes:

| Component | Source |
|---|---|
| hook shim | `session_id` in the PreToolUse payload |
| MCP server | `CLAUDE_CODE_SESSION_ID` in its environment |

Measured in a live session — the two are identical:

```
hook  session_id             : c394cbf2-2b4b-4590-bc8c-0393dd9203b0
MCP   CLAUDE_CODE_SESSION_ID : c394cbf2-2b4b-4590-bc8c-0393dd9203b0
```

Claude Code also passes `CLAUDE_PROJECT_DIR`, `CLAUDE_PLUGIN_ROOT` and `CLAUDE_PLUGIN_DATA`.

## The ticket

The **ticket** identifies a change that has already been attempted and denied. It is minted by the
hook and handed to the agent inside the denial reason, so the agent can explain the exact change
that was refused.

```ts
ticket = { id, sessionId, cwd, toolName, toolInput, hash, state, explanation?, createdAt }
hash   = sha256(canonicalJson({ toolName, toolInput }))
```

Tickets are keyed by `(sessionId, hash)`, so two sessions making a byte-identical change each get
their own approval.

`canonicalJson` sorts keys recursively. This is load-bearing: a retry is a **fresh generation**
from the model, so key order can differ between the first attempt and the retry. Plain
`JSON.stringify` would hash to different bytes, the retry would never match its own ticket, and
every edit would be denied forever with no visible cause. See `src/core/canonical.ts`.

### States

```
awaiting_explanation ──explain()──► awaiting_decision ──allow──► resolved:allow ──► consumed
        ▲                                   │
        └── retry finds the same hash ──────┴──write──► resolved:write (do not retry)
```

- **Approval is consumed.** It authorises exactly one tool call, then the ticket is dropped, so a
  stale approval can never authorise a later edit.
- **`write` sticks.** The ticket is kept until it ages out, so a retrying agent keeps being told
  to stand down instead of restarting the explain dance.
- **TTL ~10 minutes.** A ticket that has sat unresolved that long no longer describes code that
  still matters.

## The happy path

The `SessionStart` hook injects instructions teaching the agent to explain *before* it acts, so
the normal sequence costs no wasted call:

1. Agent calls `explain({ target, lines, why })`. The MCP server adds the session id from its
   environment. The daemon shelves it as a **pre-explanation**, keyed `(sessionId, target)`.
2. Agent makes the edit. `PreToolUse` fires, finds the shelved explanation, and validates it
   against the lines that actually turned up.
3. It fits → the daemon mints a ticket already in `awaiting_decision` and **holds the request
   open** while you read.
4. You decide: `allow` releases it; `write` denies with a stand-down message.

A pre-explanation is a *claim* about content the daemon has not seen yet, so step 2's validation
is the safety story: it binds only if it covers the real change. Pre-explanations carry a short
TTL (~2 min) and are consumed on bind, so one explanation authorises one change.

## The fallback: deny and retry

If the agent acts without explaining — instructions do not guarantee tool use — the denial reason
doubles as a prompt:

1. `PreToolUse` fires with nothing shelved and no matching ticket → `permissionDecision: "deny"`,
   reason: *"Call `…__explain` with ticket=t_a1b2 first."*
2. Agent calls `explain({ticket, lines, why})`. Only the notes travel; the daemon already has the
   content from step 1.
3. Agent retries. The hash matches the explained ticket → blocks for you as above.

A shelved explanation that does *not* fit the change degrades to this same path, with a reason
saying what did not match.

**Deny-rate is the health metric** for the instruction set: the fraction of intercepted changes
that needed a denial. `let-me-explain stats` reports it. It was 100% before the instruction layer
existed, and 0% in live sessions after. A rising deny-rate means the instructions have drifted.

## Request flow

Read top to bottom; the first matching row wins. This is also the implementation order in
`src/hook/pretooluse.ts`.

```
PreToolUse(tool, input)
  LET_ME_EXPLAIN=0 ................................ allow   (no file or network access at all)
  mode file says off .............................. allow   (read from disk, no network)
  our own control command / MCP tool .............. allow
  no daemon port file ............................. allow   (fail open)
  daemon fails a ~2s health check ................. allow   (fail open)
  tool has nothing explainable .................... allow
  ticket already declined with `write` ............ deny  "do not retry"
  ticket already approved ......................... allow   (consume it)
  ticket exists, not yet explained ................ deny  "call explain, ticket=X"
  pre-explanation fits this change ................ BLOCK until decision or timeout
  pre-explanation does not fit .................... deny  "did not match", + ticket
  nothing explains this change .................... deny  "call explain, ticket=X"
  ticket explained ................................ BLOCK until decision or timeout
        allow ..................................... allow
        write ..................................... deny  "do not retry"
        timeout ................................... allow   (fail open)
```

## How blocking works

The daemon holds a pending hook request open with a **deferred-promise registry**: the `/hook`
handler `await`s a promise stored under the ticket id, and `/decision` resolves it. No polling,
no second connection. See `src/daemon/tickets.ts`.

Two rules come with it:

- **Always resolve, never hang.** The daemon's decision timeout is 5 minutes, comfortably under
  the harness's 600 s hook budget, so the agent always gets an answer from us rather than a
  timeout from the harness. On timeout we allow.
- **Store the decision, don't just signal it.** If you approve before the agent gets round to
  retrying, `resolve()` would fire with nobody listening and the retry would then park until
  timeout. The decision is written onto the ticket, so `awaitDecision` returns immediately when
  one is already recorded.

## Failure modes

Everything fails open. A broken plugin degrades to plain Claude Code, never to a blocked agent.

| What breaks | What happens |
|---|---|
| Daemon not running | Every call allowed; the shim exits in ~22 ms |
| Daemon wedged | Health check times out after ~2 s; call allowed |
| Malformed hook payload | Parse fails; call allowed |
| Nobody answers a blocked call | Auto-allow after 5 minutes, logged |
| Log write fails | Swallowed — losing a log line must not cost you an edit |

The one thing that is *not* fail-open is `explain()` validation: a bad explanation is rejected
back to the agent so it corrects itself. That is a self-repair loop, not a failure.

## Related

- [files.md](files.md) — which file does which part of this
- [decisions.md](decisions.md) — why this shape, and what was rejected
- [features/00-single-agent.md](features/00-single-agent.md) — the enforcement loop in depth
- [features/07-toggle.md](features/07-toggle.md) — the off switch and its traps
- [reference/protocol.md](reference/protocol.md) — the routes named above
- [reference/hook-contract.md](reference/hook-contract.md) — the harness ↔ shim payloads
