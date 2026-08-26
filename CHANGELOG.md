# Changelog

All notable changes to GraphKit will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
