# Changelog

All notable changes to GraphKit will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Session graph store**: graphs are immutable timestamped sessions under `.graphkit/graphs/<YYYY-MM-DD>-<slug>.yaml` with an active pointer at `.graphkit/active`; root `graph.yaml` keeps working via explicit path, and same-day id collisions suffix `-2`, `-3`, …
- **Session graph commands**: `gk graph list` (session table with created/last-run columns and an active marker — last-run shows `-` until the runs ledger ships with `gk execute`), `gk graph switch <id>` (flip the active pointer), `gk graph show [id]` (print a session's YAML; defaults to the active graph), and `gk graph topologies` (list bundled topologies — topology listing moved off `graph list`, which now means session graphs).
- **Loop groups**: top-level `loops:` array repeats a contiguous multi-node wave span with hybrid stop semantics — deterministic `gate_evidence` check first, LLM-judged `stop_when` fallback, `max_rounds` hard cap; exhaustion fails the run and records rounds executed plus the stop reason (`gate` | `judged` | `exhausted`).
- **Loop group validation**: node existence, wave-span contiguity, non-overlapping groups, and every `gate_evidence` key declared on a node inside the span are checked in `validateGraph`; `max_rounds ≥ 1` and stop-condition presence (`stop_when` and/or `gate_evidence`) are enforced by schema validation (`SCHEMA_INVALID`).
- **Template materialization**: `gk template materialize <name> [--params '<json>'] [--use]` resolves project-local ⇒ user-global ⇒ bundled gallery, substitutes parameters, validates, and writes a new session graph (`--use` sets it active). Ships a builtin gallery of 4 templates (`audit-pr`, `refactor-module`, `bench-eval`, `doc-sweep`); `gk template list` gains an `origin` field (`project` | `global` | `gallery`).

## [0.2.24] - 2026-08-26

### Fixed
- Fixed release notes extraction in `release.yml` so CHANGELOG entries match date-suffixed headers.

## [0.2.23] - 2026-08-26

### Added
- **Changelog & Documentation Policy**: `CHANGELOG.md` covering all releases from `v0.2.0` onward.
- **Release workflow integration**: `release.yml` extracts the current version's section from `CHANGELOG.md` to populate GitHub Release notes.
- **CI sanity check**: `scripts/check-changelog.ts` ensures `CHANGELOG.md` exists and contains an `[Unreleased]` section (wired into `ci:local`).
- **CLI Reference**: full 30-command reference in `README.md`.
- **Command documentation**: `gk status`, `gk execute`, and `gk visualize` pointer stubs documented in `README.md`.
- **Worktree merge protocol**: `docs/worktree-merge-protocol.md` with sequence diagram and multi-host support matrix.
- **Pages integration**: `docs/worktree-merge-protocol.md` linked from GitHub Pages index.

### Changed
- `README.md` banner links directly to `CHANGELOG.md` and `docs/worktree-merge-protocol.md`.

## [0.2.22] - 2026-08-25

### Fixed
- Biome formatting and unused symbol cleanup across all F4–F9 touched files.
- Local Biome check exclusion for untracked `.omp/skills/excalidraw-diagram`.

## [0.2.21] - 2026-08-25

### Added
- **Conflict-safe worktree merge protocol**: `git merge --no-commit --no-ff`, automatic `git merge --abort` on conflict with full node/branch/file reporting, gate test verification before sealing merge.
- **Real `gk status` command**: reads `.graphkit/runs/.active`, summarizes active run metadata, round status, and evidence gate coverage.
- **CLI alignment**: `gk execute` and `gk visualize` pointer stubs (`NOT_IMPLEMENTED`, exit 1) guiding users to the corresponding `/gk:*` skills.
- **Bounded upstream context**: downstream agents in custom workflows receive declared evidence paths and at most a 2KB tail per dependency rather than full raw results.
- **Symbol-first context profile**: documentation (`docs/context-profiles.md`) and verified example (`examples/symbol-first.yaml`) for bounded structural indexing via `codebase-memory`.
- **Degenerate-graph guard**: validator rejects zero-node non-custom graphs.
- **`gk init` scaffold**: creates `.graphkit/{evidence,reports,memory,runs}` directory layout.
- GitHub Pages index now links `context-profiles.md`.

### Changed
- Refactored `skill-eval` and `skill-recall` unit tests from substring matching to functional CLI execution.

## [0.2.20] - 2026-08-24

### Fixed
- Added accessible `<title>` elements to graph viewer SVG outputs.

## [0.2.19] - 2026-08-24

### Fixed
- Kit installation writes to `.omp/` for Oh My Pi runtime auto-discovery.

## [0.2.18] - 2026-08-23

### Changed
- Added research and repair workflow for memory-improvement graphs.

## [0.2.0] - 2026-08-11

### Added
- Multi-host target kits: Claude Code, Cursor, OpenCode, Codex CLI, Pi (`.omp`).
- Custom and built-in topology validation and compilation.
- Interactive Graph Viewer (`gk visualize`) with live SSE reload.
- Cross-run project memory subsystem (`gk memory recall/touch/trace`).
- Deterministic evidence gate (`gk gate`).
