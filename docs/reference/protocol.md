---
title: Daemon HTTP protocol
status: shipped
relates_to: [architecture, reference/cli, reference/hook-contract]
---

# Daemon HTTP protocol

Implemented in `src/daemon/routes.ts`. All on `127.0.0.1` at an ephemeral port.

## Connecting

The daemon writes its address on startup to `$XDG_RUNTIME_DIR/let-me-explain/daemon.json`
(mode `0600`):

```json
{ "port": 38613, "token": "…64 hex chars…", "pid": 12345, "version": "0.2.0" }
```

Every request except `GET /health` requires `Authorization: Bearer <token>`; without it you get
`401 {"error":"unauthorized"}`. The token authorises approving file edits, hence the file
permissions and the loopback-only bind. **Never bind `0.0.0.0`.**

Reading the file is `readDaemonAddress()` in `src/core/discovery.ts` — deliberately
dependency-free, because the hook shim imports it.

---

## `GET /health`

The only unauthenticated route, so a human can check it with plain `curl`. Returns nothing
sensitive.

```console
$ curl -s http://127.0.0.1:$PORT/health
{"ok":true,"version":"0.2.0","pid":12345}
```

The shim calls this with a ~2 s timeout before committing to a possibly-long `/hook` request. A
wedged daemon fails here and the call is allowed.

---

## `POST /hook`

The intercepted tool call. It answers immediately with `ask` under `surface: prompt`, and blocks
under `surface: window` or while a **let-me-try** is in flight for that target — in the latter
case for as long as the hook's configured timeout allows, ending when the learner stops typing.
Neither try outcome ever returns `allow`: running the tool would overwrite what they wrote.

**Request** — a harness-neutral `HookEvent`:

```json
{
  "sessionId": "abc123",
  "cwd": "/repo",
  "toolName": "Edit",
  "toolInput": { "file_path": "/repo/a.ts", "old_string": "x", "new_string": "const a = 1" }
}
```

**Response** — always `200`, always the harness's PreToolUse shape:

```json
{ "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "[let-me-explain] The learner reads this before it runs. …" } }
```

An unparseable body returns `allow` rather than an error — see the fail-open rule in
[decisions.md](../decisions.md).

---

## `POST /explain`

Called by the MCP server on the agent's behalf, in one of two forms.

**Ahead of the change** (the normal path) — identified by session and target:

```json
{
  "sessionId": "c394cbf2-…",
  "target": "/repo/auth.ts",
  "lines": [{ "n": 1, "note": "how long the token stays valid, in seconds" }],
  "why": "Tokens never expired, so a stolen one worked forever."
}
```

Returns `200 {"ok":true,"pending":true,"next":"…"}`, or `400` if the notes fail the checks that
need no code in hand — none sent, or over the word cap. Coverage is not judged here (the daemon has
not seen the content yet) and is not a gate anywhere. The explanation is shelved under
`(sessionId, target)` with a ~2 minute TTL and bound when the matching tool call arrives.

`next` is the reply the MCP server hands straight back to the agent. It asks the agent to put a
menu to the learner via `AskUserQuestion` — **Yes, go ahead** / **Let me try** / **Explain more
first** — naming the real `let_me_try` tool, and ends with an instruction to skip the menu where
that tool does not exist (`-p` mode has no interactive user). Nothing sends the answer back: the
hook stays the only gate, so a skipped menu costs the choice, never the explanation.

**After a denial** (the fallback) — identified by ticket:

```json
{ "ticket": "t_1f6d21e2", "lines": [...], "why": "..." }
```

| Status | Body | When |
|---|---|---|
| `200` | `{"ok":true,"ticket":"t_…"}` | accepted; the ticket moves to `awaiting_decision` |
| `200` | `{"ok":true,"pending":true}` | shelved ahead of the change |
| `400` | `{"ok":false,"error":"Note(s) on line(s) 1 exceed 25 words. …"}` | failed validation, or neither a ticket nor a target was given |
| `404` | `{"ok":false,"error":"Unknown or expired ticket \"t_…\". Retry the tool call to get a fresh one."}` | no such ticket, or it aged out |

The `error` strings are surfaced verbatim to the agent as a tool error, so it can self-correct.
Rules enforced: [features/01-line-explanations.md](../features/01-line-explanations.md).

The MCP server fills in `sessionId` itself from `CLAUDE_CODE_SESSION_ID`; the model never supplies
it.

---

## `GET /instructions`

Returns the instruction block as `text/plain`. The `SessionStart` hook prints this to stdout,
which Claude Code injects into the session as context.

Rendered by the daemon rather than the hook because only the daemon knows the name the harness
gave our MCP tool.

---

## `GET /pending`

Everything not yet resolved, with code and notes aligned. This is what `let-me-explain pending`
renders.

```json
{ "pending": [{
    "ticket": "t_1f6d21e2",
    "sessionId": "abc123",
    "toolName": "Edit",
    "state": "awaiting_decision",
    "target": "/repo/auth.ts",
    "lines": [{ "n": 1, "code": "const ttl = 900", "note": "how long the token stays valid" }],
    "why": "Tokens never expired, so a stolen one worked forever." }] }
```

`state` is `awaiting_explanation` or `awaiting_decision`. `note` is absent on lines not yet
explained. This is a projection of the internal ticket, not the ticket itself, so internals can
change without breaking clients.

---

## `POST /decision`

Resolve a blocked call. `{"ticket":"t_…","decision":"allow"|"try"}`. This is what both VS Code
buttons and `let-me-explain allow` / `try` call.

| Status | When |
|---|---|
| `200` `{"ok":true}` | recorded; any parked `/hook` request resolves immediately |
| `400` | malformed body |
| `409` | the ticket is not waiting for a decision (already resolved, or never explained) |

You may decide *before* the agent retries. The decision is stored on the ticket, so the later
retry picks it up instead of parking.

---

## `GET /active`

What a status bar polls, in one request: both things that can be waiting on you.

```json
{
  "tries": [{ "sessionId": "…", "target": "src/auth.ts", "path": "/repo/src/auth.ts" }],
  "held":  [{ "ticket": "t_…", "sessionId": "…", "target": "src/auth.ts",
              "why": "…", "explanation": "why: …\n  1  names the …" }]
}
```

`held` carries the rendered explanation so the button's tooltip needs no second request. It lists
only tickets with a request genuinely parked on them — under `surface: prompt` tickets sit in
`awaiting_decision` so a retry re-asks, but nobody is waiting, and offering a button there would
answer a question that was never put to us.

**Send `x-let-me-explain-client: buttons/1`** if you can render the choice. Only a poll carrying
that header marks a decider as present; without one the `/hook` route refuses to hold a change open
and falls back to Claude Code's prompt. Requests without it are still served — they just do not
count. This exists because a poll proves someone is watching, not that they can act.

---

## `POST /try` · `POST /done`

`POST /try` has two entry points, because the learner can choose to type a change either before or
after the agent attempts it:

| When | State | Response |
|---|---|---|
| After a denial or a held prompt — a ticket exists | code and notes both known | `{"ok":true,"status":"open"}` — tutorial written, editor opened |
| Straight from the `AskUserQuestion` menu — only a pre-explanation exists | notes known, **code not yet** | `{"ok":true,"status":"armed"}` — the choice is remembered |

`armed` is the normal path now. A pre-explanation carries notes and a `why` but no code, and the
tutorial needs the code the agent intended to write — that only reaches the daemon as `toolInput`
on the tool call. So the choice is held, and `POST /hook` writes the tutorial and parks the moment
the call arrives. An armed choice expires with the ticket TTL so it cannot ambush an unrelated
later change to the same file.

`/try` takes `{sessionId, target, cwd, termProgram?, claudeSsePort?, editor?}`. It writes the
tutorial, opens the learner's editor, and **returns immediately** with `{ok, status:"open"}`.
Calling it again while one is open is a no-op rather than a second editor window.

The waiting happens in `POST /hook` on the agent's retry, because a hook's timeout budget is set
by us while an MCP request is capped at the SDK's 60 s default.

`404` when nothing is pending for that target — the change has to be proposed and explained first.

`/done` takes `{sessionId, target?}` and ends the wait immediately. `{ok:false}` if nothing was
waiting.

The environment fields come from the **MCP server**, not the daemon: the daemon may have been
started by a different session with a different editor.

---

## `POST /clean` · `GET /tutorials`

`/clean` with `{sessionId}` removes that session's tutorials, or with `{}` removes all. Returns
`{ok, removed}`. `/tutorials` lists the paths.

---

## `POST /surface`

`{"surface":"prompt"|"window","sessionId":"…"}` → `{"ok":true,"surface":"prompt"}`. Omit
`sessionId` to set the global default. The effective surface is reported by `GET /mode`.

---

## `POST /outcome`

`{"sessionId":"…","toolName":"Edit","event":"PostToolUse"|"PermissionDenied"}` → `{"ok":true}`.

How the outcome gets back when Claude Code owns the approval prompt: the PreToolUse hook returned
`ask` and exited, so it never learned what you chose. Logged as `decision.approved` or
`decision.rejected` and counted by `let-me-explain stats`.

---

## `GET /mode` · `POST /mode`

```console
$ curl -s -H "authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT/mode?sessionId=abc123"
{"mode":"on","global":"on","sessions":{}}
```

`mode` is the effective mode for the given session; `global` and `sessions` are the raw file.

`POST` takes `{"mode":"on"|"off","sessionId":"…"}` — omit `sessionId` to set the global default,
which also clears session overrides. Returns `{"ok":true,"mode":"off"}`.

The hook shim does **not** use these routes. It reads the mode file directly so that `off` costs
no network round trip and survives an unresponsive daemon —
[features/07-toggle.md](../features/07-toggle.md).

---

## `POST /observed`

`{"toolName":"mcp__plugin_let-me-explain_lme__explain"}` → `{"ok":true,"explain":"…"}`.

The shim reports our own MCP tool as the harness actually named it, so later denials can name a
tool that provably exists rather than one we guessed. See `src/daemon/tool-name.ts`.

---

## Related

- [architecture.md](../architecture.md) — the request flow these routes implement
- [reference/hook-contract.md](hook-contract.md) — what the harness sends the shim
- [reference/cli.md](cli.md) — the CLI wraps these routes
