---
title: Design decisions
status: shipped
relates_to: [architecture, files, development]
---

# Decisions, and what lost

Each entry: the call, the alternatives rejected, and the consequence if it were reversed. These
are the things most likely to be "simplified" by someone who does not know why they are there.

---

## The daemon is a separate process from the MCP server

**Rejected:** folding the HTTP server into the MCP server, one per session. Claude Code already
owns that process's lifecycle, so all supervision code would disappear.

**Why it lost:** the MCP server never learns its own `session_id` — Claude Code does not pass it.
With one server per session, `explain()` can land on a different process than the one holding the
ticket, and neither can detect it. Fixing that needs a shared ticket store between per-session
processes, which is the daemon again.

**If reversed:** explanations silently attach to nothing when more than one session is open.

---

## Single package, four build entries — not npm workspaces

**Rejected:** an npm-workspaces monorepo (`packages/contracts`, `packages/daemon`, …), which was
the original plan.

**Why it lost:** the only real constraint is that the hook shim must bundle with zero
dependencies while the daemon uses Hono and Zod. Separate `tsup` entries with `splitting: false`
deliver exactly that through tree-shaking. Workspaces earn their ceremony when the UI package
arrives with its own build — not before. Premature repo structure taxes every command you run.

**Revisit when:** the browser UI lands and needs a Vite build of its own.

---

## Zod in long-lived processes, hand-rolled guards in the shim

**Rejected:** Zod everywhere (consistent), or hand-rolled everywhere (v1's choice — see the
comment in the old `src/core/config.ts`).

**Why this split:** dependency weight is startup cost, and startup cost only matters where it is
paid repeatedly. The daemon and MCP server parse once per process lifetime. The shim spawns on
every single tool call, including when the plugin is off.

**Verify it, don't assume it:** `grep -oE 'from "[^".][^"]*"' dist/hook/pretooluse.js` should show
only Node builtins. Build tools silently do things you did not ask for.

---

## Everything fails open

**Rejected:** failing closed (blocking the tool call) when the daemon is unreachable or a payload
will not parse.

**Why it lost:** ask which direction is recoverable by the user. Fail-open degrades to plain
Claude Code — annoying but survivable, and obvious. Fail-closed means a bad release bricks
someone's editor with no way out short of uninstalling.

**The cost:** a fail-open system's tests can be green while testing nothing, because every failure
path produces the same answer as success. That is why `test/shim.test.ts` exists as a positive
control asserting a *deny*.

---

## `off` shares a code path with `daemon unreachable`

**Rejected:** a separate branch for the off switch.

**Why:** an escape hatch only exercised when someone types the command is an escape hatch that is
broken when they finally do. Defining `off` as "behave exactly as if the daemon were unreachable"
means every crash, restart and timeout is a live test of the disable path.

---

## The shim reads mode from disk, not from the daemon

**Rejected:** asking the daemon over HTTP, like everything else.

**Why:** `off` cost 50 ms via two round trips, versus ~22 ms reading a file — the same as not
having the plugin installed. An off switch that is perceptibly slow stops being trusted. It also
keeps working when the daemon is wedged, which is precisely when you want it.

**The cost:** mode-resolution logic is shared between shim and daemon, so it lives in exactly one
place (`src/core/mode-file.ts`) to stop the two drifting.

---

## JSONL, not SQLite

**Rejected:** `better-sqlite3`.

**Why it lost:** it is a native addon — node-gyp, a compiler toolchain, prebuilt binaries per
platform. For a plugin installed on other people's machines that is a large share of your
install-failure reports. JSONL costs queries we do not need yet.

**Revisit when:** we need real queries. `node:sqlite` is built into Node ≥22.5 with no native
install, and is the upgrade path.

---

## The denial reason is a prompt

**Rejected:** treating `permissionDecisionReason` as an error message for a human.

**Why:** the string lands in the model's context and the model acts on it. Writing it as a
repair instruction ("call `X` with ticket=Y, then retry unchanged") turns the permission system
into a self-correcting loop. Same for `explain()` rejections, which return `isError: true` with
text saying exactly which lines are missing.

**Consequence:** those strings are versioned, reviewed and iterated like prompts, in
`src/daemon/prompts.ts`.

---

## Coverage is validated at the tool boundary

**Rejected:** asking for per-line explanations in the instructions and trusting the model.

**Why:** a prompt is a request; validation is a guarantee. Feature 1 says "every line, explained"
— that is only true if something structurally prevents proceeding without it.

---

## The MCP tool name is learned, not hardcoded

**Rejected:** hardcoding `mcp__plugin_let-me-explain_lme__explain`.

**Why:** the harness decides the exposed name, and a wrong guess fails in the worst way — the
agent is told to call a tool that does not exist, the loop never closes, and every edit
deadlocks. Since the shim observes `tool_name` for every call, we learn the real name instead of
predicting it. Capability detection over version sniffing.

---

## Distribution

**Status: unresolved.** `dist/` is gitignored, and plugin install runs `npm ci --ignore-scripts`,
so a clone never builds itself. Local installs work because the installer copies your working
tree, build output included — a git- or URL-sourced install would ship nothing runnable.

Options, none chosen:

| Option | Cost |
|---|---|
| Commit `dist/` | Build output in git; noisy diffs; easy to forget to rebuild |
| Publish to npm, use an `npm` plugin source | A release step; cleanest for users |
| Use a `command` plugin source that builds on demand | Needs Claude Code ≥2.1.229; runs a build on the user's machine |

---

## Related

- [architecture.md](architecture.md) — what these decisions produced
- [files.md](files.md) — where each one lives in the tree
- [development.md](development.md) — the install path this affects
