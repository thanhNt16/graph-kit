# Improvement Round 3 — Implementation Plan

**Design:** `docs/superpowers/specs/2026-09-10-improvement-round-3-design.md`
**Branch:** `improvement/efficiency-quality-round3` (off `improvement/efficiency-quality-round2`)
**Gate:** `bun run ci:local` after each batch; `bun test` between adjacent items in a batch.

Execution order minimizes file-conflict churn (sequential, single implementer). Each item lists its
constraint tests.

## Batch 1 — Workstream A: honesty/correctness bugs

- [ ] A1 honest CBM_UNAVAILABLE in ask/templates — `src/cbm/client.ts` (typed error + predicate),
      `src/cbm/route.ts` (3 sites), `src/cbm/templates.ts` (4 sites). Tests: route rethrows fatal,
      healthy path unchanged (`route.test.ts`, `graph-cbm-commands.test.ts`); new e2e-style test with
      failing CBM_CMD stub.
- [ ] A2 linked-recall filters + malformed count — `src/memory/recall-expanded.ts`
      (filter neighbors, count malformed), `src/cli/commands/memory.ts` (envelope),
      `kits/claude/skills/gk-recall/SKILL.md` (drop `as_of` claim). Tests: expired/superseded neighbor
      never surfaces (`recall-expanded.test.ts`, `waves-memory.test.ts`).
- [ ] A3 evidence-key containment — `src/evidence/store.ts` (basename check in addEvidence),
      `src/compiler/validate.ts` (node-evidence rule). Tests: traversal keys fail clean
      (`evidence-store.test.ts`, `validate.test.ts`).
- [ ] A4 status reads ledger — `src/cli/commands/status.ts` via `activeRun`/`readRunMeta`; round from
      sidecar, fallback trace-derived. Tests: `cli-status-commands.test.ts` (update sidecar-only case).
- [ ] A5 decay walks subfolders — `src/cli/commands/memory.ts` traceMemory → walkMemoryStore.
      Tests: pattern file decays (`memory-trace.test.ts`, `ledger-consolidate.test.ts` counts).
- [ ] A6 route lexicon — `src/cbm/route.ts` stem allowlist + rule order. Tests: `route.test.ts`
      additions ("implementation detail", "how do I find where X is defined").
- [ ] A7 resume shape validation — `src/memory/ledger.ts` (parseTraceLine guard, skipped count,
      RUN_META_CORRUPT), `src/memory/resume.ts` (skipped_trace_lines). Tests: `run-resume.test.ts`.
- [ ] A8 atomicWrite envelope — `src/fs.ts`. Tests: `fs-atomic.test.ts` (write-fail → WRITE_FAILED, no tmp).
- [ ] A9 pointer/ledger races — `src/memory/ledger.ts` endRun identity re-check; `src/store/index.ts`
      atomicWrite + corrupt-pointer error. Tests: `run-ledger.test.ts`, `graph-store.test.ts`.

## Batch 2 — Workstream B: error-contract & parsing unification

- [ ] B1 shared splitFrontmatter — export from `src/memory/frontmatter.ts` (CRLF-tolerant), re-point
      `src/cli/commands/inventory.ts`, `src/compiler/validate.ts` (criteria try/catch → finding),
      `src/evidence/marker.ts`. Tests: CRLF parse pins (`memory-frontmatter.test.ts`, `marker.test.ts`,
      `validate.test.ts` corrupt-criteria case).
- [ ] B2 GraphKitError finishes — `inventory.ts` BAD_TARGET typed, `template.schema.ts` PARAM_INVALID at
      source, `client.ts` typed failure + `toCbmFailure` used by `graph.ts`/`memory.ts`, template-name
      message from `TEMPLATE_NAME_RE.source`. Codes/messages byte-identical.
- [ ] B3 loadGraph reuse — `run.ts`, `resume.ts`; update pinned codes in `run-cli.test.ts`,
      `run-resume.test.ts`.
- [ ] B4 validate.ts cast removal — `role`/`eval`/`topology_config` already typed.
- [ ] B5 reinforceEntry — `src/cli/commands/memory.ts` shared helper; single cast inside.

## Batch 3 — Workstream C: memory/consolidate perf

- [ ] C1 id→doc Map in expandedRecall (`recall-expanded.test.ts` pins ordering).
- [ ] C2 buildLinks push + compact write (`links.test.ts` round-trip).
- [ ] C3 consolidate skip-identical writes + buildLinks pre-parsed entries
      (`ledger-consolidate.test.ts`; dismissal path untouched).
- [ ] C4 perf harness real shapes (`scripts/perf-runtime.ts`; informational).

## Batch 4 — Workstream D: CLI DX

- [ ] D1 gate BLOCK human table (`gate.ts`; `--json` unchanged; `cli-gate.test.ts` updates).
- [ ] D2 unknown command/flag one-liners (`src/index.ts`, edit-distance over CLI_COMMANDS;
      `cli-e2e-commands.test.ts` additions).
- [ ] D3 remediation strings + hints-resolve test (`graph.ts`, `kit.ts`, `memory.ts`, `inventory.ts`).
- [ ] D4 group --help subcommands (6 groups; parity greps still pass).
- [ ] D5 scripts/install.sh + README Install shrink (shellcheck-style review; manual fallback kept).
- [ ] D6 docs/error-codes.md from central table in `src/errors.ts`; README polish (empty `## Boundary`,
      version-in-help copy).

## Batch 5 — Workstream E: tests, gates, docs hygiene

- [ ] E1 memory CLI error envelopes (`memory-cli-errors.test.ts` via new harness).
- [ ] E2 eval:memory into ci:local + cbm-parity-gate.test executes SKIP path; README/CONTRIBUTING.
- [ ] E3 untrack tests/unit/.tmp-resolver; tests/helpers/cli-harness.ts; migrate resolver + new tests.
- [ ] E4 cbm/index.ts wire-shape test + ask snippets test + template SOURCE_INVALID tests.
- [ ] E5 CHANGELOG [Unreleased] entries (Added/Fixed/Changed per convention), idea-backlog.md round-3
      status + deferred list (recall index, lazy bundle, R8 phases 1+, E1–E5, coverage gate, completions,
      central human fail renderer, waves extraction), README dev-section wording.

## Final

- [ ] `bun run ci:local` green; `bun run perf` before/after table captured for the PR body.
- [ ] Commit per batch (conventional commits); push; PR → base `improvement/efficiency-quality-round2`
      with full change list.
