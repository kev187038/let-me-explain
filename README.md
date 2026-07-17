# let-me-explain

Teach your AI coding assistants to teach **you**.

A wizard that installs a short "teach me while we work" instruction block into the
global config files of your AI coding harnesses, so you never have to repeat
*"also explain what you did and why"* in every session.

```
npx let-me-explain
```

Answer four questions — which harnesses, your goal role, your seniority, what to
focus on — preview the generated instructions, confirm. Done: every future AI
session explains its design decisions, names the patterns it uses, root-causes
bugs, and pitches it all at your level.

## Supported harnesses

| Harness | File managed |
|---|---|
| Claude Code | `~/.claude/CLAUDE.md` |
| OpenAI Codex CLI | `~/.codex/AGENTS.md` |
| Gemini CLI | `~/.gemini/GEMINI.md` |

Your existing content is never touched: the tool owns only a clearly-marked
block between `<!-- BEGIN let-me-explain -->` / `<!-- END let-me-explain -->`
sentinels (the same managed-block pattern `nvm` uses in your `.bashrc`).
Re-running the wizard updates the block in place.

## Commands

```
npx let-me-explain            # setup wizard (re-run any time to change answers)
npx let-me-explain status     # current config + per-file state, incl. drift detection
npx let-me-explain uninstall  # remove every managed block and all tool config
```

Your answers live in `~/.config/let-me-explain/config.json` (XDG-aware); the
instruction text is always rendered from them. An install manifest records every
file touched, so `uninstall` restores your files exactly — files the tool
created are deleted, files it appended to get their original content back.

## Development

```
npm install
npm test          # vitest — unit + full install/uninstall flow tests
npm run dev       # run the wizard from source (tsx)
npm run build     # bundle to dist/cli.js (tsup)
```

Adding a harness: drop a data-only adapter in `src/adapters/` (id, display
name, detection dirs, target file) and register it in `src/adapters/index.ts`.
