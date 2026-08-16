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

The intercepted tool call. Under `surface: prompt` it answers immediately with `ask`. Under
`surface: window` **it may block for minutes** — that is the point — resolving when a decision
arrives or after the 5-minute timeout.

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

Returns `200 {"ok":true,"pending":true}`. Nothing is validated yet — the notes describe content
the daemon has not seen. It is shelved under `(sessionId, target)` with a ~2 minute TTL, and
checked when the matching tool call arrives.

**After a denial** (the fallback) — identified by ticket:

```json
{ "ticket": "t_1f6d21e2", "lines": [...], "why": "..." }
```

| Status | Body | When |
|---|---|---|
| `200` | `{"ok":true,"ticket":"t_…"}` | accepted; the ticket moves to `awaiting_decision` |
| `200` | `{"ok":true,"pending":true}` | shelved ahead of the change |
| `400` | `{"ok":false,"error":"Missing notes for line(s): 2. …"}` | failed validation, or neither a ticket nor a target was given |
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

Resolve a blocked call. `{"ticket":"t_…","decision":"allow"|"write"}`.

| Status | When |
|---|---|
| `200` `{"ok":true}` | recorded; any parked `/hook` request resolves immediately |
| `400` | malformed body |
| `409` | the ticket is not waiting for a decision (already resolved, or never explained) |

You may decide *before* the agent retries. The decision is stored on the ticket, so the later
retry picks it up instead of parking.

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
