---
name: context-docs
description: Locate the repo's own documentation before asking or assuming — README, CONTRIBUTING, ADRs, docs/. Shared by all factory lane agents.
disable-model-invocation: true
---

# context docs

Before you reason about conventions, read the repo's:

1. `README.md`, `CONTRIBUTING.md`, `CHANGELOG.md` (`## [Unreleased]` conventions).
2. `docs/` — architecture, ADRs, plans.
3. Colocated `*.md` near the surfaces the card names.
4. Package manifests (`package.json` scripts, `Makefile`, `mise.toml`) for the real commands.

## Rules

- Prefer the repo's own docs over general knowledge.
- If docs and code disagree, believe the code and note the drift in your output block.
- Cite `path:section` when your conclusion came from a doc.
