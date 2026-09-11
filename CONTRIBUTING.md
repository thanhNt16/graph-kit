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
| `bun run ci:local` | typecheck + lint + test + build + cbm:parity + eval:memory + check-changelog + check:parity + manifest drift guard — the same steps CI runs (fail-fast: tests before the build) |
| `bun run check:parity` | built `dist/index.js` exposes exactly the commands in `cli-manifest.json` |
| `bun run cbm:parity` | CBM contract fixtures against `src/cbm/contract.ts` |
| `bun run check-changelog` | CHANGELOG.md structure gate |
| `bun run eval:memory` | deterministic memory-recall eval (`hit_rate`, `validity_violations`) — also a `ci:local` gate step |
| `bun run perf` | runtime perf harness — sizes a synthetic memory store, times recall/fingerprint/CLI; informational, no thresholds |

## Repo map

| Path | What lives there |
|---|---|
| `src/cli/commands/` | one file per command group; subcommands dispatch inside a single cac command |
| `src/cli/command-registry.ts` | THE command surface (help, did-you-mean, completions, manifest all derive from it) |
| `src/compiler/` | loader (YAML+schema), resolver, validate (structural rules), emitter, waves |
| `src/memory/` | run ledger, resume, consolidation, links, recall |
| `src/frontmatter.ts` | the one markdown+YAML frontmatter splitter (memory, evidence, compiler, eval share it) |
| `src/evidence/` | fingerprints, markers, store, gate-facing reports |
| `src/cbm/` | codebase-memory bridge client, routing, query templates |
| `src/eval/` | replay harness, recall metrics, ACT-R forgetting |
| `kits/<target>/` | install sources per host (claude, cursor, codex, pi, opencode) |
| `scripts/` | gates and harnesses (`cbm-parity`, `check-cli-parity`, `gen-cli-manifest`, `check-changelog`, `memory-recall-eval`, `perf-runtime`) |
| `docs/error-codes.md` | every fail-envelope code; a drift-guard test fails when src emits an undocumented code |

## Environment variables

| Var | Effect when unset |
|---|---|
| `CBM_CMD` / `CBM_ARGS` | `gk graph search/ask/trace/query/index` and `gk memory index` fail fast with `CBM_UNAVAILABLE` (no spawn) |
| `CBM_TIMEOUT_MS` | CBM call timeout defaults to 60s |
| `GK_KIT_DIR` | `gk init` falls back to the bundled `kits/` for the active target |
| `GK_VERSION` / `GK_BIN_DIR` / `GK_GALLERY_DIR` | install.sh and gallery-template resolution overrides (see README) |

## The pre-push gate

`bun run ci:local` is THE gate — it runs the exact steps CI runs (typecheck, lint, build, test, cbm:parity, the deterministic `eval:memory` recall-quality eval, check-changelog, check:parity, and the `cli-manifest.json` drift guard), so if it passes locally, CI passes. Run it before every push; no exceptions for "small" changes.

Changing the CLI surface (new command, new flag)? Add it to `CLI_COMMANDS` in `src/cli/command-registry.ts`, then run `bun run scripts/gen-cli-manifest.ts` — CI fails on manifest drift (`git diff --exit-code cli-manifest.json`).

## Changelog

Add entries under `## [Unreleased]` in CHANGELOG.md (`### Added` / `### Changed` / `### Fixed`), one bullet per user-visible change. `bun run check-changelog` enforces the structure; the release flow lifts the section into release notes.

## Kit edits

`kits/**/SKILL.md` files must have strict-YAML-parseable frontmatter — enforced by `tests/unit/kit-skill-frontmatter.test.ts`. Run `bun test tests/unit/kit-skill-frontmatter.test.ts` after touching any kit file.

## Releases

Every push to `main` auto-publishes a patch tag (`vX.Y.Z`): release.yml computes the next patch, stamps it into `src/version.ts`, builds binaries, and publishes a GitHub release. Never tag manually.

## Concurrent agent editing

Multiple agents working the same repo? Follow [docs/worktree-merge-protocol.md](docs/worktree-merge-protocol.md) for conflict-safe worktree editing.
