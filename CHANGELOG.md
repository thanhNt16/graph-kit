# Changelog

All notable changes to GraphKit will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).


## [Unreleased]
### Added
- `jev` omp extension (`kits/_core/extensions/jev.ts` → `.omp/extensions/`): registers a `jev_decide` tool that calls TypeSafe's System One API (`POST /v1/systemone`, Jev model) for calibrated typed decisions — noul/choice/score — instead of asking a chat LLM. Routes through OpenRouter (`https://openrouter.ai/api`) by default; key resolution: `TYPESAFE_API_KEY` → `OPENROUTER_API_KEY` → the openrouter connection stored in 9router's db (`~/.9router/db/data.sqlite`). `TYPESAFE_BASE_URL` overrides the endpoint.
- One-command installer (`install.sh` in repo root): OS/arch detection, installs to `~/.local/bin` without sudo, clears stale files before extraction, PATH check, `gk --version` verification. `curl -fsSL https://raw.githubusercontent.com/thanhNt16/graph-kit/main/install.sh | sh`
- npm package `graphkit-gk` published on every release (`npm publish` in release.yml via `NPM_TOKEN` secret); `bun add -g graphkit-gk` / `npm i -g graphkit-gk` installs a ~380 KB JS bundle — 30-100x smaller than the standalone binary tarballs. (`@graphkit` scope was taken; unscoped `graphkit-gk` chosen, binary stays `gk`.)
- `install.sh` fast path: prefers `bun add -g` / `npm i -g` (~1-2 s) when a runtime exists, falls back to the standalone tarball otherwise (`GRAPHKIT_INSTALL=binary` forces the tarball).
- `loops[].no_progress_limit` (schema, min 2) + `gk run round <group>` — durable per-group round journal (`.graphkit/runs/<id>/rounds/<group>.jsonl`); fingerprints node statuses + evidence bytes per round so `no_progress_limit` consecutive identical failing rounds exhaust the loop early (stop reason `no_progress` alongside `gate`/`judged`/`exhausted`)
- `criteria/` registry + `evidence.criteria` id list + `evidence.freshness: report|strict` in graph.yaml; `criteria-keys`/`criteria-file` validation
- `gk evidence add` — content-addressed artifacts with provenance markers (`EVIDENCE_KEY_NOT_DECLARED` / `EVIDENCE_FILE_MISSING` / `EVIDENCE_TOO_LARGE`)
- `gk evidence invalidate --key <k> [--note <why>]` — stamps a marker's `superseded` field (note or timestamp); freshness treats superseded evidence as missing, so strict gates BLOCK until it is re-added.
- Gate/status per-key freshness (`fresh|stale|unknown`); strict mode BLOCKs on stale, unknown, and superseded required keys
- `gk evidence report` — criterion-first markdown + `--html` self-contained page (SVG never inlined, all content escaped)
- `gk run start` stamps the repo fingerprint into the run ledger
- Archify diagram suite (`docs/diagrams/`): system architecture, execution workflow, run-resume lifecycle, and all eleven topologies as standalone explorables (inline SVG, trace motion, dark/light). Gallery linked from the docs landing page.
- Resume reconciliation lineage check: evidence markers must belong to the run's `resumes:` ancestor chain (or be hand-written/no-run markers) to satisfy a node; evidence overwritten by an unrelated run leaves the node pending and is reported in the new `foreign_evidence` result field. Marker frontmatter parsing now tolerates CRLF line endings.
- Run-ledger dispatch intents: `gk run dispatch <node> [--attempt <n>] [--via task|extension] [--pid <pid>]` appends to the run's `dispatch.jsonl` before a subagent spawns, and `gk run land <node> [--commit <sha>]` stamps the node's last `ok` trace line with `landed: {at, commit}` (trace lines carry `attempt`). `.graphkit/active` is written atomically (exclusive-create + rename), and a failed `startRun` no longer erases a freshly stamped `.takeover`.
- `gk run take <run-id> --from <stale-id>` — take over a run whose orchestrator died: refuses while any recorded dispatch pid is still alive (`TAKEOVER_BLOCKED`), stamps `.takeover` (next `startRun` records `meta.takes_over`); `gk run status` shows a stale run's age.
- Resume reconciliation of interrupted dispatches: the resume payload carries an `unresolved` list (dispatch intent with no trace line) to settle before re-dispatching, and unadjudicated challenge records plus the last advisor event carry into derived objectives as `## Resume context`.
- `gk memory recall <query> --explain`: deterministic retrieval debugging showing query term overlap, salience math, link penalties (0.5×), and filter/rejection verdicts (`zero_overlap`, `expired`, `not_yet_valid`, `superseded`, `outranked`). Add `--html` to also write an interactive dual-theme report to `.graphkit/diagrams/recall-<query>-<timestamp>.html` (bare `--html` fails with `INVALID_OPTION`).
- Runtime recall logging: non-explain recalls append JSONL rows (`ts`, `query`, `k`, `origin`, `top`, `injected`, `scanned`) to `.graphkit/memory/.recall-log.jsonl` with `--origin` tagging (default `cli`) for planned-vs-actual comparison.
- Orchestration fields on nodes (schema + gk-execute contract): `retry` (transient dispatch-failure policy with backoff + non-retryable classes), `when` (judged conditional skip, recorded via `gk run node --status skipped`), `budget_tokens` (advisory upstream-context cap with compact+spill), `gate` (human-approval suspension, resume via `gk run resume`), `fan_out.reduce` (`append|merge|vote`), `effort` (`light|standard|deep` scaling fan-out/budgets/loop bounds). `gk graph waves` carries all fields verbatim per node.
- Memory retrieval upgrades: BM25 scoring (IDF + TF saturation + length norm) replaces set-overlap; relative-score cutoff (0.3× top) drops distractor hits; Personalized PageRank over `.links.json` replaces flat 0.5 single-hop penalty; deterministic write gate folds same-shape near-duplicate patterns (jaccard ≥ 0.8, same kind + member count) instead of appending; generated memories cite `run:<id>` provenance.
- `kits/_core/` canonical kit source + `scripts/gen-kits.ts` materializes all 5 host kits (claude/cursor/opencode/codex/pi) with per-host transforms (frontmatter style, install-dir refs, md→toml agents, mdc rules, rules-section guards); `gen:kits:check` in `ci:local` fails on drift. `scripts/sync-omp.ts` mirrors the pi target into `.omp/`.
- `emit()` result-envelope helper; `cbm-seam.ts` shared test seam; `readMemoryFile`/`walkMemoryFiles` shared memory-store helpers.
- `timeout_ms` node field (schema + `gk graph waves` payload + gk-execute contract): per-node dispatch kill budget forwarded to `gk_dispatch_agent`; unset → 600000 default.
- `.gk.json` now records `kitVersion` at install; `gk run start` emits `warnings` when an installed kit predates the running gk binary (stale skills/extensions otherwise execute silently).
- `gk graph agents <file>` — materializes `.omp/agents/gk-<node>.md` per graph node (frontmatter: name, description, node `model`, constraint-derived `tools` with CamelCase→snake_case normalization, `autoloadSkills` from node `skills`); prunes stale `gk-*` files. pi kit agents now ship `name`/`description` frontmatter so omp's native task discovery sees them.
- `gk graph waves` payload now carries node `constraints` verbatim (previously dropped — `no_write`/`no_exec` never reached the dispatcher).
- Constraint provenance (advisory): `constraints[].source: human|author` — "human" marks an operator constraint agents must never modify; any other `source` value surfaces a non-blocking `constraint-source` warning from `gk validate`.
- SLP (Supervisor-Lead-Peer) orchestration mechanics, adapted from vhlam's model into the DAG contract:
  - `assumptions` node field — challengeable premises declared separately from mandatory `constraints`; materialized into `gk-<node>` agents as a `## Challengeable assumptions` section so peers know which premises may be reopened with evidence (the "parachute" antidote: first agent's design choice stops silently becoming a constraint for later agents).
  - `owns` node field — glob-declared write scope, materialized as `## Owned scope`; `validateGraph` emits a heuristic `owns-overlap` advisory when two same-wave write-capable nodes' scopes can collide (edit rights) while any node may still read everything (challenge rights).
  - `role: supervisor` — read-only cross-scope review node (forced `read/grep/glob` toolset) that reviews assumptions-of-A vs behavior-of-B and emits CHALLENGE freely; `eval-gate` contract preserved; other role strings surface a non-blocking `unknown-role` advisory.
  - CHALLENGE verdict — third node outcome beside ok/fail: `CHALLENGE: <node-id|plan> — <evidence>` terminal line; orchestrator records `--status challenge`, adjudicates decision-changing / equally-valid / noise, and re-dispatches the challenged node's owner with the finding under `## Challenged premise`. Dissent is a right gated on evidence, never an obligation.
  - Steering protocol — `hub list`/`hub send <node-id>` relay for mid-wave human correction; direction changes recorded to the run report and evidence dir so downstream nodes see them through shared state.
  - `gk run analyze` — Better-SLP telemetry over the ledger: escalation hit-rate (advisor-fired → subsequent ok), retry/duplicate-failure detection, unadjudicated challenges, loop stop-reason stats, and evidence-gated suggestions (question-form, never alarms).
  - `Finding.severity` — `warn`-severity findings (owns-overlap, unknown-role) surface in `gk validate` output without blocking validate-dependent commands.
  - `listRunIds`/`resolveRun` now share `RUN_ID_PATTERN` — stray or malformed dirs under `.graphkit/runs/` are skipped instead of surfacing as cryptic `RESUME_RUN_NOT_FOUND` (found by the scenario test wave).

- gk-execute skill contract: records a dispatch intent before every spawn and verifies a launch receipt (`hub jobs` shows one running row per spawned node) before the wave wait; takeover via `gk run take` with the same `unresolved` reconciliation; challenge records carry an adjudicated disposition (`disposition=accept|modify|reject|defer`, parsed by `gk memory consolidate`); a `CHALLENGE: plan` terminal suspends the run behind a node `gate` for human approval; merge hardening — one wave merge at a time, conflict → `git merge --abort` + node fail + graph stop, post-merge `owns`-scope check, `gk run land --commit` after the merge seals, evidence re-stamped after the fingerprint change, final-tree suite + `gk gate`, orphaned worktree/branch reporting in `gk run end`; every `hub send` and task brief opens with a `run:/node:/rev:` stamp.
- `gk run analyze` gains challenge-disposition counts and `nodes.integration_failures` (nodes recorded `ok` whose required evidence never landed) alongside the escalation/retry telemetry.
- Gallery template `cook-plan` (multi-node cooking-plan graph) and the `eval-gate` role are recognized in the schema.

### Changed
- **Pages landing page rewritten version-free** (`docs/graphkit.html`, renamed from `graphkit-v0.2-report.html`): features ordered as a workflow — lifecycle → install → 11 topologies → per-node binding & validation → dual runtimes → evidence & gates → run ledger & resume → memory & CBM bridge → host table → CLI. All version badges, "shipped in X.Y" labels, dated sections, roadmap, and historical demo/story sections removed. `pages.yml` redirect updated.
- **Landing page visual pass**: topology cards now carry animated SVG diagrams (traveling signal dots via SMIL `animateMotion`, node pulse, edge dash-flow, hover gradient glow, scroll-driven reveal under `@supports`, `prefers-reduced-motion` fallback; zero JS). "Comprehensive Command Reference" gains "The gk Lifecycle" — a 6-stage orchestration flow diagram (install → compose → validate → execute → evidence & gate → close out) with animated connectors, MERGE/BLOCK/RESUME verdict chips, and a BLOCK→resume loop-back lane — plus per-stage session-skill chips and a 13-card "Session Skills" grid.
- **Strict graph.yaml schemas**: unknown top-level, node, and nested-config fields now fail validation with the offending key named (`Unrecognized key: "…"` in `SCHEMA_INVALID` issues) instead of being silently stripped. `constraints` records and inputs/metadata stay open by design. All bundled scaffolds, gallery templates, and examples re-validated clean.
- **BREAKING (CLI output):** all commands emit the JSON envelope unconditionally — human-rendered tables removed; `--json` flags remain accepted no-ops.
- `cli-manifest.json` is now derived from the cac registration surface (hand-synced `CLI_COMMANDS` list deleted); `check-cli-parity` diffs the on-disk manifest against the derived surface and runs in `ci:local`.
- `gk run node --status` accepts `skipped` for `when`-predicate skips.
- `shouldExpire` default threshold 0.3 → 0.1 (the operating point every caller already used); `HALF_LIFE_DAYS` exported once from `eval/forgetting.ts`.
- `graph ascii`/`graph svg` route through loadGraph+validateGraph (previously raw YAML); SVG output escapes all graph-controlled strings (stored-XSS fix); both renderers share the executor's Kahn wave-level computation.
- `expandedRecall` is a projection of `explainRecall` (duplicated retriever deleted); ACT-R decay now scans `patterns/`/`suggestions/` subfolders (previously immortal); `malformed_count` populated in explain output.
- Schema strictness: `limits.max_workers|max_iterations|max_findings|budget_tokens` and `loop.exit_condition` deleted — `.strict()` rejects them at parse on every load path; `metadata` is strict and declares `task`.
- Single-source-of-truth: topology names (one `TOPOLOGY_NAMES` → zod enum + emitter table), model tiers (one `TIERS` const), `Graph` type exported from `schemas/graph.schema.ts`.
- `cbm:parity` removed from `ci:local` (CBM_CMD can never be set on fresh checkouts — it was a no-op gate); script fixed to probe `src/index.ts` and documented as a local instrument.
- `install.sh` `rm -rf` scoped to `$BIN/share/gk` (previously wiped the whole `share/` prefix).
- pi gk-execute dispatches nodes through omp's native `task` tool (batch `tasks[]` per wave, `agent: "gk-<node>"`) instead of `omp -p` child processes — in-process spawns, async delivery, `agent://`/`history://` artifacts, hub cancellation. `gk_dispatch_agent` remains for `timeout_ms` hard-kill budgets and advisor escalations.


### Fixed
- **Gate foreign-evidence lineage**: a stamped marker whose `run_id` falls outside the active run's `resumes:` ancestry is freshness `foreign` — strict mode BLOCKs with a foreign list, report mode warns. `run_id:null` (hand-written/legacy markers) is never foreign, and the check skips entirely with no active run — resume reconciliation's lineage rule now holds at the gate too.
- **Dangling `.active` deadlock**: a `.graphkit/runs/.active` pointer whose run directory was deleted previously deadlocked the CLI — `run start` blocked with `RUN_ACTIVE (unreadable .active)` and `take` rejected the dead id. `startRun` now auto-clears a dangling pointer, `take --from <dead-id>` recovers it (lenient only when `.active` names that id), and `run status` surfaces `dangling`/`dangling_run` instead of hiding the blocker.
- **Per-leaf usage in group help**: `gk run`, `gk memory`, `gk evidence`, `gk template`, `gk models` (and leaf `--help`, which cac routes to the group) now render an Examples block listing every leaf's args and leaf-specific flags instead of a bare name list + flattened shared options.
- **Ledger node/pid integrity**: `gk run node|land|dispatch` now reject node ids absent from the active run's recorded graph (UNKNOWN_NODE). `take` liveness treats EPERM as alive (foreign-user dispatchers no longer look dead) and skips non-positive/junk pids (BAD_PID at record time). `land` requires the node's LATEST trace to be ok and validates `--commit` as hex (BAD_COMMIT). `take` payload carries `foreign_evidence`. Resume on a deleted recorded graph fails GRAPH_FILE_NOT_FOUND; evidence-less ok traces no longer claim "passed with evidence on disk".
- **Run start graph resolution**: `--graph` → `./graph.yaml` → active session graph pointer (was: only `--graph`/`./graph.yaml`, so session-switched projects hit GRAPH_NOT_FOUND).
- **Evidence graph resolution**: `gk evidence add|report|invalidate` accept `--graph` and resolve via the active run's recorded graph before falling back to `<cwd>/graph.yaml` — a run on `--graph sub/x.yaml` can now stamp evidence from repo root. Superseded markers render `◌ superseded` in `gk evidence report` instead of `present` (gate already treated them as missing).
- **Waves payload completeness**: `role` and `eval` ride `gk graph waves --json` verbatim; computed advisory `warnings` now surface on the ok payload instead of being dropped.
- **`gk validate` routes `kind: GraphTemplate`** files to GraphTemplateSchema — no more 4-issue Graph-schema noise on gallery templates.
- **Schema/doc parity**: `metadata` and `inputs.*` defs accept unknown keys (documented open-by-design); node ids constrained to `^[A-Za-z0-9._-]+$` with `.`/`..` rejected (prevents `gk graph agents` mid-write ENOENT).
- **constraints.tools_allowlist** honors string and array forms and INTERSECTS the flag-derived base (was: union — allowlist could widen a no_write node into bash).
- **Duplicate-evidence warnings**: concurrent producers of one key warn (route-exclusive handlers, declared fan-out families, and identical-depend_on sibling waves exempt).
- **`gk run start --input k=v`**: required graph inputs with no default now fail MISSING_INPUTS; provided values recorded into run meta.
- **`gk init --force` preserves `.gk.json`** user keys (config read before the wipe, merged after); kitVersion warning now compares semver — newer recorded versions say "is newer than" instead of "predates".
- **Memory suggestions recallable**: suggestion files (proposed|accepted|dismissed) map into doc status space at read time, so `gk memory recall`/`touch`/`trace` see them (previously all malformed). Explain no longer dual-lists PPR neighbors as hit AND rejected; recall envelope `top_k` → `returned` (cap stays `recall_topk`).
- npm `gk --version` always reported the dev version (`0.3.0`): the release `publish` job re-checks out the repo, stamped only `package.json`, and `prepack` rebuilt `dist/index.js` with the committed `APP_VERSION`. `src/version.ts` is now stamped in `publish` too, so the npm bundle reports the release tag. Standalone tarballs were unaffected.
- `gk_dispatch_agent` timeout/abort now kills the child's whole process group (detached spawn + `kill(-pgid)`, SIGTERM then SIGKILL after 5s). Previously `execFile` SIGTERMed only the direct child — a timed-out node kept mutating shared state for 11+ minutes after the orchestrator recorded it failed. Timeout results now carry `timed_out: true` and a `TIMEOUT` marker in `output` (matchable by `retry.non_retryable`), and the tool honors the host abort signal.

### Added
- **`gk exec`** — headless graph runner: resolves a graph (same `[graph]`/`--graph`/`--session` inputs as every command), plans it via `planGraph()`, and drives it through the new `src/exec/` engine. One engine powers both paths: the host's interactive `gk-execute` skill (you dispatch via `task()`, engine records) and `gk exec`'s `childProcess` Runner (headless `omp -p` children). The `Runner` seam is the only difference. Engine owns wave barriers, `when` skip-cascades, retry/backoff, `timeout_ms` process-group kills, per-node + loop-group rounds, advisor escalation, `fan_out` briefs, `budget_tokens` compaction+spill, evidence stamps, `unresolved` dispatch reconciliation, and the `merged|blocked|failed` verdict. `--worktree` gives each write-capable node a git worktree (`.graphkit/worktrees/<id>` on `gk/<id>`) with merge-on-land. Judge-dependent fields (`when`, `stop_when`) refuse to run without a judge rather than silently mis-executing — `JUDGE_REQUIRED` / `UNSUPPORTED_LOOPS` fail fast.

### Changed
- **P1 event-store + planner-IR**: (1) **`src/runs/` split** — `ledger`, `resume`, `loops`, `analyze` moved out of `src/memory/`; `src/memory/` now holds only the knowledge-store modules. (2) **`planGraph()` IR** (`src/compiler/plan.ts`) — one wave-planner source for `graph waves`/`agents`/`ascii`/`svg`/`validate`; `topology_config` now rides the plan payload (was dropped at the CLI layer — audit CS#4); `topoWaves` re-homed from cli/ to compiler/. (3) **`land` is append-only** — `landNode` appends `{node,status:"landed",commit}` to `trace.jsonl` instead of read-modify-write (audit EL F1: concurrent appends were silently lost); `TraceLine.landed` field removed, `TraceEntry = TraceLine | LandEvent` union; gate `require_landed` reads the landed event newest-first.
- **`gk-execute` skill shrunk to the interactive adapter** (380 → ~55 lines): the engine owns every deterministic protocol line; the skill keeps only judgment — CHALLENGE adjudication, gate suspension, worktree-vs-same-tree escalation, curator `INJECTION:` interpretation. Declared-but-unimplemented `fan_out.reduce` (`merge`/`vote`) and `effort` scaling now surface a validate `unimplemented-field` warning instead of being silently ignored; `gk-init-graph` prose corrected to match.
- **P0 contract extraction** — four Layer-1 contracts unified across every command: (1) **one graph resolver** (`src/cli/graph-resolve.ts`) — `flag → file | session-id`; omitted → active run's recorded graph → session pointer → `./graph.yaml` (pointer beats root); `GRAPH_NOT_FOUND`/`NO_ACTIVE_GRAPH` replace per-command dead-ends, and session-graph *ids* are now accepted wherever a path was. (2) **one diagnostic envelope** — `GraphKitError` everywhere; `details.issues: {path, message, hint?}` is the single issues shape (semantic findings keep `check`/`severity` as extras); text-prefix `Error("CODE:…")` and the `errCode` regex deleted; `formatZodIssues` + did-you-mean live in `src/cli/diagnostics.ts`. (3) **`gk run start` validates before state** — schema + semantic findings (incl. agent-binding, refs) run *before* `runs/<id>` or `.active` are created; an invalid graph fails `VALIDATION_FAILED` with zero ledger writes. (4) **pi+claude target table** — one `agentFileName` (kebab) + `agentDirsFor` shared by `validate` and `graph agents`; "Software Architect" now validates AND materializes. Kits reduced to pi + claude.
- **`gk status` derives from the ledger** (`.active` + `run.md` + `trace.jsonl`) — reports the same run `gk run status` sees. The `runs/current.json` read is gone; nothing ever wrote it.

### Fixed
- `gk evidence add --node` is now forwarded into the marker — producing-node provenance lands in frontmatter (flag was declared but silently dropped).
- `gk init --force` wipe restored for pi/claude targets (deleted wholesale in the kit purge — regression caught by test).
- `gk inventory` no longer `INVENTORY_FAILED`s when a user-global agents dir is missing (restored `existsSync` guard in `collectAgents`).

### Removed
- **`.graphkit/evidence/.index` write-only log deleted** — `marker.md` is the single evidence record; `store.ts` append-path + dual-schema writer gone, `gk-evidence`/`gk-status` prose scrubbed (the `current.json` references too). One residual: `kits/claude/hooks/evidence-persist.cjs` still appends `.index` — zero readers remain, parked with the `lease-enforce.cjs` `current.json` family.
- **`kits/{cursor,opencode,codex}`** and their target-table entries — targets are pi + claude only. codex was hard-blocked by the agent-binding bug, opencode's dir contract was unverified, cursor's tier map was rotting.
- `runs/current.json` ghost read, `errCode` text-prefix error protocol, six-dir hardcoded agent probe ladder.
- **Bundled live viewer deleted for real**: `kits/{_core,claude,cursor}/viewer/` carried a stale pre-strictness GraphSchema and no build path after src/viewer was removed in 0.3.2; gen-kits viewer clauses and kit metadata deletions entries removed, claude/cursor gk-visualize fragments scrubbed (archify/SVG/ASCII/Excalidraw unaffected).
- Dead dependencies `ajv` + `ajv-formats` (zod is the only validator).
- `gk execute` / `gk visualize` NOT_IMPLEMENTED stub commands.
- `src/models/` re-export shim, `src/eval/metrics.ts` (unwired), `recallTopK` (production-dead), dead schema exports, `test/` directory (files moved to `tests/unit/`).
- Stray artifacts: `src/compiler/validate.ts:84-93`, `validate.ts:90`, `dist/gk` (64MB binary no longer inside the npm `files` glob — `build:bin` now emits to `build/`).
- Repo-root autoresearch experiment files and unlinked internal docs moved to `archive/`; `.tmp-*/` gitignored; `.graphkit/evidence/improve-review.md` untracked.

### Removed
- **CBM bridge killed — the external Codebase Memory MCP server is the integration** (`src/cbm/` client/contract/route/index, `scripts/cbm-parity.ts`, `src/cli/cbm-seam.ts`; −1421 lines). Six always-fail commands deleted: `graph index|search|trace|query|ask` and `memory index`. `graph ask` had no non-CBM path and went with the bridge. Workflow nodes query the MCP server in the host session like any other tool.
- **Compile/`.workflow.js` runtime killed — `planGraph` + exec is the only execution path** (`src/compiler/emitter.ts` + `resolver.ts`, `gk compile`, the `/gk:compile` + `/gk:run` claude workflow skills, and the `memory-augmented.workflow.js` gallery template; −1062 lines). Dual-runtime docs copy collapsed to the wave engine everywhere (landing page, architecture diagrams, parity notes).
- Memory spec shrink: Personalized PageRank link scoring and evidence-cooccurrence auto-linking dropped — co-occurrence links were noise-dominated. BM25 scoring + relative-score cutoff remain; explain/recall output shapes unchanged.

### Fixed
- **`gk memory consolidate` merge-retain keeps lifecycle `status` across re-consolidation**: a decay-marked pattern stays `deprecated`, a dismissed suggestion stays `dismissed` (previously every re-run flipped them back to `draft`/`proposed`); values outside the file kind's published enum still drop like corrupt fields.
- **Existing claude-kit installs now prune retired assets**: `kits/claude/metadata.json` carries a `deletions` ledger (`skills/gk-compile`, `skills/gk-run`, `templates/memory-augmented.workflow.js`) — the installer's cpSync overlay never deletes, so pre-P3 installs kept the dead compile-runtime files forever. Pinned by a `kit-deletions` test row.

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
