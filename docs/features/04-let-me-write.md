---
title: Let-me-write
feature: 4
status: shipped
relates_to: [architecture, features/00-single-agent, features/01-line-explanations, reference/cli]
---

# Feature 4 — write it yourself

> The teacher agent also allows the choice to the user to write the command or the code
> themselves to learn by hand and memory as well. A simple YES/NO for the current page or command
> that it wants to execute.

## Why

Reading an explanation and being able to write the thing are different skills, and only the
second one survives. Recognition feels like understanding while you are reading; typing it out is
where you find out whether you actually understood.

## How it works

When the agent retries an explained change, the hook request **blocks** and you get the choice:

```console
$ let-me-explain pending

t_1f6d21e2  Edit  /repo/auth.ts  [awaiting_decision]
  why: Tokens never expired, so a stolen one worked forever.
    1 │ const ttl = 900
      └ how long the token stays valid, in seconds
    2 │ return sign(payload, { expiresIn: ttl })
      └ signs the token so it expires after that time

$ let-me-explain allow t_1f6d21e2     # the agent's edit lands
$ let-me-explain write t_1f6d21e2     # you write it; the agent stands down
```

`allow` and `write` are the YES/NO of the original spec.

## What the agent is told

`write` denies the tool call, and the denial has to do more than refuse — left to itself the agent
will simply try the edit again, or "help" by writing the file for you, which defeats the whole
point. `src/daemon/prompts.ts`:

```
[let-me-explain] The learner is writing this one by hand, to learn it.

Do not retry this edit and do not write the file yourself. Wait for them to tell you
they are done, then read the file to see what they actually wrote and carry on from there.
```

Three instructions, all necessary: don't retry, don't do it anyway, and re-read the file
afterwards rather than assuming the code it proposed is what now exists.

## Why the refusal sticks

A declined ticket is **kept** rather than dropped. If the agent retries the same change, the hash
matches the declined ticket and it is told to stand down again, instead of restarting the explain
dance from scratch. The ticket ages out with the normal TTL (~10 minutes), after which the change
is treated as new.

Compare with `allow`, where the ticket is **consumed** immediately: an approval authorises exactly
one tool call, so a stale approval can never wave through a later edit that happens to hash the
same.

## Blocking without hanging

The hook request parks on a deferred promise until you decide. Two safeguards:

- The daemon's decision timeout is **5 minutes**, comfortably under the harness's 600 s hook
  budget — so the agent always gets an answer from us rather than a timeout from the harness. On
  timeout it allows, and logs that nobody was watching.
- If you decide *before* the agent retries, the decision is stored on the ticket rather than just
  signalled, so it is still there when the retry arrives. Without that, an early approval would be
  lost and the retry would park until timeout.

## Planned

- The second window turns this into a real YES/NO button, and gives you somewhere to actually
  write the code (the VS Code panel gets an editor for free).
- Feature 5's question box: ask before deciding.

## Where it lives

| Part | File |
|---|---|
| Decision routes | `src/daemon/routes.ts` (`/decision`, `/pending`) |
| Blocking and ticket states | `src/daemon/tickets.ts` |
| The stand-down text | `src/daemon/prompts.ts` |
| `pending` / `allow` / `write` | `src/cli.ts` |
| Tests | `test/loop.test.ts`, `test/tickets.test.ts` |

## Related

- [features/01-line-explanations.md](01-line-explanations.md) — what you read before deciding
- [features/07-toggle.md](07-toggle.md) — when you want none of this right now
- [architecture.md](../architecture.md) — ticket states and the deferred-promise registry
- [reference/cli.md](../reference/cli.md) — the commands in full
