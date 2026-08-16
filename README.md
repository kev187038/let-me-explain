# PROJECT LET-ME-EXPLAIN
Introduction: 
it's a plugin for a harness that is supposed to give Junior developer a better chance to learn with AI. Essentially the idea is to open a second window where every line of code is explained to the user, as well as every line of command line executed by the AI. 

We will refer to Coding Agent as the normal coding agent, and to the Teacher Agent as the agent that explains the user what is going on.

## Features:
0. Ideally Teacher Agent and actual Coding Agent coincide to use less tokens.
1. Chunk command / new code in lines as tokens: every token is explained as a line in its context. Worth considering chunking in by word. 
2. Code /Command line choice: the user can in this second window choose the lines that the agent needs to explain.
3. Teacher-Agent instructions: a set of instructions to define for the teacher agent. Among these, we wanna make the learning process as smooth as possible, so we need to curb the usual AI lingo: things need to be easy to explain, and explanations need to be **brief**. No walls of text that are an eye-sore to read. Every token, explained, simply. After this, **the second part is the wider context of what is being done in that command / edit to file and why** (we are solving this bug..., this feature needs this because..., etc...). This too needs to be a small section. 
The agent needs to also stop putting useless comments above the code it makes, just the comment that explains the whole page or borderline problems are allowed.
4. Let-me-write feature: the teacher agent also allows the choice to the user to write the command or the code themselves to learn by hand and memory as well. A simple YES/NO for the current page or command that it wants to execute.
5. Question section: a separated section for any question the user wants to ask on the code/command being done.
6. Simple installation to the harness as a plug-in. Claude Code, Codex or OpenCode.
7. Enable / disable toggle: switching the plugin off must be trivial, so the user gets plain Claude Code back the moment they need speed instead of teaching. Three states rather than two:
    - **on** — explain and block, the full learning loop.
    - **observe** — explanations still stream to the second window, but nothing ever blocks. The learning log without the friction; read it afterwards.
    - **off** — full pass-through, the plugin is invisible.

    Flippable from the second window, from `/let-me-explain on|observe|off`, and from the CLI when no session is running. State is per session with a global default, so turning it off in one project never affects another.

## Framework

1. AI-AGENT friendly documentation: all features and layers must be documented in a docs/ folder with a common layout creating a wiki. This wiki speaks for every page about a feature but also speaks about the relationship between this feature and the others, with links to the other pages of the wiki to access it immediately. 
2. Pre-commit rules: 
    a. Documentation must be updated
    b. tests must be run about the features that was created/modified
    c. if needed retry the deployment on the claude code harness 
    d. list any new env vars if there are any to set


3. Architecture:

A background **daemon** owns the second window and all session state. A **PreToolUse hook** intercepts every Edit / Write / Bash and blocks while the daemon shows the pending change and waits for the user. An **MCP server** gives the Coding Agent an `explain()` tool — the side-channel that carries explanations to the second window instead of into the terminal.

The hook is the only thing that can *block* the agent; the MCP tool is the only thing that can *carry data out of* it. Both talk to the daemon over localhost.

```
Coding Agent ──PreToolUse hook──► daemon ──SSE──► second window
      │                             ▲                   │
      └──MCP explain()──────────────┘◄──POST decision───┘
```

Feature 0 needs a guard: a model can simply not call `explain()`. When the daemon has no explanation for a pending edit, the hook denies it and the denial reason tells the agent which ticket to explain before retrying. Deny-rate is the health metric for the instruction set.

The daemon is the single authority for the on/observe/off state of feature 7, so every surface — second window, slash command, CLI — writes to one place. Two consequences to design for. The hook shim must pass the plugin's own control commands straight through, or switching the plugin off would itself need explaining first. And because the shim already fails open when the daemon is unreachable, **off** and **daemon unreachable** are the same code path — the escape hatch is the failure path, which is what keeps it trustworthy. Below that sit two hatches the daemon cannot break: `LET_ME_EXPLAIN=0` in the environment, and Claude Code's own `--settings '{"disableAllHooks": true}'`.

4. Technologies:
    a. Node 22 LTS, TypeScript (ESM), npm workspaces. tsup to bundle, Vitest to test.
    b. Daemon: Hono + SSE, bound to 127.0.0.1 on an ephemeral port, bearer token per session, port published to the XDG runtime dir. The hook shim fails open if the daemon does not answer a health check within a couple of seconds, so a wedged daemon can never freeze the agent.
    c. Side-channel: MCP server (`@modelcontextprotocol/sdk`, stdio) exposing `explain()` and `answer()`, with Zod tool schemas.
    d. Second window: React 19 + Vite. Shiki (`codeToHast`) for token-level rendering, jsdiff for hunks, Zustand for the event store, Tailwind v4, react-markdown for explanation prose.
    e. Wire contracts: one Zod schema package shared by daemon, MCP server, hook shim and UI. A harness adapter's only job is mapping its payload onto it.
    f. Storage: append-only JSONL per session under `${CLAUDE_PLUGIN_DATA}`. No native dependencies.
    g. Evals: golden `(diff → explanation)` fixtures run in Vitest. Deterministic checks first (length caps, banned-phrase lexicon, reading level), LLM judge second, asserted on pass-rate rather than exact output.
    h. Docs: Astro Starlight over `docs/`, `llms.txt` at the root, lychee link-check in CI.
    i. Hygiene: Lefthook, Biome, commitlint, changesets. CI matrix Node 20/22/24 × linux/macos/windows.
    j. Distribution: Claude Code plugin (`.claude-plugin/plugin.json`, `hooks/hooks.json`, `.mcp.json`), published through a `marketplace.json` repo. Settings via the manifest's `userConfig` — default mode for new sessions, and which tools to intercept.

## Future features

1. **VS Code panel** as a second front-end. The daemon's SSE + REST surface already is the extension's backend, so this is a webview client rather than a rewrite — and it gives the let-me-write feature a real editor to write in.
2. Codex and OpenCode adapters. Both expose PreToolUse-style interception, so they are new mappings onto the wire contracts, not new plumbing.
3. Optional bring-your-own-key Teacher Agent (cheap model, prompt caching) as a fallback for when the Coding Agent's context is too full to spend on teaching.
4. Token-level granularity for feature 1 — Shiki's token tree already supports it, so it becomes a setting rather than new code.

## Priorities

Make claude code work first