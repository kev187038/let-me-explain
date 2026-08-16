---
title: let-me-explain wiki
status: shipped
relates_to: [architecture, files, decisions, development]
---

# let-me-explain — documentation

This is the wiki required by Framework §1 in the [root README](../README.md). Every page covers
one thing and links to the pages it depends on, so you can arrive anywhere and walk outward.

## Start here

| If you want to… | Read |
|---|---|
| Understand how the whole thing fits together | [architecture.md](architecture.md) |
| Know why a particular file exists | [files.md](files.md) |
| Know why a design call was made, and what lost | [decisions.md](decisions.md) |
| Build, test, or dogfood a change | [development.md](development.md) |
| Understand one feature in depth | [features/](features/) |
| Look up a route, command, or payload | [reference/](reference/) |

## Features

| Feature | Status | Page |
|---|---|---|
| 0 · One agent teaches and codes | ✅ | [features/00-single-agent.md](features/00-single-agent.md) |
| 1 · Per-line explanations | ✅ | [features/01-line-explanations.md](features/01-line-explanations.md) |
| 2 · Choose which lines to explain | 📋 | — needs the second window |
| 3 · Teacher-Agent instructions | 🔶 | — brevity caps live in feature 1 today |
| 4 · Let-me-try | ✅ | [features/04-let-me-try.md](features/04-let-me-try.md) |
| 5 · Question section | 📋 | — needs `answer()` and the second window |
| 6 · Install as a plug-in | ✅ | [development.md](development.md) |
| 7 · Enable / disable toggle | 🔶 | [features/07-toggle.md](features/07-toggle.md) |

## Reference

- [reference/protocol.md](reference/protocol.md) — the daemon's HTTP routes
- [reference/cli.md](reference/cli.md) — every CLI command
- [reference/hook-contract.md](reference/hook-contract.md) — the harness ↔ shim contract

## Conventions used in these pages

**Status legend.** ✅ shipped · 🔶 partial · 📋 planned. Every page carries a `status` in its
frontmatter. A page describing something unbuilt says so in its first line — documentation that
describes intent as though it were reality is worse than no documentation, because it can't be
caught by reading the code.

**Frontmatter is for machines.** `title`, `status`, `feature`, `relates_to`. An agent reading
this wiki should be able to build a graph of it without parsing prose.

**Every page ends with Related.** The links are the point, not the files. A page that nothing
links to and that links nowhere is a dead end, which is exactly what Framework §1 exists to
prevent.

**Why over what.** The *what* is recoverable by reading the source. The *why* is not — it lives
only here, and it is the thing that stops someone "simplifying" a load-bearing decision later.

## Related

- [Root README](../README.md) — install, the 60-second tour, the feature list
- [architecture.md](architecture.md) — the system in one page
- [decisions.md](decisions.md) — the reasoning behind the shape
