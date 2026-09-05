# Changelog

All notable changes to GraphKit will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).


## [Unreleased]


## [0.3.8] - 2026-09-05
### Fixed
- CI lint: auto-formatted run-resume sources (biome `useTemplate`/`useConst`/import order/format). No behavior change — 575 tests pass.
## [0.3.7] - 2026-09-05
### Changed
- Docs only — no code changes. Page title tag de-versioned.

## [0.3.6] - 2026-09-05
### Changed
- **Landing-page restructure** (`docs/graphkit-v0.2-report.html`): sticky nav (Quickstart/Architecture/Topologies/Runs/Memory/CLI/Roadmap/GitHub), hero CTAs + copyable install one-liner, "Author · Run · Remember" track cards, section anchors, roadmap S1 marked SHIPPED 0.3.5, footer links (repo/CHANGELOG/specs), stats 542→575.
- **README**: CI/Release/Pages/Tests badges, counts headline, TOC, `gk run resume` reference, stale test count 461→575, CLI help copy now lists `resume`.

## [0.3.5] - 2026-09-05
### Added
- **`gk run resume <run-id>`** — checkpoint replay: reconciles the run ledger against the recorded graph (`passed` + evidence-on-disk rule, dependent closure), derives a pending-only session graph where satisfied upstream evidence becomes `refs`, activates it, and starts a child run carrying `resumes:` provenance. `gk run status` now prints the `resumes_chain`. Guards: `RESUME_GRAPH_DRIFT` (sha256 of the recorded graph), `--force` override, `--from-node` redo, `--dry-run` preview; derived graphs are fail-fast validated (`RESUME_DERIVED_INVALID`) — fan_out/loops/required_keys closure included.
### Changed
- **Pages report: checkpoint-resume section added** — reconcile → derive → child-run flow documented with drift-guard guidance (see `docs/graphkit-v0.2-report.html`).

## [0.3.2] - 2026-09-04

### Added

- **Node advisor escalation**: a looping node may declare `advisor: {model, after_failed_rounds, max_calls}` — once a node's failed-round streak reaches `after_failed_rounds` (and `max_calls` per run isn't exhausted, within `loop.max_rounds`), the execute-skill dispatches a read-only advisor subagent at `advisor.model` (default `fable`), appends its guidance (`## Advisor guidance`) to the node objective, and re-dispatches the node at its original tier.
- **Escalation audit trail**: `gk run node <id> --advisor-fired <round> [--streak <n>]` appends to the run's `advisor.jsonl`; `gk run status` reports the `advisor_events` count.
- **Node fan-out**: a node may declare `fan_out: {briefs_from, template}` — the upstream node's `briefs.json` (array of `{id, title, body}`) executes as one parallel host subagent per brief (`template` rendered per brief, default `{brief.body}`) with an in-node barrier and consolidation; the waves payload carries `advisor`/`fan_out` verbatim.
- **`advisor-repeat` memory pattern**: `gk memory consolidate` surfaces repeated advisor escalations with a "raise model tier / loosen stop_when" suggestion (action `review-failure`).
- **Advisor/fan-out execute-skill mechanics + e2e**: all five kits' execute skills dispatch advisor escalations and fan-out briefs; `tests/acceptance/advisor-fanout.e2e.test.ts` covers the CLI path end-to-end.

### Fixed
- **Two scaffolds failed their own validator**: `gk graph new diamond` and `gk graph new loop-until-done` emitted a `limits:` block the validator rejects (`max_workers` / `max_iterations` are not schema keys), so quickstart step 3 (`gk validate`) failed on the README's own topology. The dead `limits:` blocks are removed, and a CI sweep now asserts every scaffold parses and validates clean (`tests/unit/scaffold-validate.test.ts`, 11 topologies).
- **Bare `gk graph` / `gk template` / `gk models` crashed with a raw CACError stack trace**: all three group commands required a subcommand. They now make it optional and print usage with exit 0, matching the `gk memory` surface.
- **`ENOENT` surfaced as raw Node text inside error envelopes**: a missing graph file in `validate`/`compile`/`gate`/`ascii` now fails as `GRAPH_FILE_NOT_FOUND` with the path and a next-step hint (`gk graph new <topology>`).

### Changed
- **`/gk:visualize` defaults to archify HTML**: the skill reads `gk graph waves`, authors a typed [archify](https://github.com/tt-a1i/archify) IR (wave index → column, model tier → lane), validates it at showcase quality with a 5-cycle cap, and delivers a self-contained `.graphkit/diagrams/{name}.html` plus its `.archify.json` source. archify is skill-layer only — probed per host, installed once with user consent, with SVG fallback when unavailable. ASCII, SVG, and Excalidraw modes unchanged.

### Removed
- **Local interactive viewer**: the key-gated `127.0.0.1` SSE server, dagre bundle, viewer assets in all five kits, `bun run build:viewer`, and the viewer test suite are deleted in favor of the archify artifact.

### Fixed
- **Stale kits shadowing a newer install**: `kitSourceDir()` probed `<bin>/../share/gk/kits/` before `<bin>/share/gk/kits/`, so a kit left by an earlier install under a different prefix (e.g. `~/.local/share/gk/`) outranked the kit shipped in the current binary's tarball — `gk init` silently installed the old kit. The side-by-side layout is now probed first.
- **Retired kit assets surviving upgrades**: `gk init` overlays the kit with `cpSync`, which never deletes, so files a newer kit stopped shipping lingered in existing projects. Each kit's `metadata.json` `deletions` list is now honored on every install; the claude, cursor, and opencode kits declare the removed `viewer` directory.
- **Sudo-free install documented**: the README's primary install is now `tar -xz -C ~/.local/bin` — the binary resolves its kits from the adjacent `share/gk/` tree, so any writable dir on `PATH` works. The `sudo` variant remains as the system-wide option, with notes on overlay-only upgrades and shadowed stale copies.

## [0.3.0] - 2026-09-04

### Added

- Run ledger: `gk run start|node|end|status` records every execution to `.graphkit/runs/`.
- Pattern compiler: `gk memory consolidate` derives node sequences, evidence co-occurrence,
  failure recurrence, and graph reuse into `.graphkit/memory/patterns/` + `suggestions/`.
- Suggestions: `gk suggest` ranks them; `--dismiss` retains the file but hides it.
- Recall widened: searches subfolders, joins `.links.json` neighbors below direct hits.
- Dream graph template: proposes memory consolidations as reviewable diffs (`.graphkit/inbox/`).
- Waves payload carries `hooks` (on_node_complete) and `on_graph_complete` commands.

## [0.2.25] - 2026-08-27

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
