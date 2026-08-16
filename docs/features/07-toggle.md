---
title: Enable / disable toggle
feature: 7
status: partial
relates_to: [architecture, decisions, features/04-let-me-try, reference/cli]
---

# Feature 7 — the off switch

> Switching the plugin off must be trivial, so the user gets plain Claude Code back the moment
> they need speed instead of teaching.

`on` and `off` ship. `observe` is planned — it needs the second window to stream to.

## Why three states, not two

A binary toggle collapses two different needs onto one switch. "I'm in a hurry" and "I don't want
to learn right now" are not the same thing, and if `off` is the only relief valve, the realistic
outcome is that you flip it during a crunch and never flip it back.

| Mode | Explains | Blocks | For |
|---|---|---|---|
| `on` | yes | yes | the full learning loop |
| `observe` 📋 | yes | no | keep the log accruing, read it later |
| `off` | no | no | plain Claude Code |

`observe` is the mode that makes the plugin liveable day to day, which is why it is not a
nice-to-have. It is a strict subset of `on`, so it is cheap to add.

## Usage

```bash
let-me-explain off                 # globally
let-me-explain on
let-me-explain off --session <id>  # just this session
let-me-explain status              # which mode, and is anything pending
```

State is per session with a global default, so turning it off in one project never affects
another. Setting the *global* mode clears session overrides — "off" typed without a session means
off everywhere, not off except where you forgot.

## The three hatches

Escalating, in the order you should reach for them:

| Hatch | Reaches past |
|---|---|
| `let-me-explain off` | normal use |
| `LET_ME_EXPLAIN=0` | a daemon that is misbehaving; no state is touched |
| `claude --settings '{"disableAllHooks": true}'` | us entirely — every hook, ours included |

## Two traps this design has to dodge

### The switch must not need explaining to be thrown

`let-me-explain off` is a `Bash` call, and `Bash` is intercepted. Without an exemption, turning
the plugin off would require sitting through an explanation of the command that turns it off.

`src/hook/policy.ts` exempts our own MCP tools, and any Bash command that invokes our CLI *as a
command* followed by one of our subcommands. It is deliberately not a substring test: that
version exempted every command merely mentioning a path containing `let-me-explain`, which
silently disabled interception for anyone working in a directory of that name.

This is a **correctness requirement, not a nicety** — it is the general trap of a control plane
routed through the thing it controls, the same shape as a firewall rule that blocks the SSH
session you would use to remove it.

### The escape hatch must be exercised, or it rots

`off` is deliberately **the same code path** as "daemon unreachable". The shim already fails open
when it cannot reach the daemon, so defining `off` as "behave exactly as if the daemon were down"
means every crash, restart and timeout is a live test of the disable path.

An escape hatch only exercised when someone types the command is an escape hatch that is broken
the day they finally do.

## Off has to be fast, or it stops being trusted

The shim reads the mode **from disk** and short-circuits before opening any socket:

| Path | Cost |
|---|---|
| `LET_ME_EXPLAIN=0` | ~22 ms — process spawn only |
| mode `off` | ~22 ms — one extra file read |
| mode `off`, asking the daemon over HTTP *(rejected)* | ~50 ms — two round trips |

~22 ms is the cost of spawning Node at all; the plugin adds essentially nothing. The earlier
50 ms design also made the off switch depend on the daemon being responsive, which is exactly
when you least want a dependency.

The cost of this choice: mode-resolution logic is shared between shim and daemon. It lives in one
place — `src/core/mode-file.ts`, hand-rolled and dependency-free so the shim can import it.

## Where it lives

| Part | File |
|---|---|
| Parse and resolve (shared) | `src/core/mode-file.ts` |
| Persistence | `src/daemon/mode.ts` |
| Routes | `src/daemon/routes.ts` (`GET`/`POST /mode`) |
| Short-circuit and env hatch | `src/hook/pretooluse.ts` |
| Never-intercept list | `src/hook/policy.ts` |
| Commands | `src/cli.ts` |
| Tests | `test/killswitch.test.ts`, `test/shim.test.ts` |

## Related

- [decisions.md](../decisions.md) — fail-open, and why `off` shares the failure path
- [architecture.md](../architecture.md) — where the mode check sits in the request flow
- [features/04-let-me-try.md](04-let-me-try.md) — what you are switching off
- [reference/cli.md](../reference/cli.md) — every command
