---
title: Development
status: shipped
relates_to: [architecture, files, decisions, reference/hook-contract]
---

# Development

## Setup

```bash
npm install
npm run build      # six entries: cli, daemon, mcp server, and three hook shims
npm test           # 212 tests, seconds
npm run typecheck
```

| Script | What it does |
|---|---|
| `npm run build` | `tsup` → `dist/cli.js`, `dist/daemon/main.js`, `dist/hook/pretooluse.js`, `dist/mcp/server.js` |
| `npm test` | `vitest run` |
| `npm run test:watch` | `vitest` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run dev` | `tsx src/cli.ts` — run the CLI without building |

## The dogfood loop

Installing **copies your working tree** into a versioned cache directory
(`~/.claude/plugins/cache/let-me-explain/let-me-explain/<version>/`). It is a snapshot, so
`marketplace update` alone will *not* pick up your changes at the same version. Reinstall:

```bash
npm run build
claude plugin uninstall let-me-explain@let-me-explain --scope local
claude plugin install   let-me-explain@let-me-explain --scope local
```

Then `/reload-plugins` inside any running session.

Two things that bit during setup and will bite again:

- **`claude plugin marketplace add ./` needs the `./`.** A bare `.` is rejected with
  *"Invalid marketplace source format"*.
- **Do not declare `hooks` or `mcpServers` in `plugin.json`.** `hooks/hooks.json` and `.mcp.json`
  are auto-discovered at their default locations. Declaring them too produces
  *"Duplicate hooks file detected"* and the plugin fails to load. Those manifest fields are for
  *additional* files only.

Check what the harness thinks:

```console
$ claude plugin list
  ❯ let-me-explain@let-me-explain
    Version: 0.2.0
    Scope: local
    Status: ✔ enabled
```

`Status: ✘ failed to load` prints the reason on the next line — read it, it is usually exact.

## Driving the daemon without an agent

The whole protocol is reachable with `curl`, which is how it was built and is far faster than
round-tripping through a real session.

```bash
export XDG_STATE_HOME=/tmp/lme/state XDG_RUNTIME_DIR=/tmp/lme/run
node dist/cli.js start

PORT=$(node -e "console.log(require('/tmp/lme/run/let-me-explain/daemon.json').port)")
TOKEN=$(node -e "console.log(require('/tmp/lme/run/let-me-explain/daemon.json').token)")

echo '{"session_id":"demo","cwd":"/repo","tool_name":"Edit","tool_input":
      {"file_path":"/repo/a.ts","old_string":"x","new_string":"const a = 1"}}' \
  | node dist/hook/pretooluse.js          # → deny + a ticket id

curl -s -X POST "http://127.0.0.1:$PORT/explain" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"ticket":"t_…","lines":[{"n":1,"note":"sets a to one"}],"why":"…"}'

node dist/cli.js pending
node dist/cli.js allow t_…
```

Because every path is env-driven (`src/core/paths.ts`), pointing `XDG_*` at a temp directory
gives you a completely isolated instance that cannot disturb your real one.

## The two test suites

```bash
npm test           # seconds, deterministic, gates everything
npm run test:e2e   # minutes, a real model, opt-in
```

`npm test` includes `test/e2e.test.ts`, which walks the whole learner journey with **every piece
real except the model**: the actual hook shim binary, the actual daemon, the actual MCP server
driven through a real MCP client, the actual CLI, and the actual code behind the VS Code button.
The test makes the tool calls a real agent would, in the order it makes them.

It also includes `test/paths.test.ts`, which is the one to extend when you change the flow. Every
bug that has reached real use here has been a **sequence** bug rather than a logic bug — a second
round replaying the first, a finished try leaving its ticket alive, a fix mistaken for a repeat —
and each one was made of individually correct functions. Unit suites cover components; that file
covers orderings: single rounds, two rounds on one file, repeat protection, every finish signal,
concurrency, and degenerate input. Writing it out found a gap nobody had reported.

**If you add a second entry point to an existing operation, add its row to that matrix.** The
recurring failure is a guarantee attached to one code path while the traffic moves to another.
The matrix is indexed and explained in
[reference/test-matrix.md](reference/test-matrix.md) — change that page and `test/paths.test.ts`
together.

`npm run test:e2e` runs the same journey against a real `claude -p` session, with its own config
(`vitest.e2e.config.ts`) so it never joins the fast suite. It needs credentials and a network and
is nondeterministic — a suite that flakes is a suite people stop reading — so it **skips itself
with a message** rather than failing when the CLI or a login is missing.

It exists for the one number no unit test can produce: **deny-rate**. A rise means the injected
instructions have stopped landing, and nothing else would tell you.

Two things the live run needs, both handled in its setup:

- `LET_ME_EXPLAIN_NO_LAUNCH=1`, or every try opens a real editor window.
- `surface: window`, because a headless session can auto-*approve*
  (`--permission-mode acceptEdits`) but there is no auto-*reject* — so "I'll write it myself" can
  only be scripted through our own CLI.

## Testing

No mocks anywhere. Two seams make that possible:

- **`createApp(deps)`** returns a Hono app, so `test/loop.test.ts` drives the entire protocol via
  `app.request()` without binding a port.
- **`FsIo` and `Env` are injected**, so tests run against a real `mkdtemp` directory with the real
  implementation.

### Two traps this suite has already fallen into

**A test that passed for the wrong reason.** `promisify(execFile)` has no `input` option, so the
shim's stdin was never written or closed. It hit its 5-second stdin timeout and fell through to
`allow` — three tests passed green while parsing nothing. The tell was a suite that took 11
seconds instead of one. *Treat a suspiciously slow test as a bug report.* Use `spawn` and close
stdin yourself.

**A fail-open system whose tests all assert the permissive answer.** Every shim test asserts
`allow`, which a shim that did nothing at all would also pass. `test/shim.test.ts` is the
**positive control**: a real daemon, a real shim, asserting a *deny*. Any system with a permissive
default needs at least one test that asserts the non-default outcome.

## Adding a harness adapter

Codex and OpenCode both expose PreToolUse-style interception, so an adapter is a mapping, not new
plumbing. The work is:

1. Map the harness's payload onto `HookEvent` in `src/contracts/index.ts`
   (`sessionId`, `cwd`, `toolName`, `toolInput`).
2. Map our decision back onto whatever that harness expects. Claude Code wants
   `hookSpecificOutput.permissionDecision`; OpenCode uses `output.abort`.
3. Register the shim in that harness's config format.

Everything behind `/hook` is harness-neutral already. See
[reference/hook-contract.md](reference/hook-contract.md).

## Before committing

Framework §2 in the [root README](../README.md):

1. Update the docs for what you changed — including [files.md](files.md) if you added a file.
2. Run the tests for the feature you touched.
3. Reinstall on the harness if the plugin manifest, hooks or MCP config changed.
4. List any new environment variables in the README table.

## Related

- [architecture.md](architecture.md) — what you are building on
- [files.md](files.md) — where things live and why
- [decisions.md](decisions.md) — before you change something load-bearing
- [reference/cli.md](reference/cli.md) · [reference/protocol.md](reference/protocol.md)
