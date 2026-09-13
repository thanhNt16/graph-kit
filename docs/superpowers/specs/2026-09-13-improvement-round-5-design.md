# Improvement Round 5 — Design

**Date:** 2026-09-13 · **Branch:** `improvement/efficiency-quality-round5` (stacked on round 4)
**Method:** 5-lens parallel sub-agent brainstorm (performance, correctness, DX/productivity,
architecture, product-value), each auditing the tree at `d7edbd4` with measured/executed evidence.
Synthesis below; every accepted item cites its evidence source.

## What this round is about

Rounds 1–4 fixed the dishonest-output class, the measured perf items, and shipped the round-4
product surface. The five lenses converged on four themes:

1. **Graph-name is the last unguarded agent-authored string** (correctness lens, all CONFIRMED by
   executed repros): `metadata.name` is `z.string()` with no charset check and is joined into
   output paths by `compile`, `graph svg`, and `evidence report --html` — `name: ../../x`
   escapes the project dir and silently overwrites an existing file. The same free-text name
   flows into the run id, where `readRunMeta`'s `[\w.-]+` regex rejects it: `gk run end` removes
   `.active` *then* fails, permanently stranding the run (never indexed, never resumable).
   `saveSessionGraph` is still check-then-write (the run-dir TOCTOU class, missed instance).
2. **The two big deferred architecture items are now unblocked** (architecture lens, counts
   produced): the cli-harness migration landed in round 4, so `graph.ts` (697 lines, 13 else-if
   branches, 24 fail sites, 136-line inline planner) can split into a route-table package; and
   the central fail path is smaller than feared — **78 `fail(` sites, 39 of them exact
   `console.log(JSON.stringify(fail(` one-liners, 61 redundant `process.exit(1)` calls** (fail()
   already sets `exitCode = 1`). A `printFail` helper absorbs the print boilerplate, catches the
   DX lens's finding that catch-block envelopes still print raw JSON in human mode, and makes
   the deferred fails→stderr flip a one-line future change (still deferred).
3. **Startup dominates the small-command budget** (perf lens, measured): `node dist/index.js
   --version` is 67–80ms vs 23ms node floor; a probe bundle without the eager command imports
   runs 20–25ms. Ceiling ≈ **55ms on every invocation**, attributed to eager init of zod
   (42.7ms), yaml (25.3ms), dagre (6.2ms) pulled in by top-level `register*Command` calls. The
   deferred lazy-dispatch item is now justified by measurement.
4. **Discovery/doc drift is now the main DX tax** (DX + product lenses, all CONFIRMED by
   running the CLI): the README's own "Define a graph" example fails `gk validate` (missing
   `objective` on two nodes); four of five kits teach the removed `as_of` recall argument; only
   the pi kit teaches README-documented `loops:`/`gate_evidence`; round-4's `run list` /
   `memory list/show` are absent from kit skills and the README CLI reference; hand-written
   memory files vanish silently (human `recall`/`list` never mention the malformed count); 7 of
   11 topologies have no materializable template and `examples/` ships one file that fails fast
   by design; there is no pre-flight view of what a run will spend.

## Scope — accepted items

### A. Correctness batch (`fix` commits)
- **A1** — Graph-name safety end-to-end: one shared `safeGraphName` (slugify to the run-id
  charset `[\w.-]`, collapsing unsafe runs of chars) used at all consumers — compile workflow
  filename, svg filename, evidence report filename, and run-id derivation — so path joins stay
  inside `.claude/workflows/`, `.graphkit/diagrams/`, `.graphkit/reports/`, `.graphkit/runs/`.
  `metadata.name` keeps its display value in output/ledger prose; only derived paths slugs.
- **A2** — `ledger.endRun` reads meta **before** removing `.active` so a meta failure leaves the
  run resumable instead of stranding it; failure path keeps exitCode 1 either way.
- **A3** — `saveSessionGraph` exclusive-create (`wx` flag) with suffix bump — the session-graph
  sibling of the round-4 run-dir TOCTOU fix; race test with concurrent savers.
- **A4** — `memory consolidate`: `readdirSync(withFileTypes)` + `isFile()` in prune (EISDIR on a
  directory named `*.md`), `atomicWrite` for `index.md`, and a standard fail envelope around the
  consolidate action (the only unenveloped sibling).
- **A5** — Suggestions are first-class for recall: the `suggestions/` walk uses the permissive
  entry schema (as links.ts does) so `status: proposed` validates; healthy suggestions stop
  being counted `malformed` and become recallable/touchable.
- **A6** — `loadCriteria` uses the shared CRLF-tolerant `splitFrontmatter` (kind no longer
  degrades to `report`, raw frontmatter no longer leaks into descriptions; validate and report
  agree).
- **A7** — `evidence add` accepts absolute artifact paths (`isAbsolute` check before join).
- **A8** — `loadActiveGraph` routes YAML parse errors through the `YAML_INVALID` wrap (file +
  line + hint), matching `loadGraph`; `gk validate`/`graph show` stop leaking raw YAMLParseError.
- **A9** — SVG text escaping: node ids/agent names from graph.yaml are entity-escaped in
  `<text>`/`<title>` (agent-authored markup cannot inject elements into the generated SVG).

### B. Architecture batch (`refactor` commits)
- **B1** — `printFail(code, message, opts)` in `cli/output.ts`: human mode renders one
  `✗ CODE — message` line (+ indented finding list when details.issues present + remediation
  hint when the error carries one); `--json` prints the unchanged envelope. Codemod the 39
  exact `console.log(JSON.stringify(fail(` sites; hand-migrate the ~15 multiline sites; delete
  every `process.exit(1)` that immediately follows a fail (fail already sets `exitCode = 1`).
  Per-site control-flow check: fail sites must return. Test assertions migrate `exit).toBe(1)`
  → `exitCode).toBe(1)`. **fails→stderr stays deferred** — the flip becomes one line inside
  printFail when a consumer asks.
- **B2** — `graph.ts` → `src/cli/commands/graph/` package, split by cohesion: `register.ts`
  (thin route table keyed by subcommand), `cbm.ts` (CBM action dispatch + client seam shared
  with memory.ts), `lifecycle.ts` (list/switch/show/inspect/new), `render.ts`
  (topologies/ascii/svg), `waves-plan.ts` (thin CLI wrapper). `graph.ts` remains as a shim
  exporting `registerGraphCommand`. Route keys asserted === `subcommandsFor("graph")`.
- **B3** — Extract `planExecutionWaves(graph)` (the 136-line curator-interleave/cadence planner,
  graph.ts:519–654) into `src/compiler/waves.ts` as a pure function; new direct unit tests pin
  cadence/every-3 edge cases that previously required the CLI.
- **B4** — `defineGroup({group, handlers})` in `command-registry.ts`: shared bare-`gk X` usage
  text, UNKNOWN_*_SUBCOMMAND tail with `available:` derived from the registry (kills the
  hand-typed drift at template.ts:534), one arg-normalization helper (11 copies). Migrate
  memory → template → run → models.
- **B5** — Shared CBM seam `src/cbm/seam.ts`: `withCbmClient(fn)`, `_injectCbm`, `_resetCbm`
  (graph.ts:31–53 and memory.ts:24–53 duplicates converge).
- **B6** — `renderTable(headers, rows)` in `cli/output.ts`; adopt across the 18 padEnd blocks in
  9 command files.
- **B7** — Dead-export deletion (verified unreferenced across src+tests+scripts):
  `loadMemories`, `isValidParamName`, `recencyDecay`, `symbols`, `suggestionsFor`,
  `summarizeDoctor`, `loadOverrides`; `templatesDir` moves out of kit.ts (only cross-command
  import).
- **B8** — cli-harness: `runAsync` resolves on the stubbed `process.exit` / handler completion
  instead of the 50–100ms settle window (after B1 makes handlers deterministic); the
  cli-trust `memory index` test stops burning its full 500ms timeout.

### C. Performance batch (`perf` commits)
- **C1** — Lazy command dispatch (deferred round-3/4 item, now measured-justified): command
  registration stays eager (cac needs descriptors) but action bodies `await import()` their
  implementation; build with `--splitting` so chunks ship beside `dist/index.js` (npm `files`
  gains the chunk pattern; release `--compile` path unaffected). Registration descriptors move
  to the existing registry data so importing them stays cheap. Target: `--version` 67ms →
  ~25ms; small-store `memory recall` 63.5ms → ~15ms. Gated by `check:parity` (all 49 leaves in
  the built bundle), the full suite, and `npm pack` contents check.
- **C2** — `check:parity` parallelized (concurrency 8, one temp dir per worker): 2.44s → ~0.5s
  of `ci:local` wall.

### D. Product + DX batch (`feat`/`docs` commits)
- **D1** — `gk run plan [--graph g.yaml] [--json]`: pre-flight execution plan — per-wave
  node × model-tier table with evidence keys, plus run-level worst-case dispatch count
  (node loops × max_rounds + loop-group spans × max_rounds + advisor max_calls + fan-out
  bound) — built on B3's extracted planner; exit 1 on invalid graph so it doubles as the
  execute-skill Step-0 preflight (kit line added to all five targets).
- **D2** — Topology gallery completion: `gk new --topology <t>` writes a starter graph.yaml
  (not just the kit); `gk template list --topology <t>` filter; curated templates for the 7
  uncovered topologies (classify-and-act, adversarial-verification, generate-and-filter,
  memory-augmented, sdd, superpowers, research-and-build); a CI test materializes + validates
  every gallery template (gallery-rot guard).
- **D3** — Runnable example: `examples/review-diamond.yaml` (no CBM dependency) +
  `examples/README.md` with the expected transcript (validate → ascii → run start/node/end →
  gate).
- **D4** — Kit parity + discovery (content edits across kits):
  port pi's `loops:`/`gate_evidence` loop-group section to claude/cursor/opencode/codex
  execute skills; add `gk run list` to gk-run resume guidance and `gk memory list/show` to
  memory-curator/gk-recall; rewrite gk-status to call `gk status`/`gk run list` instead of
  hand-parsing `.active` (and fix the wrong /gk:init-graph hint); remove the stale `as_of`
  teaching from the four laggard gk-recall skills.
- **D5** — Memory honesty lines: human `memory recall`/`memory list` print "N entries skipped
  as malformed (details: --json)"; memory-curator Extract step documents required `id`/date
  format with an example; README memory section matches.
- **D6** — Docs accuracy batch: README "Define a graph" example fixed (missing `objective`) +
  a test that validates README-fenced graph yaml blocks; README CLI reference regenerated
  (adds `run list`, `memory list/show`, `evidence`, `completions` rows); `GK_VERSION` example
  unpinned from v0.3.8; CHANGELOG [Unreleased] collapsed to a single Added/Changed/Fixed set;
  error-codes.md duplicate rows deduped + drift guard extended to fail on duplicate catalogue
  entries.
- **D7** — `gk gate --github-actions`: emits `::error title=…::…` annotation lines per blocked
  key (deterministic formatting of the existing verdict; junit stays deferred).

## Explicitly deferred (carried to idea-backlog.md)

- **fails→stderr** — one-line flip inside printFail after this round; no consumer pull yet.
- **zod hand-map for n=5000 stores** (perf lens #3) — ~20% of a 180ms path only at n≥5000;
  borderline speculative, L effort.
- **`memory list --stats`, `gate --junit`** — speculative pull; revisit after run plan /
  github-actions land.
- **Single-source kit skill bodies** (per-host prefabs over one source) — L effort; round-5's
  kit edits make the drift concrete, revisit if it recurs.
- Unchanged from round 4: E2–E5 clamps, R8 rg retriever, persistent recall index,
  date-only validity windows, memory forget/vacuum, coverage-floor gate.

## Testing & gates

Every fix lands with a failing-first test (traversal repro, run-id strand repro, save race,
EISDIR, suggestion recall, CRLF criteria, absolute artifact, envelope parity, SVG escaping).
Refactors are pinned by the existing 5 graph test files + cli-usage-errors + group-help lists,
plus new unit tests for planExecutionWaves and the route-table shape. `bun run ci:local`
(typecheck, lint, test, build, cbm:parity, eval:memory, check-changelog, check:parity,
manifest drift) must pass before push. Startup and recall deltas re-measured with `bun run perf`
before/after C1.
