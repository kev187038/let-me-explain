---
title: CLI reference
status: shipped
relates_to: [reference/protocol, features/04-let-me-write, features/07-toggle, development]
---

# CLI reference

Implemented in `src/cli.ts`. Installed as `let-me-explain`; runnable unbuilt with
`npm run dev -- <command>`, or from the plugin copy with
`node ~/.claude/plugins/cache/let-me-explain/let-me-explain/<version>/dist/cli.js`.

With the default `surface: prompt`, Claude Code collects your decision and the commands below are
for inspection and control. Under `surface: window` the daemon holds each change instead, and
`pending` / `allow` / `write` become how you answer.

```
let-me-explain

  status              is it running, and which mode
  on | off            teaching on, or plain Claude Code back
  start | stop        run the background daemon
  pending             what the agent is waiting on
  allow <ticket>      let this change through
  write <ticket>      take it over and write it yourself
  stats               how often the agent explains before being asked
  surface <where>     prompt (inline in Claude Code) or window (held for the CLI)

  --session <id>      scope on/off to one session instead of globally
```

---

## `status`

Never fails when the daemon is down — being down is a normal state, not an error.

```console
$ let-me-explain status
let-me-explain: running on 127.0.0.1:38613
  mode:    on
  pending: 0

$ let-me-explain status      # daemon not running
let-me-explain: not running (agent runs unaffected)
```

## `start` · `stop`

`start` spawns the daemon detached and waits up to 5 s for its port file. It is idempotent — an
`O_EXCL` lock means a second daemon cannot start. The plugin's `SessionStart` hook runs this, so
you rarely need it by hand.

```console
$ let-me-explain start
started

$ let-me-explain start
already running

$ let-me-explain stop
stopped
```

`stop` sends `SIGTERM` to the pid in the port file, which removes the port and lock files on the
way out.

## `on` · `off`

```console
$ let-me-explain off
teaching off — plain Claude Code until you turn it back on

$ let-me-explain on
teaching on

$ let-me-explain off --session abc123     # only that session
```

Without `--session` this sets the global default *and* clears session overrides. Full behaviour:
[features/07-toggle.md](../features/07-toggle.md).

## `pending`

```console
$ let-me-explain pending

t_1f6d21e2  Edit  /repo/auth.ts  [awaiting_decision]
  why: Tokens never expired, so a stolen one worked forever.
    1 │ const ttl = 900
      └ how long the token stays valid, in seconds
    2 │ return sign(payload, { expiresIn: ttl })
      └ signs the token so it expires after that time

$ let-me-explain pending
nothing waiting
```

`[awaiting_explanation]` means the agent has not explained yet — there is nothing for you to
decide on, and lines appear without notes.

## `allow <ticket>` · `write <ticket>`

```console
$ let-me-explain allow t_1f6d21e2
t_1f6d21e2: allow

$ let-me-explain write t_1f6d21e2
t_1f6d21e2: write
```

`allow` releases the blocked call and the edit lands. `write` denies it and tells the agent to
stand down so you can write the code yourself.

## `surface`

Where the explanation appears and who collects the decision.

```console
$ let-me-explain surface prompt
surface: prompt — explanations appear in Claude Code's approval prompt

$ let-me-explain surface window
surface: window — changes are held; decide with `pending` then `allow`/`write`
```

`prompt` is the default. `window` is what `pending` / `allow` / `write` below operate on — with
`prompt` set, Claude Code has already collected your answer and there is nothing pending.

---

## `stats`

Reads the JSONL session logs and reports whether the instruction layer is working.

```console
$ let-me-explain stats
  intercepted        1
  explained upfront  1   (100%)
  needed a denial    0   (0%)   <- deny-rate
  decisions          1 approved · 0 rejected
```

**Deny-rate is the number to watch.** It is the fraction of changes the agent made without
explaining first, so it measures whether the injected instructions are still landing. It was 100%
before the instruction layer existed. A rising deny-rate means the instructions have drifted —
and instructions drift silently, because nothing crashes when a model stops following them.

`mismatched` appears when a pre-explanation failed to match the change that arrived, and
`rejected` when an explanation failed validation, with the most common reason.

Needs no daemon — it reads the logs directly.

---

Errors are plain and go to stderr with exit code 1:

```console
$ let-me-explain allow t_nope
/decision: ticket is not waiting for a decision

$ let-me-explain allow
usage: let-me-explain allow <ticket>

$ let-me-explain pending      # with no daemon
let-me-explain is not running. Start it with: let-me-explain start
```

---

## Environment

Every path is env-driven via `src/core/paths.ts`, so pointing `XDG_STATE_HOME` and
`XDG_RUNTIME_DIR` at a temp directory gives a fully isolated instance:

```bash
XDG_STATE_HOME=/tmp/lme/state XDG_RUNTIME_DIR=/tmp/lme/run let-me-explain start
```

`LET_ME_EXPLAIN=0` affects the hook shim, not the CLI — the CLI is how you turn things back on, so
it must keep working regardless.

Full table: [root README](../../README.md#environment-variables).

## Related

- [reference/protocol.md](protocol.md) — the routes these commands call
- [features/04-let-me-write.md](../features/04-let-me-write.md) — `pending` / `allow` / `write` in context
- [features/07-toggle.md](../features/07-toggle.md) — `on` / `off` in context
- [development.md](../development.md) — driving the daemon with `curl` instead
