# P1 Event Store + Planner IR — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give run state one module and one write protocol — extract the planner IR out of the CLI god-file, move ledger out of `src/memory/` into `src/runs/`, turn `land` into an append-only event (killing the proven read-modify-write race), and delete the write-only `.index` evidence log.

**Architecture:** `src/runs/` owns all run lifecycle state (ledger, resume, rounds, analyze). `src/compiler/plan.ts` owns `planGraph()` — the wave planner + curator interleave + `topology_config` — consumed as the IR by `graph waves`, `graph agents`, `ascii`, `svg`, gate coverage, and (in P2) the exec engine. Event write-path: `land` becomes an append line in `trace.jsonl`, not a read-modify-write — the event store is the JSONL log already on disk, this task makes every mutation append-only.

**Tech Stack:** TS + bun, existing `tests/unit/*` conventions.

**Spec:** `docs/superpowers/specs/2026-10-06-rearchitecture-design.md` §5 P1. **Audit:** CONSOLIDATED.md — EL F1 (land RMW lost-update), EL F2/ES E5 (.index write-only), CS#3/#4/#13 (planner in CLI), MEM split (src/memory = two subsystems), CLI F1 + T6 follow-up (current.json ghost already gone in P0 — the hooks `.cjs` reference is a deferred ticket).

## Global Constraints

- Repo: `/Users/harry/Desktop/personal/graph-kit`, TS + bun. Test: `bun test tests/unit/<file>`; converge `bun run typecheck`. NEVER run lint/format/full suite per task.
- GraphKitError (src/errors.ts) + diagnostics.ts (formatZodIssues, toGraphKitError) + graph-resolve.ts (resolveGraph/resolveGraphPath) from P0 — reuse, never re-implement.
- Commit per task; no docs/superpowers/, .tmp-*, .superpowers/.
- `land` append-event must keep the trace readable by the same tolerant JSONL readers; downstream consumers (gate require_landed, resume) read `landed` lines — the event is additive, the trace shape gains one `status` variant.

## File map

- Create `src/runs/{index,ledger,resume,loops,analyze}.ts` (moved from `src/memory/`) — `src/memory/` keeps only the knowledge-store files (store, consolidate, patterns, links, suggest, recall, explain, render).
- Create `src/compiler/plan.ts` — `planGraph(graph, opts)` returning waves + curator interleave + node payloads + `topology_config`.
- Modify `src/cli/commands/graph.ts` (waves/agents/ascii/svg consume planGraph; inline planner at :821-963 removed), `src/cli/node-agents.ts` (consumes planGraph), `src/evidence/store.ts` (.index append removed), `src/memory/ledger.ts` (landNode → append).
- Update every `import ... from "../../memory/ledger.js"` / `../memory/ledger.js` to `../../runs/ledger.js` etc.
- Tests: `tests/unit/run-ledger.test.ts`, `run-cli.test.ts`, `run-resume.test.ts`, `run-ledger-guards.test.ts`, `loops.test.ts`, `cli-status-commands.test.ts`, `gate*.test.ts`, `evidence-cli.test.ts`, `compiler.test.ts` + new `tests/unit/plan-graph.test.ts`.

---

### Task 1: `src/runs/` module split

**Files:**
- Create: `src/runs/` — move `src/memory/{ledger,resume,loops,analyze}.ts` verbatim; re-export nothing (clean move).
- Modify: every importer (`grep -rn "from \".*memory/ledger\|memory/resume\|memory/loops\|memory/analyze\"" src/ tests/` for the full list — includes run.ts, gate.ts, evidence.ts, memory.ts, status.ts, graph.ts, node-agents.ts, consolidate.ts, suggest.ts, patterns.ts).
- Test: `tests/unit/run-ledger.test.ts` etc. (import-path updates only — no behavior change)

**Interfaces:**
- Consumes: the four modules as-is.
- Produces: same exports at new paths; `src/memory/` = knowledge store only (audit MEM split).

- [ ] **Step 1: Move + fix imports.** `git mv src/memory/ledger.ts src/runs/ledger.ts` (same for resume/loops/analyze). Update every importer. Re-run `tsc` — no implicit-any or path misses.

- [ ] **Step 2: Verify** — `bun test tests/unit/run-ledger.test.ts tests/unit/run-resume.test.ts tests/unit/loops.test.ts tests/unit/run-cli.test.ts && bun run typecheck` → PASS.

- [ ] **Step 3: Commit** — `refactor(runs): move run-ledger/resume/loops/analyze out of src/memory — memory keeps only the knowledge store`

---

### Task 2: `land` = append event (kill the lost-update race)

**Files:**
- Modify: `src/runs/ledger.ts` (`landNode` :263-287 — currently read-modify-write of trace.jsonl; audit EL F1 proved it loses concurrent appends), `src/cli/commands/run.ts` (land action), any reader of the land marker
- Test: `tests/unit/run-ledger.test.ts`, `tests/unit/gate.test.ts` (require_landed consumers)

**Interfaces:**
- Consumes: `TraceLine` gains `status: "landed"` variant; `landNode` signature unchanged `(cwd, node, commit, now)`.
- Produces: `landNode` APPENDS `{node, status:"landed", commit, at}` to trace.jsonl (same format, new line — no file rewrite). Readers that check "is landed" scan for the landed line; gate's require_landed reads latest landed line per node. The RMW path is deleted.

- [ ] **Step 1: Write the failing test** — `run-ledger.test.ts`: interleave `appendNode` + `landNode` under simulated concurrency (or sequential interleave proving the RMW dropped a line): appendNode(a) → landNode(a,c) → appendNode(b) → all 3 lines present + gate require_landed sees landed.

- [ ] **Step 2: Run to verify fail.**

- [ ] **Step 3: Implement** — landNode appends; remove the read-trace/rewrite block; readers (`run node` output, gate require_landed, resume) treat `landed` as a node-status variant.

- [ ] **Step 4: Verify** — `bun test tests/unit/run-ledger.test.ts tests/unit/run-cli.test.ts tests/unit/gate.test.ts tests/unit/gate-freshness.test.ts && bun run typecheck` → PASS.

- [ ] **Step 5: Commit** — `fix(ledger): land as append-only event — kills the read-modify-write lost-update race`

---

### Task 3: Planner IR — `planGraph()` in compiler/

**Files:**
- Create: `src/compiler/plan.ts`
- Modify: `src/cli/commands/graph.ts:821-963` (inline wave planner + curator interleave), `src/cli/node-agents.ts` (wave node payloads), `src/compiler/emitter.ts`/`resolver.ts` if they consume wave logic, `src/schemas/topology/*` (topology_config flows through the plan)
- Test: `tests/unit/compiler.test.ts` + new `tests/unit/plan-graph.test.ts`

**Interfaces:**
- Consumes: `Graph`, `topoWaves` (moves from cli/ to compiler/), `memory cadence config` if read for curator interleave.
- Produces:
  ```ts
  export interface PlannedNode { id, wave, agent, objective, model?, tools?, when?, gate?, fan_out?, loop?, retry?, advisor?, timeout_ms?, effort?, constraints?, owns?, evidence_keys? }
  export interface PlanWave { index: number; nodes: PlannedNode[]; curator?: boolean }
  export interface PlanGraph { waves: PlanWave[]; topology_config?: Record<string, unknown>; warnings: string[] }
  export function planGraph(graph: Graph, opts?: { cwd?: string }): PlanGraph
  ```
  Everything the inline planner produced at graph.ts:821-963 now flows from this one function; `topology_config` rides the payload (fixes audit CS#4 — was dropped). `topoWaves` moves into `src/compiler/` (it was mis-homed under cli/ — CS#8).

- [ ] **Step 1: Write the failing test** — `plan-graph.test.ts`: diamond graph → waves [[0],[1,2],[3]]; memory-augmented graph → curator interleave; a `topology:` graph → `topology_config` present in the plan payload; node orchestration fields verbatim.

- [ ] **Step 2: Run to verify fail.**

- [ ] **Step 3: Extract** — move the inline planner + curator interleave + topoWaves into `src/compiler/plan.ts`; graph.ts waves/agents/ascii/svg + node-agents consume `planGraph`; graph.ts keeps only the CLI action wrappers.

- [ ] **Step 4: Verify** — `bun test tests/unit/plan-graph.test.ts tests/unit/compiler.test.ts tests/unit/cli-trust.test.ts tests/unit/graph-waves*.test.ts && bun run typecheck` → PASS. Golden waves tests must pass unchanged (identical output = no behavioral drift).

- [ ] **Step 5: Commit** — `refactor(compiler): planGraph() IR — waves/curator/topology_config out of cli/, consumed by all graph views`

---

### Task 4: Delete `.index` write-only evidence log + ghost `run.md` duplications

**Files:**
- Modify: `src/evidence/store.ts` (remove `.index` append — audit EL F2: write-only, dual-schema, zero readers), `src/evidence/report.ts` (confirm no reader), `src/memory/consolidate.ts` if it touched `.index`, `kits/_core/skills/gk-evidence/SKILL.md` + `gk-status` prose (they tell agents to read `.index`/`current.json` — doc lies)
- Test: `tests/unit/evidence-cli.test.ts`

**Interfaces:**
- Produces: `.graphkit/evidence/.index` file stops being written; marker `.md` files remain the single evidence record; skills no longer reference `.index`.

- [ ] **Step 1: Write the failing test** — `evidence-cli.test.ts`: `evidence add` → `existsSync(.index)` is false; `evidence report` still works (reads .md markers only).

- [ ] **Step 2: Run to verify fail.**

- [ ] **Step 3: Remove** — the `.index` append block + type; grep `\.index` across src/ and kits/_core/skills/ — delete all producer references and scrub skill-doc mentions.

- [ ] **Step 4: Verify** — `bun test tests/unit/evidence-cli.test.ts tests/unit/gate-freshness.test.ts && bun run typecheck && bun run scripts/gen-kits.ts --check` → PASS (regen kits if skill docs changed).

- [ ] **Step 5: Commit** — `refactor(evidence): delete .index write-only log — marker.md is the single record`

---

## Self-review

- **P1 spec coverage:** ledger+evidence unification = event-append land + module split + .index removal (the audit's concrete wins, not a full store rewrite — one typed event log is what P2's exec engine consumes; P1 sets the floor) ✓ · planGraph extraction ✓ · current.json gone ✓ (P0 T6 landed it; the lease-enforce.cjs hook ticket is parked in the ledger, not this plan).
- **Order:** T1 (move) → T2 (land append, needs moved ledger) → T3 (planner, independent) → T4 (.index, independent). Dispatch T1 first; T3/T4 can overlap T2 after T1.
- **Type consistency:** `PlanWave`/`PlannedNode`/`PlanGraph`, `landed` status variant, `src/runs/` paths consistent.
