# Improvement Round 4 — Design

**Date:** 2026-09-11 · **Branch:** `improvement/efficiency-quality-round4` (stacked on round 3)
**Method:** 5-lens parallel sub-agent brainstorm (performance, correctness, DX/productivity,
architecture, product-value), each auditing the tree at `4d3722a` with measured evidence.
Synthesis below; every accepted item cites its evidence source.

## What this round is about

Rounds 1–3 fixed the dishonest-output class and the big perf items. The five lenses converged on
what remains, in four themes:

1. **Silent data loss / trust bugs** (correctness lens, all CONFIRMED by execution or end-to-end
   trace): a garbage `last_used_at` string silently expires any memory on the next
   `gk memory trace` (`ageDays → Infinity → score 0 → shouldExpire`); `renderMarker` interpolates
   unescaped values into YAML so a note containing `": "` corrupts the marker and gate freshness
   degrades to unknown; evidence `report --html` embeds any marker-authored `artifact:` path
   (traversal → arbitrary file read); `resume` joins trace-authored evidence keys into paths
   without the `isValidEvidenceKey` guard; `startRun` has a TOCTOU on the run dir (two same-second
   starts share one dir and the loser clobbers the winner's ledger before dying on the claim);
   `models` silently discards a corrupt overrides file then permanently overwrites it; `gk init`
   writes `AGENTS.md` non-atomically and duplicates the managed section when the END marker is
   missing; `gk template list` crashes wholesale on one malformed template file.
2. **Measured performance** (perf lens, numbers from `bun run perf` + microbenches):
   `YAML.parse` of tiny frontmatter files is ~93% of recall/links/consolidate cost at n=5000
   (346ms vs 3.5ms for a flat-scalar parser); the default CBM command burns ~800ms spawning
   `npx -y` on a guaranteed E404; `buildLinks` is O(m²) on shared entities (5.8s measured
   pathological case, invisible to the perf harness because its synthetic entries carry no
   entities); `graph show <id>` YAML-parses every session graph for an O(1) filename lookup;
   `expandedRecall` filters the full doc set twice.
3. **Product gaps with the data layer already shipped** (product lens): the advertised
   `gk run resume <run-id>` has no front door (`readRunIndex`/`listRunIds` exist with zero CLI
   consumers, and `gk run status` ignores its argument); `gk status` computes evidence coverage
   against `cwd/graph.yaml` instead of the resumed run's graph, so a resumed run shows permanent
   BLOCK; `gk memory trace` ignores `expire_policy` from graph.yaml and silently mutates the
   store with no `--dry-run`; the memory store has no inspection surface (`memory touch` exists,
   no way to discover ids); every kit tells agents to prefer `gk graph ask`, which fails with
   `CBM_UNAVAILABLE` 100% of the time today and no kit mentions the fallback.
4. **DX + validated deferred backlog** (DX/architecture lenses): `gk validate` on a malformed
   YAML loses file:line inside a generic `VALIDATE_ERROR` string; ~8 commands still print raw
   JSON envelopes to humans (run start/node/end, consolidate, template list, evidence report,
   VALIDATION_FAILED findings); `gk completions` is now cheap because the command registry is
   already the completion spec; leaf-command help lacks the examples groups got in round 2;
   the wave computation exists three times (`graph.ts` Kahn BFS, `validate.ts` and `ascii.ts`
   twin DFS longest-path) — the deferred backlog item is real and S-effort, not M;
   16 of 18 candidate test files still hand-roll `runCli` instead of the round-3 harness;
   one load-bearing cast (`template.schema.ts:214`) bypasses graph validation after
   substitution; README/error-codes/CONTRIBUTING docs drift.

## Scope — accepted items

### A. Correctness batch (`fix` commits)
- **A1 (E1, backlog)** — `forgetting.ts`/`memory.ts`: unparseable `last_used_at` → treat as
  unknown: skip auto-expiry for that entry, count it in the trace report
  (`unparseable_dates`), never map to `ageDays = Infinity`; `Number.isFinite` guards in
  `actRScore` (NaN salience/connectivity in → neutral handling out). Missing dates already
  fall back to `now`; future dates already clamp — untouched.
- **A2** — `marker.ts`: serialize marker values via `YAML.stringify` (or equivalent quoting) so
  notes with `: `, `#`, or newlines round-trip; round-trip test.
- **A3** — `report.ts`: contain marker-authored `artifact:` paths to the evidence dir
  (resolve + prefix check; reject absolute/`..`), matching the fixed evidence-key guard.
- **A4** — `resume.ts`: filter trace-read evidence keys through `isValidEvidenceKey`; invalid
  keys count as unsatisfied, never as paths.
- **A5** — `ledger.ts` `startRun`: exclusive-create the run dir leaf (`mkdirSync` non-recursive
  on the leaf, parent recursive; EEXIST bumps suffix) so concurrent starts cannot share a dir.
- **A6** — `template.ts`: per-entry parse tolerance in `template list` (collect `skipped`,
  warn like `graph list`); `template show/materialize` unknown-id path surfaces
  `TEMPLATE_NOT_FOUND` + close matches, not the parse error of an unrelated file.
- **A7** — `models.ts`: corrupt overrides JSON → loud warn (not silent `{}`), refuse `set` over
  unparseable file without `--force`, `atomicWrite`, uppercase `MAP_INVALID` code.
- **A8** — `kit.ts`: `AGENTS.md` writes via `atomicWrite`; START-without-END repairs the
  section (replace from START to EOF) instead of appending a duplicate.
- **A9** — `cbm/client.ts`: per-call timeout (default 60s, `CBM_TIMEOUT_MS` env), rejecting
  into the existing unavailable envelope instead of hanging forever.
- **A10** — honesty riders: `memory touch` without id → `MISSING_ARG` (not
  `id "undefined"`); `template` group help stops listing the nonexistent `close` subcommand.

### B. Performance batch (`perf` commit)
- **B1** — `frontmatter.ts`: flat-scalar fast-path parser (strict whitelist: `key: value` lines
  only, YAML-core scalar typing for int/float/bool/null, reject quotes/flow/nesting/`#`/indicator
  chars) falling back to `YAML.parse` for anything else; parity tests against `YAML.parse` on a
  representative corpus. Recall/links/consolidate ~5x at n=5000 (234→~40ms measured).
- **B2** — `cbm/client.ts`: when neither `CBM_CMD` nor `CBM_ARGS` is configured, throw the
  unavailable error immediately — no `npx` spawn on a guaranteed E404 (800ms→0 on six commands
  in the default config). Explicitly configured bridges spawn as before.
- **B3** — `links.ts`: shared-entity support threshold (entities shared by > K entries, K=50,
  carry no discriminative signal) so `buildLinks` cannot go O(m²); kills the measured 5.8s case.
- **B4** — `graph.ts` show: O(1) session-graph file read by validated id; `listSessionGraphs`
  only on the not-found path.
- **B5** — `recall-expanded.ts`: compute the valid-doc filter once per recall, not twice.
- **B6** — `package.json`: `bun build --minify` (dist 962KB unminified; ~15–20ms startup).
- **B7** — `evidence/store.ts`: hoist the duplicated `activeRun(cwd)` call.

### C. Product batch (`feat` commits)
- **C1** — `run.ts` + `ledger.ts`: `gk run list [--json]` (table over `readRunIndex()` ∪
  `listRunIds()`, active/ended marked) and `gk run status <run-id>` renders any run via the
  existing status renderer; bare `gk run status` keeps current behavior (active run).
- **C2** — `status.ts`: coverage source = `activeRunGraph(cwd) ?? cwd/graph.yaml` so resumed
  runs score against the derived child graph (same class as round-3's ledger-authoritative fix).
- **C3** — `memory.ts`: `memory trace` threads `expire_policy` from graph.yaml (as `recall`
  already does) and gains `--dry-run` (score report, no writes); help text says what mutates.
- **C4** — `memory.ts`: `gk memory list [--json]` (id, status, salience, use_count, path) and
  `gk memory show <id>`; discovery for the audit-contract store (no delete command — expired
  entries are retained by design).
- **C5** — `kits/`: one CBM-degradation line per target's graph-aware agents: on
  `CBM_UNAVAILABLE`, fall back to Grep/Glob and say the bridge is unavailable. (R8 rg-retriever
  stays YAGNI: off-mission per program.md baseline, duplicates host Grep, L effort, design
  notes lost — revisit only if CBM stays unpublished long-term.)

### D. DX batch (`feat`/`fix` commits)
- **D1** — `loader.ts`: wrap `YAMLParseError` → `GraphKitError("YAML_INVALID", …, {file, line,
  col, hint})`; new error-codes.md entry (drift-guarded). Zod findings keep their dotted paths.
- **D2** — human output completion (narrow slice of the deferred central-renderer item):
  `validate`/`gate VALIDATION_FAILED` render findings as an indented list with file:line when
  present; `run start/node/end`, `memory consolidate`, `template list` (with the README-promised
  `origin` column), `evidence report` (human mode prints the report path/summary) get one-line
  human summaries. `--json` envelopes unchanged; fail envelopes still stdout (stderr rerouting
  is the deferred contract-change item).
- **D3** — `completions.ts`: `gk completions [bash|zsh|fish]` generated from `CLI_COMMANDS`
  (words from paths, flags from options), static script + install hint; joins the manifest/
  parity gates for free.
- **D4** — leaf-command `.example()` lines for init/validate/compile/gate/status/doctor/
  inventory/suggest/new (groups already have them).
- **D5** — docs drift: README template-list origin claim matches shipped output, error-codes
  `--params '<json>'` (not `--param k=v`), eval:memory gate wording, CONTRIBUTING repo map +
  env-var table, `ci:local` fails fast (test before build).

### E. Architecture batch (`refactor` commit)
- **E1 (backlog item, verdict DO IT — S not M)** — new `src/compiler/waves.ts`:
  `computeWaves(nodes) → { waves, unresolved }`; `graph.ts` (Kahn) and the twin DFS copies in
  `validate.ts` + `ascii.ts` converge on it; cycle handling stays loud in `graph waves`
  (WAVES_INCOMPLETE), silent-0 uses are gone. `deriveRound(trace)` folds into `ledger.ts`.
  Explicitly out of scope: curator-cadence parity with compiled `.workflow.js` templates
  (compiled artifacts stay dependency-free; parity contract test instead).
- **E2** — `src/memory/frontmatter.ts` → `src/frontmatter.ts` (generic utility out of the memory
  domain; compiler/evidence/cli/eval stop importing upward).
- **E3** — `template.schema.ts:214`: `GraphSchema.parse` after substitution →
  `TEMPLATE_MATERIALIZED_INVALID` GraphKitError (removes the one load-bearing cast).
- **E4** — kill the `graph.ts` import-hub re-export (`loadGraph` consumers import the loader
  directly); fix `ascii.ts:163` dead conditional; mark `hooks.on_fanout_dispatch`
  declared-but-unused in schema docs.
- **E5** — migrate the 16 hand-rolled `runCli` test files to `tests/helpers/cli-harness.ts`;
  waves tests get pinned cwds.
- **E6** — acceptance test: session lifecycle `template materialize → graph list → switch →
  show → waves → compile` through the real CLI.

## Explicitly deferred (with reasons — carried to idea-backlog.md)

- **Central fail-envelope renderer + fails→stderr** (D2 is the narrow slice): contract change,
  ~40 call sites, deserves a dedicated round with the exit-code-mechanism unification.
- **graph.ts slimming / `withEnvelope`** — right after the harness migration lands.
- **Lazy command dispatch** (M, ~30–40ms more startup) — minify first, measure again.
- **Persistent `.recall-index.json`** — stat-keyed design notes lost; recall is already ms-scale
  after B1; only revisit if `bun run perf` shows recall dominating at realistic sizes.
- **R8 rg fallback retriever** — off-mission (program.md: gk must beat the grep arm), L effort.
- **Date-only `valid_from`/`valid_to` local-day normalization** (UTC-midnight skew, SUSPECTED
  severity L-M) — needs a product decision on intended day semantics; documented, not patched.
- **E2–E5 memory clamps, `memory forget`/vacuum, coverage-floor gate** — no user pull yet;
  E1 (this round) was the one with demonstrated data loss.

## Testing & gates

Every item lands with tests (parity tests for B1, round-trip for A2, race test for A5,
traversal tests for A3/A4, harness-based CLI tests for C1–C4/D2/D3). `bun run ci:local`
(typecheck, lint, build, test, cbm:parity, eval:memory, changelog, parity, manifest drift) must
pass before push. Perf deltas re-measured with `bun run perf` before/after.
