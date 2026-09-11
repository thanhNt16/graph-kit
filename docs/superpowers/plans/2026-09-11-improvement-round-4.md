# Improvement Round 4 — Implementation Plan

Design: `docs/superpowers/specs/2026-09-11-improvement-round-4-design.md` (item IDs A1–A10,
B1–B7, C1–C5, D1–D5, E1–E6 refer to it). Branch: `improvement/efficiency-quality-round4`.
Each numbered stage = one commit; `bun test` after every stage, `bun run ci:local` at the end.

## Stage 1 — perf: memory-path + CBM fast paths (B1–B7)

1. `src/memory/frontmatter.ts` → add `parseFlatFrontmatter(text)` fast path: every line must
   match `^([A-Za-z0-9][A-Za-z0-9_-]*): (.*)$` with a value that is non-empty, contains none of
   `#"':{}[]&*!|>%@`, and does not end in `\`; type scalars (int/float/true/false/null/~) like
   YAML core schema, everything else stays string; ANY other line → `null` → caller falls back
   to the existing `splitFrontmatter` + `YAML.parse`. Keep CRLF handling identical.
   Parity test: fast-path output deep-equals `YAML.parse` output across a corpus of real memory
   frontmatter (salience floats, ISO dates-as-strings, booleans, ids) + hostile lines.
2. `src/cbm/client.ts`: (a) `createCbmClient` throws unavailable immediately when neither
   `CBM_CMD` nor `CBM_ARGS` is set — no spawn; (b) per-call timeout via `setTimeout`
   (`CBM_TIMEOUT_MS`, default 60000) that deletes the pending entry and rejects with the
   unavailable envelope; cleared on response/exit.
3. `src/memory/links.ts`: in `buildLinks`, skip entities with `ids.length > 50` (module const
   `MAX_ENTITY_SUPPORT`), comment why; add a regression test with one over-shared entity
   (n=2000 entries) asserting ms-scale runtime shape (assert result correctness, not time).
4. `src/cli/commands/graph.ts` show: read `graphsDir/<id>.yaml` directly after id validation;
   keep `listSessionGraphs` for the miss path + suggestions.
5. `src/memory/recall-expanded.ts`: single `applyRecallFilters` pass; derive ranked hits and
   `validIds` from one filtered set. Existing recall tests must stay green unchanged.
6. `src/evidence/store.ts`: hoist duplicated `activeRun(cwd)` in the add path.
7. `package.json` build script: `bun build --minify`. Verify dist runs (`node dist/index.js
   --version`), `bun run perf` before/after numbers into the commit message.

## Stage 2 — fix(memory): stop silent expiry, honor config, add inspection (A1, A10a, C3, C4)

1. `src/eval/forgetting.ts`: `ageDays` returns `null` on unparseable input (not `Infinity`);
   `actRScore` treats `null` age as "unknown" (score carries recency-neutral weight, never 0
   solely from age) and returns `null` on non-finite inputs; `shouldExpire(score)` gets an
   explicit `unknown: true` path. `src/cli/commands/memory.ts` trace: entries with unknown
   dates are reported (`unparseable_dates`) and never auto-expired.
2. `memory.ts` trace: read `MemoryConfig` from graph.yaml exactly like `recall` does; thread
   `expire_policy`; add `--dry-run` (compute + report, zero writes). Help text: "decay pass —
   writes expiry markers (use --dry-run to preview)".
3. `memory touch` without id → `MISSING_ARG` with a remediation hint.
4. `gk memory list [--json]` over `walkMemoryStore` (id, status, salience, use_count, path;
   human table) and `gk memory show <id>` (prints the file; `MEMORY_NOT_FOUND` + close-match
   ids otherwise). Register both + manifest regen.
5. Tests: unparseable-date no-expiry + report; NaN guards; expire_policy threading (manual →
   no writes); --dry-run writes nothing; list/show envelopes; touch MISSING_ARG.

## Stage 3 — fix(evidence): marker integrity + containment (A2, A3)

1. `src/evidence/marker.ts`: serialize values with safe quoting (reuse `YAML.stringify` for the
   value, or a scalar escaper covering `: `, ` #`, leading indicators, newlines);
   `parseMarker` round-trip test for hostile notes (colon, newline, hash, unicode, empty).
2. `src/evidence/report.ts`: `artifactAbs` resolves and must stay inside `evidenceDir`
   (reject absolute, `..`-escape, symlink-escape via resolved prefix), else skip with a
   `skipped_artifacts` note in the report rather than embedding.
3. Tests: traversal attempts (`../../../.ssh/id_rsa`, absolute path) are excluded; legit
   artifacts still embed.

## Stage 4 — fix(run): race, traversal, honest coverage, the missing front door (A4, A5, C1, C2)

1. `src/memory/ledger.ts` `startRun`: exclusive-create the leaf dir (parent recursive, leaf
   plain `mkdirSync`, catch EEXIST → bump suffix); test: pre-create the first candidate dir,
   start must land on `-2` (or timestamped next) and succeed.
2. `src/memory/resume.ts`: evidence keys from trace lines pass `isValidEvidenceKey`; invalid →
   unsatisfied (counted in the resume report), never joined into a path.
3. `src/cli/commands/status.ts`: coverage graph = `activeRunGraph(cwd) ?? cwd/graph.yaml`;
   test with an active run whose meta.graph_path points at a shrunk session graph.
4. `gk run list [--json]`: merge `readRunIndex()` with `listRunIds()` (dir-only runs flagged
   `interrupted`), newest first, columns id/graph/started/round/status; `gk run status
   <run-id>` renders any run (index + trace + evidence), bare `gk run status` unchanged.
   Register + manifest regen + harness tests.

## Stage 5 — fix(cli)+feat: template tolerance, YAML_INVALID, completions, help examples, human outputs (A6, A7, A8, A10b, D1–D4)

1. `template.ts` list: per-file try/catch → `skipped` warned like `graph list`; human table
   with the `origin` column (project|global|gallery); show/materialize unknown id →
   `TEMPLATE_NOT_FOUND` + close matches; group help derives subcommands from the registry
   (kills phantom `close`).
2. `loader.ts`: wrap YAML parse errors → `GraphKitError("YAML_INVALID", {file, line, col,
   hint})`; add catalog entry in `docs/error-codes.md`; `validate`/`gate` human mode renders
   findings as an indented list (`file:line — message` when available).
3. `src/cli/commands/completions.ts`: `gk completions [bash|zsh|fish]` generated from
   `CLI_COMMANDS`; register + registry entry + manifest regen; prints install hint; harness
   tests (script contains every command word and flag).
4. Leaf-command `.example()` lines: init/validate/compile/gate/status/doctor/inventory/suggest/new.
5. Human one-liners for `run start/node/end`, `memory consolidate`, `evidence report` (path +
   counts in human mode); `--json` untouched.
6. `models.ts`: corrupt overrides → warn + refuse `set` without `--force`; `atomicWrite`;
   `MAP_INVALID` code.

## Stage 6 — feat(kits): CBM degradation guidance (C5)

One line in each target's graph-dependent agents (`kits/{claude,cursor,codex,pi,opencode}/…`):
"on `CBM_UNAVAILABLE`, fall back to Grep/Glob and state the bridge is unavailable." Check kit
parity tests (kits/ ↔ .claude/templates byte-identity) and update both sides as needed.

## Stage 7 — refactor: one wave computation, cleaner boundaries (E1–E6)

1. `src/compiler/waves.ts`: `computeWaves(nodes: Graph["nodes"]) → { waves: string[][],
   unresolved: string[] }` (Kahn). Consumers: `graph.ts` waves (WAVES_INCOMPLETE on
   `unresolved.length`), `validate.ts` loop span, `ascii.ts` levels.
2. `deriveRound(trace)` into `src/memory/ledger.ts`; run.ts + status.ts use it.
3. `src/frontmatter.ts` move (update 7 import sites, no shim); compiler imports point down again.
4. `template.schema.ts`: `GraphSchema.parse` post-substitution → `TEMPLATE_MATERIALIZED_INVALID`.
5. Drop `graph.ts` `loadGraph` re-export; status/doctor/evidence/gate import the loader;
   fix `ascii.ts` dead conditional; deprecation note on `on_fanout_dispatch`.
6. Migrate 16 `runCli` test files to `tests/helpers/cli-harness.ts`; pin waves-test cwds.
7. Acceptance test: materialize → list → switch → show → waves → compile.

## Stage 8 — docs: drift sweep + backlog + changelog

CONTRIBUTING repo map + env-var table; README template-list/eval:memory/CLI-reference fixes;
`docs/error-codes.md` new codes (YAML_INVALID, MAP_INVALID, TEMPLATE_MATERIALIZED_INVALID if
not already); `idea-backlog.md` round-4 status (shipped list, deferred list with reasons);
CHANGELOG Unreleased entries per Keep-a-Changelog; `bun run check-changelog` green.

## Verification

- `bun test` after each stage; `bun run ci:local` once before push.
- `bun run perf` before/after numbers in the perf commit message.
- `gk completions zsh | head`, `gk template list`, `gk run list`, `gk memory list` smoke-tested
  by hand against a scratch fixture dir.
