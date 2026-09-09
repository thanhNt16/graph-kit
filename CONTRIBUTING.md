# Contributing

Terse and concrete — like the codebase.

## Prerequisites

- [Bun](https://bun.sh) — the version is pinned in `.bun-version` (CI installs exactly that; `bun` itself honors the file too)

## Setup

```bash
git clone https://github.com/thanhNt16/graph-kit && cd graph-kit
bun install
bun test
```

## Scripts

| Script | What it does |
|---|---|
| `bun run typecheck` | `tsc --noEmit` over strict TS |
| `bun run lint` | `biome check .` — formatter + linter, no config debates |
| `bun test` | the full unit suite |
| `bun run build` | bundle `src/index.ts` → `dist/` |
| `bun run ci:local` | typecheck + lint + build + test + cbm:parity + check-changelog + check:parity + manifest drift guard — the same steps CI runs |
| `bun run check:parity` | built `dist/index.js` exposes exactly the commands in `cli-manifest.json` |
| `bun run cbm:parity` | CBM contract fixtures against `src/cbm/contract.ts` |
| `bun run check-changelog` | CHANGELOG.md structure gate |
| `bun run eval:memory` | manual eval (not a gate): memory recall metrics (`hit_rate`, `validity_violations`) |
| `bun run perf` | runtime perf harness — sizes a synthetic memory store, times recall/fingerprint/CLI; informational, no thresholds |

## The pre-push gate

`bun run ci:local` is THE gate — it runs the exact steps CI runs (typecheck, lint, build, test, cbm:parity, check-changelog, check:parity, and the `cli-manifest.json` drift guard), so if it passes locally, CI passes. Run it before every push; no exceptions for "small" changes.

Changing the CLI surface (new command, new flag)? Add it to `CLI_COMMANDS` in `src/cli/command-registry.ts`, then run `bun run scripts/gen-cli-manifest.ts` — CI fails on manifest drift (`git diff --exit-code cli-manifest.json`).

## Changelog

Add entries under `## [Unreleased]` in CHANGELOG.md (`### Added` / `### Changed` / `### Fixed`), one bullet per user-visible change. `bun run check-changelog` enforces the structure; the release flow lifts the section into release notes.

## Kit edits

`kits/**/SKILL.md` files must have strict-YAML-parseable frontmatter — enforced by `tests/unit/kit-skill-frontmatter.test.ts`. Run `bun test tests/unit/kit-skill-frontmatter.test.ts` after touching any kit file.

## Releases

Every push to `main` auto-publishes a patch tag (`vX.Y.Z`): release.yml computes the next patch, stamps it into `src/version.ts`, builds binaries, and publishes a GitHub release. Never tag manually.

## Concurrent agent editing

Multiple agents working the same repo? Follow [docs/worktree-merge-protocol.md](docs/worktree-merge-protocol.md) for conflict-safe worktree editing.
