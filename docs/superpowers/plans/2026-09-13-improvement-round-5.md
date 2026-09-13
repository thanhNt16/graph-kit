# Improvement Round 5 — Implementation Plan

Design: `docs/superpowers/specs/2026-09-13-improvement-round-5-design.md` (item IDs A1–A9,
B1–B8, C1–C2, D1–D7 refer to it). Branch: `improvement/efficiency-quality-round5`.
Each numbered stage = one commit; `bun test` after every stage, `bun run ci:local` at the end.
Every fix lands failing-first (repro test before the fix).

## Stage 1 — fix: graph-name safety, ledger strand, session-graph race (A1–A3)

1. Failing tests first: (a) graph.yaml `name: ../../escape` → compile/svg/`evidence report
   --html` must not write outside `.claude/workflows/`/`.graphkit/diagrams/`/`.graphkit/reports/`;
   (b) `name: My Graph` full lifecycle (`run start` → `run node` → `run end`) must succeed and
   leave a resumable, indexed run; (c) 8 concurrent `saveSessionGraph` calls → 8 distinct files,
   no success envelope pointing at another writer's bytes.
2. Add one shared `safeGraphName(name)` (slugify: lowercase kept as-is, whitespace/unsafe runs →
   `-`, keep `[\w.-]`, collapse repeats, trim `-.`) next to the existing `slugify` in
   `src/store/index.ts`; use it at the three path-join sites (compile workflow filename,
   svg filename, evidence report filename) and in the run-id derivation so the id always matches
   `readRunMeta`'s regex. Display value (ledger prose, `graph show`, `run list` graph column)
   keeps the raw name.
3. `src/memory/ledger.ts` `endRun`: read meta before removing `.active`; on meta-read failure
   keep `.active` (or leave a recovery pointer) and fail with a remediation hint.
4. `saveSessionGraph`: `writeFileSync(path, data, { flag: "wx" })` in the suffix loop
   (EEXIST → next suffix); document the race contract in the function header.

## Stage 2 — fix: consolidate robustness, suggestions recall, evidence/criteria edges (A4–A9)

1. `src/memory/consolidate.ts` prune: `readdirSync(dir, { withFileTypes: true })` + `isFile()`;
   `index.md` via `atomicWrite`; `src/cli/commands/memory.ts` consolidate action wrapped in the
   standard fail envelope (try/catch → `CONSOLIDATE_ERROR`, matching siblings). Test: dir named
   `*.md` in memory root → enveloped failure, no raw stack; prune skips it.
2. `src/memory/recall-expanded.ts` suggestions walk: validate with the permissive entry schema
   (as `links.ts` does) so `status: proposed` passes; healthy suggestions become recallable,
   `malformed` counts only truly malformed files. Test: store with one note + one consolidate
   suggestion → recall returns the suggestion hit, `malformed: 0`.
3. `src/evidence/criteria.ts`: replace the private `/^---\n…/` regex with shared `splitFrontmatter`.
   Test: CRLF criteria file keeps `kind: screenshot` and a clean description.
4. `src/cli/commands/evidence.ts` add: `isAbsolute(file) ? file : join(cwd, file)`. Test with an
   absolute path outside cwd.
5. `src/store/index.ts` `loadActiveGraph`: wrap `YAML.parse` in the `YAML_INVALID` GraphKitError
   wrap (file + line + col + hint), same as `loader.ts`. Test: corrupt active session graph →
   `gk validate` emits `YAML_INVALID` with the file field.
6. `src/cli/svg.ts`: entity-escape node ids/agent names/labels interpolated into `<text>` and
   `<title>` (small `escapeXml` helper). Test: `<script>` in a node id renders escaped.

## Stage 3 — refactor: printFail + exit(1) retirement (B1, B8 partial)

1. `src/cli/output.ts`: `printFail(code, message, opts?: { details?, json?, hint? })` — json →
   the exact current envelope bytes; human → `✗ CODE — message` + indented issue list
   (reuse `renderFindings` when `details.issues` present) + hint line. Add `printFailFromError`
   absorbing the 10× `e instanceof GraphKitError ? fail(e.code,…) : fail("X_ERROR",…)` ternary.
2. Codemod `console.log(JSON.stringify(fail(` → `printFail(` across src (39 exact one-line
   sites; ~15 multiline by hand); each site passes its json flag; every former
   `process.exit(1)` after a fail is deleted with a control-flow check (must return).
   Exit-code semantics: `fail()`/`printFail` set `process.exitCode = 1`.
3. Tests: migrate `exit).toBe(1)` assertions (37) to `exitCode`; new test pins human rendering
   of a schema-fail envelope in validate (the DX-lens raw-JSON case); --json byte-shape pinned
   by existing envelope tests.
4. cli-harness `runAsync`: resolve when the stubbed `process.exit` fires or the handler promise
   settles; drop the blind settle sleep (cli-trust 500ms burn gone). Keep a tiny settle for
   fire-and-forget IIFE sites not yet migrated (verify none remain after Stage 4; delete fully
   there).

## Stage 4 — refactor: graph/ package, planner extraction, group kit (B2–B7)

1. Extract `planExecutionWaves(graph)` (curator interleave + cadence, graph.ts:519–654) into
   `src/compiler/waves.ts`; unit tests for cadence/every-3/curator placement (previously only
   CLI-tested).
2. Split `src/cli/commands/graph.ts` → `src/cli/commands/graph/`: `register.ts` (route table
   keyed by subcommand → handler), `cbm.ts` (CBM_ACTIONS + runCbmAction + client call + test
   seam), `lifecycle.ts`, `render.ts`, `waves-plan.ts`; `graph.ts` becomes a shim re-exporting
   `registerGraphCommand`. Route-table test: keys === `subcommandsFor("graph")`.
3. `src/cbm/seam.ts`: `withCbmClient(fn)` + `_injectCbm`/`_resetCbm`; graph/cbm.ts and memory.ts
   consume it (two seam copies → one).
4. `defineGroup({group, handlers})` in `command-registry.ts`: bare-`gk X` usage text,
   UNKNOWN_*_SUBCOMMAND with `available:` from the registry (fixes template.ts:534 hardcode),
   shared `posArgs` arg normalization (11 copies). Migrate memory → template → run → models;
   graph follows its new register.ts.
5. `renderTable(headers, rows)` in `cli/output.ts`; adopt in the 9 command files with padEnd
   blocks; human-mode tests stay green (columns may tighten, content identical).
6. Dead exports out: `loadMemories`, `isValidParamName`, `recencyDecay`, `symbols`,
   `suggestionsFor`, `summarizeDoctor`, `loadOverrides`; `templatesDir` → `graph-templates.ts`.
   tsc is the pin.
7. Harness settle sleep fully removed (all handlers now awaited); full `bun test` green.

## Stage 5 — perf: lazy dispatch + parity parallelize (C1, C2)

1. Lazy command dispatch: registration stays eager using light descriptors (from
   `command-registry.ts` data; no heavy imports at registration), action bodies resolve via
   `await import()` of the command module (bun `--splitting` emits chunks next to
   `dist/index.js`). Keep `gk --help`/group help rendering offline-cheap. Risks checked:
   `npm pack` includes chunks (extend `files`), release `--compile` path builds, `check:parity`
   exercises all 49 leaves through the real bundle, completions/manifest unchanged.
   Measure before/after: `node dist/index.js --version`, `bun run perf` CLI recall row.
2. `scripts/check-cli-parity.ts`: run leaf + unknown-leaf probes with bounded concurrency (8),
   one temp dir per worker; same assertions, same output. `time bun run check:parity` before/after.

## Stage 6 — feat: run plan, gallery completion, examples, gate annotations (D1–D3, D7)

1. `gk run plan [--graph <path>] [--json]`: loadGraph → validate (exit 1 on findings, so it's
   the preflight) → `planExecutionWaves` → human table (wave × node × tier × evidence keys) +
   worst-case dispatch totals (node loops × max_rounds + loop-group spans × max_rounds +
   advisor max_calls + fan-out bound). Register + manifest regen + harness tests (+ error-codes
   entry if a new code appears).
2. `gk new --topology <t>`: writes starter graph.yaml (reuse `graph new` body) + kit install;
   `gk template list --topology <t>` filter. 7 curated gallery templates (classify-and-act,
   adversarial-verification, generate-and-filter, memory-augmented, sdd, superpowers,
   research-and-build) — each validated by a new test that materializes every gallery template
   and runs the loader (gallery-rot guard).
3. `examples/review-diamond.yaml` (no CBM dependency) + `examples/README.md` transcript.
4. `gk gate --github-actions`: per blocked key `::error title=gk gate: <key>::<detail>` lines;
   `--json` unchanged. Harness test.

## Stage 7 — docs + kits: parity, discovery, honesty, accuracy (D4–D6)

1. Kits: port pi's loop-group (`loops:`/`gate_evidence`) section into claude/cursor/opencode/
   codex execute skills (host-flavored dispatch wording only); add `gk run list` line to
   gk-run resume guidance (5 kits); `gk memory list/show` into memory-curator/gk-recall
   (5 kits); gk-status rewritten to prefer `gk status`/`gk run list` over hand-parsing files +
   corrected creation hint; strip stale `as_of` teaching from the 4 laggard gk-recall skills.
2. `memory recall`/`memory list` human mode: print the malformed count line when > 0
   ("N entries skipped as malformed — details: --json"); memory-curator Extract step documents
   required `id` + RFC3339 date with a copyable example; README memory section matches.
3. Docs accuracy: README example gains the missing `objective:` lines; new test extracts fenced
   ```yaml blocks under "Define a graph" from README and runs them through the loader; README
   CLI reference rows corrected (run list, memory list/show, evidence, completions);
   GK_VERSION example → latest; CHANGELOG [Unreleased] collapsed to one Added/Changed/Fixed;
   error-codes.md deduped + drift guard fails on duplicate catalogue rows.

## Stage 8 — changelog + backlog + gates

1. CHANGELOG [Unreleased]: this round's entries. `idea-backlog.md`: round-5 status block
   (cleared / still deferred with reasons). README TOC rows for new commands.
2. `bun run ci:local` green; `bun run perf` before/after into the commit message;
   `scripts/gen-cli-manifest.ts` + `git diff --exit-code cli-manifest.json`.
