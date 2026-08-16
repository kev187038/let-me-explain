---
title: Hook contract
status: shipped
relates_to: [architecture, reference/protocol, features/07-toggle, development]
---

# Hook contract

What Claude Code sends the shim, what it expects back, and the rules that make the shim safe to
put on every tool call. Implemented in `src/hook/pretooluse.ts` and `src/hook/policy.ts`.

## Registration

`hooks/hooks.json`, auto-discovered from that path — **do not also declare it in `plugin.json`**,
or the plugin fails to load with *"Duplicate hooks file detected"*.

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "node",
                    "args": ["${CLAUDE_PLUGIN_ROOT}/dist/cli.js", "start"], "timeout": 15 }] }
    ],
    "PreToolUse": [
      { "matcher": "Edit|Write|MultiEdit|Bash|mcp__.*__explain",
        "hooks": [{ "type": "command", "command": "node",
                    "args": ["${CLAUDE_PLUGIN_ROOT}/dist/hook/pretooluse.js"], "timeout": 600 }] }
    ]
  }
}
```

- **`SessionStart`** starts the daemon *and* prints the instruction block. Claude Code injects a
  `SessionStart` hook's stdout into the session as context, so anything this hook writes, the
  model reads — which is why it prints nothing at all on failure. It runs *before* MCP servers
  connect, which is fine; we never depend on that ordering.
- **`matcher`** is a regex over `tool_name`. `mcp__.*__explain` is in there deliberately: the shim
  lets our own tool through untouched, but reports the name the harness gave it so denials can
  name a tool that provably exists.
- **`timeout: 600`** is what makes blocking on a human viable at all. Our own decision timeout is
  5 minutes, safely under it.

## Input (stdin)

```json
{
  "session_id": "abc123",
  "cwd": "/repo",
  "hook_event_name": "PreToolUse",
  "tool_name": "Edit",
  "tool_input": { "file_path": "/repo/a.ts", "old_string": "x", "new_string": "const a = 1" },
  "tool_use_id": "toolu_01ABC…",
  "transcript_path": "/path/to/transcript.jsonl"
}
```

The shim reads only `session_id`, `cwd`, `tool_name` and `tool_input`, hand-parsed with `typeof`
guards rather than a schema library — it carries no dependencies. Anything missing or malformed
means `allow`.

`tool_use_id` is deliberately unused: a retry is a *new* tool call with a new id, so it cannot
correlate the two attempts. That is what the content hash is for —
[architecture.md](../architecture.md#the-ticket).

## Output (stdout, exit 0)

```json
{ "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow" } }
```

```json
{ "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "…" } }
```

The shim **always exits 0**. Exit 2 would also block the call, but it signals an error rather
than a decision; we only ever want an explicit decision or a pass-through.

`permissionDecisionReason` is not an error message — it lands in the model's context and steers
what it does next. All of these strings live in `src/daemon/prompts.ts` and are written as
instructions.

## Decision order

First match wins. This is the implementation order too.

| # | Condition | Result |
|---|---|---|
| 1 | `LET_ME_EXPLAIN=0` | allow — before any file or network access |
| 2 | stdin unreadable within 5 s, or unparseable | allow |
| 3 | `tool_name` or `session_id` missing | allow |
| 4 | mode file says `off` for this session | allow — read from disk, no network |
| 5 | our own control command or MCP tool | allow (and report the tool name) |
| 6 | no daemon port file | allow |
| 7 | `GET /health` fails or exceeds ~2 s | allow |
| 8 | otherwise | `POST /hook` and return whatever it says |

Step 8 is where the daemon decides: it looks for an explanation shelved ahead of the change, then
for a ticket from a previous denial. See
[architecture.md](../architecture.md#the-happy-path).

Steps 1–7 are all fail-open. A broken plugin degrades to plain Claude Code, never to a blocked
agent — the reasoning is in [decisions.md](../decisions.md).

## Never-intercept list

`src/hook/policy.ts`. Two entries, both correctness requirements rather than conveniences:

| Pattern | Why |
|---|---|
| `Bash` invoking our CLI with one of our subcommands | Otherwise turning the plugin off requires sitting through an explanation of the command that turns it off |
| `mcp__*__explain`, `mcp__*__answer` | Otherwise calling `explain()` triggers a fresh interception demanding an explanation of the explanation — infinite regress |

The Bash match requires `let-me-explain` (or our `dist/cli.js`) to be the command being invoked
**and** to be followed by one of `status|on|off|start|stop|pending|allow|write|stats`.

It used to be a plain substring test, described here as "deliberately over-permissive… the safe
direction." That was wrong, and was caught in a live session: any command mentioning a *path*
containing `let-me-explain` was exempted, so working in a directory of that name silently
disabled interception. A false exemption stops the product teaching; a missed exemption costs one
explanation and is recoverable. Strict is the safe direction.

## Cost

The shim runs on every matched tool call, so its cost is a tax on all your work.

| Path | Cost |
|---|---|
| `LET_ME_EXPLAIN=0` | ~22 ms |
| mode `off` | ~22 ms |
| mode `on`, no daemon | ~22 ms |
| mode `on`, daemon up, nothing to explain | ~50 ms (health check + `/hook`) |

~22 ms is Node process spawn; the shim itself is ~5 KB and imports only `node:fs/promises`,
`node:path` and `node:os`.

## Other harnesses

Everything behind `POST /hook` is harness-neutral. An adapter maps that harness's payload onto
`HookEvent` and its decision shape back — Codex exposes `PreToolUse` behind a `codex_hooks`
feature flag, OpenCode uses `tool.execute.before` with `output.abort`. See
[development.md](../development.md#adding-a-harness-adapter).

## Related

- [architecture.md](../architecture.md) — the full request flow
- [reference/protocol.md](protocol.md) — what `/hook` does with the payload
- [features/07-toggle.md](../features/07-toggle.md) — steps 1, 4 and 5 above
- [development.md](../development.md) — driving the shim by hand
