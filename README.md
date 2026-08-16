# let-me-explain

A plugin for a coding-agent harness that gives a junior developer a better chance to learn while
working with AI. Every line of code the agent writes, and every command it runs, is explained
before it happens — and nothing lands until you say so.

We refer to the **Coding Agent** as the normal coding agent, and to the **Teacher Agent** as the
agent that explains to the user what is going on. Today they are the same agent (feature 0).

```
you: fix the token expiry bug

  ⏸  let-me-explain is holding an edit to src/auth.ts

  $ let-me-explain pending

    t_1f6d21e2  Edit  /repo/auth.ts  [awaiting_decision]
      why: Tokens never expired, so a stolen one worked forever.
        1 │ const ttl = 900
          └ how long the token stays valid, in seconds
        2 │ return sign(payload, { expiresIn: ttl })
          └ signs the token so it expires after that time

  $ let-me-explain allow t_1f6d21e2
```

---

## Status

Slice 1 ships the core loop. There is no second window yet — the CLI is the interface.

| Feature | Status |
|---|---|
| 0 · Teacher and Coding Agent are one agent | ✅ shipped |
| 1 · Explanations chunked per line | ✅ shipped (per line; per token planned) |
| 2 · Choose which lines get explained | 📋 planned |
| 3 · Teacher-Agent instructions | ✅ shipped — injected per session; personalisation planned |
| 4 · Let-me-write | ✅ shipped |
| 5 · Question section | 📋 planned |
| 6 · Install as a harness plug-in | ✅ shipped (Claude Code; Codex/OpenCode planned) |
| 7 · Enable / disable toggle | 🔶 partial — `on`/`off` shipped, `observe` planned |
| Second window (browser UI) | 📋 planned — see [docs/architecture.md](docs/architecture.md) |

✅ shipped · 🔶 partial · 📋 planned

---

## Install

Requires **Node ≥ 20.11** and Claude Code. `dist/` is not committed, so you build before you
install — the installer copies your working tree as-is.

```bash
git clone <this-repo> let-me-explain
cd let-me-explain
npm install
npm run build

claude plugin marketplace add ./
claude plugin install let-me-explain@let-me-explain --scope local
```

The path must start with `./` — a bare `.` is rejected. If the install summary says
`Run /reload-plugins to activate`, run it inside your Claude Code session.

Check it landed:

```console
$ claude plugin list
  ❯ let-me-explain@let-me-explain
    Version: 0.2.0
    Scope: local
    Status: ✔ enabled
```

Dependencies install automatically into the plugin copy; you don't need to do anything else.

## Try it in 60 seconds

Open Claude Code in a scratch repo and ask for something small. Instructions injected at session
start teach the agent to explain first, so its edit **blocks** straight away. In another terminal:

```console
$ let-me-explain pending

t_61dd5d39  Bash  shell  [awaiting_decision]
  why: You asked for the current date saved to a file under /tmp/lme-live, which may not exist
       yet, so the command creates the folder and then writes the date into it.
    1 │ mkdir -p /tmp/lme-live && date > /tmp/lme-live/when.txt
      └ Create the /tmp/lme-live folder, doing nothing if it already exists, then write today's
        date and time into when.txt inside it.
```

If the agent forgets to explain first, its tool call is refused and the refusal tells it what to
do — then it explains and retries:

```
[let-me-explain] The learner reads this before it runs.

Call `mcp__plugin_let-me-explain_lme__explain` with:
  ticket: "t_1f6d21e2"
  lines:  one {n, note} per non-blank line of the new content, numbered from 1 (2 line(s) here)
  why:    one or two sentences on the problem this solves

Each note: under 25 words, plain language, no jargon, say what that line does.
Then retry this exact tool call, unchanged.
```

That fallback should be rare. Check with:

```console
$ let-me-explain stats
  intercepted        1
  explained upfront  1   (100%)
  needed a denial    0   (0%)   <- deny-rate
  decisions          1 allow · 0 write
  median wait        3.3s
```

Then either let it through, or take it over yourself:

```console
$ let-me-explain allow t_1f6d21e2     # the edit lands
$ let-me-explain write t_1f6d21e2     # you write it by hand; the agent stands down
```

Lazy explanations are rejected before you ever see them, and the agent is told why:

```console
$ # agent explained only line 1 of 2
{"ok":false,"error":"Missing notes for line(s): 2. Every non-blank line needs exactly one note."}

$ # agent wrote a 30-word note
{"ok":false,"error":"Note(s) on line(s) 1 exceed 25 words. Say the one thing that line does, plainly."}
```

## Turning it off

Three hatches, in escalating order. Use the first one that fits.

```bash
let-me-explain off                              # back to plain Claude Code
let-me-explain on                               # teaching back on
let-me-explain off --session <id>               # just this session

LET_ME_EXPLAIN=0 claude                         # bypass without touching state
claude --settings '{"disableAllHooks": true}'   # disable every hook, ours included
```

`off` costs about **22 ms per tool call** — the same as having no plugin, because the shim reads
the mode from disk and never opens a socket. If the daemon dies, every call is allowed: `off` and
`daemon unreachable` are deliberately the same code path, so the escape hatch is exercised by
every failure instead of only when you need it. See [docs/features/07-toggle.md](docs/features/07-toggle.md).

## CLI

| Command | What it does |
|---|---|
| `let-me-explain status` | Is the daemon running, which mode, how many pending |
| `let-me-explain on` / `off` | Teaching on, or plain Claude Code back |
| `let-me-explain start` / `stop` | Run or stop the background daemon |
| `let-me-explain pending` | What the agent is waiting on, with explanations |
| `let-me-explain allow <ticket>` | Let this change through |
| `let-me-explain write <ticket>` | Take it over and write it yourself |
| `let-me-explain stats` | How often the agent explains before being asked |
| `--session <id>` | Scope `on`/`off` to one session instead of globally |

Full reference: [docs/reference/cli.md](docs/reference/cli.md).

## Environment variables

None are required. All are read once at the process edge in `src/io/env.ts`.

| Variable | Effect |
|---|---|
| `LET_ME_EXPLAIN=0` | Hard bypass. The shim allows and exits before any file or network access |
| `XDG_STATE_HOME` | Where mode and session logs live (default `~/.local/state/let-me-explain`) |
| `XDG_RUNTIME_DIR` | Where the daemon's port/token file lives (default: under state dir) |
| `XDG_CONFIG_HOME` | Config location (default `~/.config/let-me-explain`) |
| `APPDATA` | Windows fallback for the above |
| `HOME` | Fallback root for every path |
| `CLAUDE_PLUGIN_ROOT` | Supplied by the harness; used in `hooks/hooks.json` and `.mcp.json` |

---

## Features

Each feature has a page in [docs/features/](docs/features/) with the design and the reasoning.

**0. ✅ Teacher Agent and Coding Agent coincide, to use fewer tokens.**
*Why:* a second model would have to be re-told everything the coding agent already knows. The
coding agent explains its own work through an MCP tool, so the "why" costs nothing to reconstruct.
It needs a guard, since a model can simply not call the tool —
[docs/features/00-single-agent.md](docs/features/00-single-agent.md).

**1. ✅ Chunk command / new code in lines as tokens: every token is explained as a line in its
context.** Worth considering chunking by word.
*Why:* a diff you cannot read teaches nothing. Coverage is enforced at the tool boundary rather
than requested in a prompt, so "every line explained" is an invariant the model cannot skip —
[docs/features/01-line-explanations.md](docs/features/01-line-explanations.md).

**2. 📋 Code / command line choice: the user can in this second window choose the lines that the
agent needs to explain.**
*Why:* once you understand a pattern, re-reading it is friction. Needs the second window first.

**3. ✅ Teacher-Agent instructions.** We want the learning process as smooth as possible, so we
curb the usual AI lingo: things need to be easy to explain, and explanations need to be **brief**.
No walls of text that are an eye-sore to read. Every token, explained, simply. After this, **the
second part is the wider context of what is being done in that command / edit to file and why**
(we are solving this bug…, this feature needs this because…). This too needs to be a small
section. The agent also needs to stop putting useless comments above the code it makes — just the
comment that explains the whole page, or borderline problems.
*Why:* brevity is the whole product. Verbose teaching gets skipped, and skipped teaching is worse
than none. The instructions are injected into every session by the `SessionStart` hook and the
word caps are enforced at the tool boundary, so they are invariants rather than requests.
Personalisation (role, seniority, focus areas) and an eval suite are still planned.

**4. ✅ Let-me-write: the user can choose to write the command or the code themselves**, to learn
by hand and memory as well.
*Why:* reading an explanation and being able to write the thing are different skills. The denial
tells the agent to stand down and not retry —
[docs/features/04-let-me-write.md](docs/features/04-let-me-write.md).

**5. 📋 Question section:** a separated section for any question the user wants to ask on the
code/command being done.
*Why:* the moment you don't understand something is the moment to ask. Needs an `answer()` tool
and the second window.

**6. ✅ Simple installation to the harness as a plug-in.** Claude Code, Codex or OpenCode.
*Why:* a learning tool nobody can install teaches nobody. Claude Code works today; all three
harnesses expose the same interception shape, so the others are adapters rather than rewrites.

**7. 🔶 Enable / disable toggle.** Switching the plugin off must be trivial, so the user gets plain
Claude Code back the moment they need speed instead of teaching. Three states rather than two:
- **on** — explain and block, the full learning loop. ✅
- **observe** — explanations still stream to the second window, but nothing ever blocks. The
  learning log without the friction; read it afterwards. 📋
- **off** — full pass-through, the plugin is invisible. ✅

Flippable from the CLI today; from the second window and a `/let-me-explain` slash command once
those exist. State is per session with a global default, so turning it off in one project never
affects another.
*Why:* an off switch that is slow or awkward gets thrown once and never thrown back —
[docs/features/07-toggle.md](docs/features/07-toggle.md).

---

## Framework

1. **AI-AGENT friendly documentation:** all features and layers must be documented in a `docs/`
   folder with a common layout creating a wiki. This wiki speaks for every page about a feature
   but also speaks about the relationship between this feature and the others, with links to the
   other pages of the wiki to access it immediately. → [docs/](docs/)

2. **Pre-commit rules:**
   a. Documentation must be updated
   b. tests must be run about the feature that was created/modified
   c. if needed retry the deployment on the Claude Code harness
   d. list any new env vars if there are any to set

3. **Architecture** — full version in [docs/architecture.md](docs/architecture.md).

   A background **daemon** owns all session state. A **PreToolUse hook** intercepts every
   Edit / Write / MultiEdit / Bash and blocks while the daemon holds the pending change and waits
   for the user. An **MCP server** gives the Coding Agent an `explain()` tool — the side-channel
   that carries explanations out of the agent instead of into the terminal.

   The hook is the only thing that can *block* the agent; the MCP tool is the only thing that can
   *carry data out of* it. Both talk to the daemon over localhost.

   ```
   Coding Agent ──PreToolUse hook──► daemon ──┐
         │                    ▲               │  (SSE ──► second window: planned)
         │                    │               │
         └──MCP explain()─────┘   you ──CLI───┘
   ```

   Feature 0 needs a guard: a model can simply not call `explain()`. When the daemon has no
   explanation for a pending edit, the hook denies it and the denial reason tells the agent which
   ticket to explain before retrying. Deny-rate is the health metric for the instruction set.

   The daemon is the single authority for the on/off state of feature 7, so every surface writes
   to one place. Two consequences. The hook shim must pass the plugin's own control commands
   straight through, or switching the plugin off would itself need explaining first. And because
   the shim fails open when the daemon is unreachable, **off** and **daemon unreachable** are the
   same code path — the escape hatch is the failure path, which is what keeps it trustworthy.
   Below that sit two hatches the daemon cannot break: `LET_ME_EXPLAIN=0`, and Claude Code's own
   `--settings '{"disableAllHooks": true}'`.

4. **Technologies:**
   a. Node 20.11+, TypeScript (ESM), a single package with four `tsup` build entries. Vitest to
      test. *(Not workspaces — the only real constraint is that the hook shim bundles with zero
      dependencies while the daemon uses Hono and Zod, and separate entries give that.)*
   b. Daemon: Hono on 127.0.0.1, ephemeral port, bearer token per daemon, port file `0600` in the
      XDG runtime dir. The shim reads the mode off disk first and short-circuits when off, then
      gives the daemon ~2 s on a health check before failing open. SSE is planned, with the window.
   c. Side-channel: MCP server (`@modelcontextprotocol/sdk`, stdio) exposing `explain()`, with Zod
      tool schemas. `answer()` is planned with feature 5.
   d. Second window (planned): React 19 + Vite. Shiki (`codeToHast`) for token-level rendering,
      jsdiff for hunks, Zustand for the event store, Tailwind v4, react-markdown for prose.
   e. Wire contracts: Zod schemas in `src/contracts/` shared by daemon, MCP server and shim. A
      harness adapter's only job is mapping its payload onto them.
   f. Storage: append-only JSONL per session under the XDG state dir. No native dependencies.
   g. Evals (planned): golden `(diff → explanation)` fixtures run in Vitest. Deterministic checks
      first (length caps, banned-phrase lexicon, reading level), LLM judge second, asserted on
      pass-rate rather than exact output.
   h. Docs: plain Markdown in `docs/` today; Astro Starlight, `llms.txt` and a lychee link-check
      planned once the pages stop moving.
   i. Hygiene (planned): Lefthook, Biome, commitlint, changesets. CI matrix Node 20/22/24 ×
      linux/macos/windows.
   j. Distribution: Claude Code plugin (`.claude-plugin/plugin.json`, `hooks/hooks.json`,
      `.mcp.json`) served from `.claude-plugin/marketplace.json`. Settings via the manifest's
      `userConfig` are planned. **Open question:** `dist/` is gitignored, so a git-sourced install
      would ship nothing runnable — see [docs/decisions.md](docs/decisions.md#distribution).

## Future features

1. **VS Code panel** as a second front-end. The daemon's REST surface already is the extension's
   backend, so this is a webview client rather than a rewrite — and it gives the let-me-write
   feature a real editor to write in.
2. Codex and OpenCode adapters. Both expose PreToolUse-style interception, so they are new
   mappings onto the wire contracts, not new plumbing.
3. Optional bring-your-own-key Teacher Agent (cheap model, prompt caching) as a fallback for when
   the Coding Agent's context is too full to spend on teaching.
4. Token-level granularity for feature 1 — Shiki's token tree already supports it, so it becomes a
   setting rather than new code.

## Priorities

Make Claude Code work first.

---

## Docs

| Page | What's in it |
|---|---|
| [docs/](docs/) | Wiki index and how to read it |
| [docs/architecture.md](docs/architecture.md) | The three processes, the ticket, the enforcement loop |
| [docs/files.md](docs/files.md) | Every file in `src/` — what it does and why it exists |
| [docs/decisions.md](docs/decisions.md) | Design calls, and what was rejected |
| [docs/development.md](docs/development.md) | Build, test, and the dogfood loop |
| [docs/reference/protocol.md](docs/reference/protocol.md) | The daemon's HTTP routes |
| [docs/reference/hook-contract.md](docs/reference/hook-contract.md) | What the harness sends and expects back |

## Licence

MIT.
