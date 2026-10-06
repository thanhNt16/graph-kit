# P3 Memory Shrink + Dead Weight — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete the two dead surfaces the audit proved are weight — the CBM bridge (6 commands that hard-fail `CBM_UNAVAILABLE` on every install; the codebase-memory MCP already provides the integration) and the compile/workflow.js runtime (a second execution story no shipped prose uses) — fix the consolidate merge-retain bug (reinforcement state wiped every run, MEM F3), and shrink the memory layer per spec (PPR link join, evidence-co-occurrence patterns out).

**Architecture:** `src/cbm/` + `src/cli/cbm-seam.ts` deleted whole; `graph index|search|ask|trace|query` + `memory index` commands removed; `src/compiler/{emitter,resolver}.ts` + `gk compile` + `kits/claude/skills/{gk-compile,gk-run}` + `memory-augmented.workflow.js` + `workflowTool` target flag deleted; `planGraph`/`src/exec` is the only execution path. Memory: consolidate writes `index.md` merge-retaining prior `use_count`/`last_used_at`/`expired`/`created_at`; `explain-recall` PPR link join + `patterns` `evidence-cooccurrence` gone.

**Tech Stack:** TS + bun; existing `tests/unit/*` conventions.

**Spec:** `docs/superpowers/specs/2026-10-06-rearchitecture-design.md` §5 P3 + §7 kill list. **Audit:** CONSOLIDATED.md — H28/MEM F4 (cbm dead-on-install), M26/EXT F4 (compile carriers), MEM F3 (consolidate wipes reinforcement), H27 (ACT-R falsified in documented flow). **Prereq:** P0+P1+P2 landed at 354066c.

## Global Constraints

- Repo: `/Users/harry/Desktop/personal/graph-kit`, TS + bun. Test: `bun test tests/unit/<file>`; converge `bun run typecheck`. NEVER run lint/format/full suite per task.
- Deletes dominate — every removal grep-sweeps its full blast radius (src/ + kits/ + tests/ + scripts/ + docs/superpowers/specs+plans).
- Commit per task; no docs/superpowers/, .tmp-*, .superpowers/.
- `gk run`/`gk exec`/`gk-execute` skill are the surviving runtimes — every deleted path must be proved unreachable or its callers migrated before delete.

## File map

- Delete: `src/cbm/` (client/contract/index/route — 426 LOC), `src/cli/cbm-seam.ts`, `src/compiler/emitter.ts`, `src/compiler/resolver.ts`, `kits/claude/skills/gk-compile/`, `kits/claude/skills/gk-run/` (workflow-tool version — audit M26; check if pi kit has a non-workflow gk-run before deleting wholesale), `kits/claude/templates/memory-augmented.workflow.js`.
- Modify: `src/cli/commands/graph.ts` (remove index/search/ask/trace/query/compile verbs + cbmCall/cbmFailure/routeAndRetrieve), `src/cli/commands/memory.ts` (remove index + decay/reinforcement block M17?), `src/targets/{types,registry}.ts` (workflowTool flag), `src/memory/consolidate.ts` (merge-retain), `src/memory/explain-recall.ts` (PPR out), `src/memory/patterns.ts` (co-occurrence out), `src/memory/recall-expanded.ts` (PPR references), kit prose referencing compile/workflow/cbm, `cli-manifest.json` regen.
- Tests: delete `tests/unit/resolver.test.ts`, cbm-seam users, compile-path tests; rewrite consolidate/patterns/explain-recall tests to the shrunk contract.

---

### Task 1: Kill the CBM bridge

**Files:**
- Delete: `src/cbm/` (4 files), `src/cli/cbm-seam.ts`
- Modify: `src/cli/commands/graph.ts` (lines ~5-7, 29-40 cbm imports/helpers; verb blocks ~860-900 index/search/ask/trace/query — read the actual ranges), `src/cli/commands/memory.ts` (index verb + cbm usage), `cli-manifest.json` regen, any tests importing cbm-seam or asserting CBM_UNAVAILABLE
- Test: delete cbm-seam consumers; re-run `tests/unit/graph-commands.test.ts` + cli-trust

**Interfaces:**
- Removes: `graph index|search|ask|trace|query`, `memory index`, `CbmClient`, `routeAndRetrieve`, `indexProject`, `cbmCall`, `cbmFailure`, `setCbmSeam`/`resetCbmSeam`, `.last-index` handling.

- [ ] **Step 1: Map the blast radius** — `grep -rn "cbm\|CbmClient\|routeAndRetrieve\|indexProject\|CBM_UNAVAILABLE\|cbm-seam\|\.last-index" src/ tests/ kits/ scripts/`; list every file + the exact blocks (imports, helpers, verb registrations, test cases, kit prose). Confirm nothing else calls the bridge (e.g. `gk ask`'s CBM half vs its memory half — `ask` must survive for memory recall per spec §351; check whether `gk ask` exists and what it routes).

- [ ] **Step 2: Delete + migrate** — remove the cbm files + every verb/helper/test importing them; `memory index` goes (the spec keeps memory-store rebuild inside consolidate or drops the verb — decide per what the code shows: if `memory index` rebuilds the memory store index.md keep that function under consolidate, else delete). Regen `cli-manifest.json`.

- [ ] **Step 3: Verify** — `bun test tests/unit/graph-commands.test.ts tests/unit/cli-trust.test.ts tests/unit/memory-*.test.ts && bun run typecheck && bun run check-cli-parity` → PASS; `gk graph --help` shows no cbm verbs.

- [ ] **Step 4: Commit** — `feat(cli): remove dead CBM bridge — 6 always-fail commands, external MCP is the integration`

---

### Task 2: Kill the compile/workflow.js runtime

**Files:**
- Delete: `src/compiler/emitter.ts`, `src/compiler/resolver.ts`, `kits/claude/skills/gk-compile/`, `kits/claude/skills/gk-run/` (verify pi kit lacks gk-run first — if it has one, check whether it's workflow-flavored or ledger-flavored; delete only the workflow-tool version, keep/repoint a ledger one), `kits/claude/templates/memory-augmented.workflow.js`, `tests/unit/resolver.test.ts`, compile-path tests
- Modify: `src/cli/commands/graph.ts` (compile verb :645-660 + compileGraph import + templatesDir), `src/targets/{types,registry}.ts` (`execution.workflowTool` flag + claude registry entry), kit prose (`gk-visualize`, `doc-sync`, `release-manager`, `migration-planner` compile refs), `tests/integration/full-flow.test.ts`, `tests/acceptance/acceptance.test.ts` if compile-path
- Test: delete emitter/resolver tests; re-run graph-commands + cli-trust + pi-kit + kit-skill-parity

**Interfaces:**
- Removes: `gk compile`, `compileGraph`, `resolveGraph`-via-emitter (check resolver.ts exports — if `resolveGraph` from P0's graph-resolve is different, keep it; the compiler/resolver is the OLD graph-input resolver — verify which is live before deleting), `workflowTool` target field, the claude-only workflow skills + template.

- [ ] **Step 1: Prove reachability** — `grep -rn "compileGraph\|compiler/emitter\|compiler/resolver\|workflowTool\|workflow\.js\|gk-compile" src/ kits/ tests/`; confirm `src/compiler/resolver.ts` is NOT the P0 `src/cli/graph-resolve.ts` (they coexist — resolver.ts is the compile-path resolver); list every surviving consumer.

- [ ] **Step 2: Delete** — the files + verbs + flag + kit entries; `workflowTool` out of `TargetSpec.execution` + registry rows; kit prose scrub (any `gk compile` / `.workflow.js` / `gk-run` workflow-tool prose); `gk-run` pi/claude variants — if claude's is the workflow-tool one, it dies; check pi for a ledger-driven gk-run first.

- [ ] **Step 3: Verify** — `bun test tests/unit/graph-commands.test.ts tests/unit/cli-trust.test.ts tests/unit/pi-kit.test.ts tests/unit/kit-skill-parity.test.ts && bun run typecheck && bun run check-cli-parity && bun run scripts/gen-kits.ts --check` → PASS.

- [ ] **Step 4: Commit** — `feat(cli): remove compile/workflow.js runtime — planGraph+exec is the only execution path`

---

### Task 3: Consolidate merge-retain fix (MEM F3)

**Files:**
- Modify: `src/memory/consolidate.ts` (:128-187 — re-consolidation wipes use_count/last_used_at, resurrects expired, resets created_at)
- Test: `tests/unit/memory-consolidate.test.ts` or wherever consolidate tests live

**Interfaces:**
- Consumes: existing memory frontmatter (`.graphkit/memory/*.md`) + previous index.
- Produces: re-consolidation MERGES — preserved `use_count`/`last_used_at`/`expired`/`created_at` per memory id, fresh counts added; no resurrection of expired entries; created_at survives re-consolidation.

- [ ] **Step 1: Write the failing test** — consolidate → touch/reinforce a memory → consolidate again → use_count/last_used_at/expired/created_at all preserved (pre-fix they're wiped).

- [ ] **Step 2: Run to verify fail.**

- [ ] **Step 3: Implement** — consolidate reads the previous index/frontmatter and merges counters instead of rewriting from scratch.

- [ ] **Step 4: Verify** — `bun test tests/unit/memory-consolidate.test.ts tests/unit/memory-pipeline.test.ts && bun run typecheck` → PASS.

- [ ] **Step 5: Commit** — `fix(memory): consolidate merge-retains reinforcement state — use_count/expired/created_at survive`

---

### Task 4: Memory shrink — PPR + co-occurrence out

**Files:**
- Modify: `src/memory/explain-recall.ts` (PPR_DAMPING/ITERATIONS + link join :47+), `src/memory/patterns.ts` (`evidence-cooccurrence` pattern kind + the cooccur map :87-131), `src/memory/recall-expanded.ts` (PPR-weighted score comment/field :10), `src/schemas/memory.schema.ts` if the pattern kind is in the enum
- Test: `tests/unit/patterns.test.ts`, explain-recall tests, recall tests

**Interfaces:**
- Removes: the PPR link-join pass in explain (reinforced/linked neighbors still surface — only the PPR weighting dies per spec "kill PPR links"), `evidence-cooccurrence` from pattern kinds (the others stay — check the enum), the `Final (PPR-weighted) score` field/relabeling in recall-expanded.

- [ ] **Step 1: Write the failing test** — patterns emitted for a run with co-occurring evidence keys → no `evidence-cooccurrence` kind; explain output has no PPR-weighted score.

- [ ] **Step 2: Run to verify fail.**

- [ ] **Step 3: Delete** — PPR block, cooccur map + kind, the score field/comment.

- [ ] **Step 4: Verify** — `bun test tests/unit/patterns.test.ts tests/unit/memory-*.test.ts && bun run typecheck` → PASS.

- [ ] **Step 5: Commit** — `refactor(memory): drop PPR link join + evidence-cooccurrence patterns — spec shrink`

---

### Task 5: Final dead-weight sweep + docs

**Files:**
- Modify: `cli-manifest.json` regen, `CHANGELOG.md` (all four kills + the fix), `docs/superpowers/specs/2026-10-06-rearchitecture-design.md` §7 kill-list checkmarks or a note, any surviving kit/doc references (`gk-slp-usage.html` — park or retire per deferred list)
- Test: full `ci:local`

**Interfaces:**
- Produces: zero grep hits for `cbm|CbmClient|compileGraph|compiler/emitter|compiler/resolver|workflowTool|workflow\.js|CBM_UNAVAILABLE|\.last-index|evidence-cooccurrence|PPR` across src/ + kits/ (spec comments can name them as "killed" only).

- [ ] **Step 1: Sweep** — the grep above; kill every residual reference incl. `docs/gk-slp-usage.html` (retire or rewrite — it's a doc lie now), `kits/claude/skills/gk-run` remnants, `docs/graphkit.html` compile/workflow refs.

- [ ] **Step 2: Changelog** — entries for all kills + consolidate fix.

- [ ] **Step 3: Verify** — `bun run ci:local` → full PASS.

- [ ] **Step 4: Commit** — `docs: changelog for P3 memory shrink + dead-weight removal`

---

## Self-review

- **P3 spec coverage:** cbm killed ✓ · compile killed ✓ · `.index` already gone (P1) ✓ · PPR/co-occurrence killed ✓ · ledger→src/runs done (P1) ✓ · consolidate merge-retain ✓ · pi+claude kits (P0) ✓.
- **Ordering:** T1+T2 file-disjoint (different modules, different verbs) → parallel. T3+T4 memory-layer, file-disjoint from each other → parallel. T5 sweep last.
- **Type consistency:** deletes only; the one fix (consolidate) changes merge semantics not signatures.
- **Riskiest seam:** `gk ask` — spec keeps it for memory recall but kills the CBM half; T1 must read its implementation before deleting (don't delete the memory-recall path).
- **Scope honesty:** the spec's wider §92 kill list (suggest/run analyze/evidence report verbs, template fold, `--json` flags, `models×5`, init-vs-new) is the CLI-surface redesign — bigger than P3's named line; P3 lands the named items, the rest goes in the deferred list below.

## Deferred out of P3 (tracked — do not lose)

- **CLI surface redesign** (spec §4, 56→~11 verbs): `suggest`/`run analyze`/`evidence report`/`memory trace|touch` as verbs, `graph show` → `draw` rename, `template list/show/pack` → `new` fold, `init` vs `new` dedup, `models×5` leaves, decorative `--json` — a P4-scoped surface pass, not P3's named line.
- **I3 worktree protocol-verification half**, **`--resume` for `gk exec`**, **dual spawn-copy dedupe**, **`fan_out.reduce`/`effort` implementation**, **hooks `.cjs` family**, **judge for `gk exec`**, **`gk run round` interactive wiring** — all carried from P1/P2 deferred lists (see `docs/superpowers/plans/2026-10-07-p2-exec-engine.md` §Deferred).
- **`docs/gk-slp-usage.html`** — doc lie vs P2's engine; retire-or-rewrite goes here if T5 doesn't catch it.
