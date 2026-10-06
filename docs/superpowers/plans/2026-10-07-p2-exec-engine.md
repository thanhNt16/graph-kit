# P2 Exec Engine — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One exec engine in `src/exec/` that consumes `planGraph()` and drives a run deterministically — wave iteration, wave barrier, dispatch, ledger writes, retry/backoff, timeout, evidence stamp, run verdict — with a `Runner` seam so the **interactive path** (host agent dispatches via the native `task` tool, skill = thin adapter) and the **headless path** (`gk exec` — CLI spawns `omp -p` children, reuses `gk_dispatch_agent`'s `dispatch()`) share the same engine.

**Architecture:** `src/exec/engine.ts` takes a `PlanGraph` + `Runner` and returns a `RunVerdict`; every ledger write goes through `src/runs/ledger.ts`. The skill `gk-execute` shrinks to an adapter: reads the engine's next-wave spec, dispatches each node via `task()`, feeds results back — it keeps only judgment (CHALLENGE verdicts, gate suspension, worktree-vs-same-tree escalation, memory curator interpretation). The headless `gk exec` command uses the same engine with a `childProcess` Runner (port `gk_dispatch_agent`'s `dispatch()` into `src/exec/spawn.ts`, extension becomes a thin caller).

**Tech Stack:** TS + bun; existing `tests/unit/*` conventions.

**Spec:** `docs/superpowers/specs/2026-10-06-rearchitecture-design.md` §5 P2. **Audit:** CONSOLIDATED.md — CS#1/#2/#5/#6 (two executors → one; execution boundary), KIT#4 (interactive vs headless), EX F1 (silent agent-drop). **Prereq:** P0 (resolver/envelope/validate-start), P1 (planGraph IR, land-append, src/runs/) — landed at 4ae5dfe.

## Global Constraints

- Repo: `/Users/harry/Desktop/personal/graph-kit`, TS + bun. Test: `bun test tests/unit/<file>`; converge `bun run typecheck`. NEVER run lint/format/full suite per task.
- Reuse P0/P1 primitives: `planGraph` (src/compiler/plan.ts), `resolveGraphPath`, `GraphKitError`, `startRun/appendNode/appendDispatch/readTrace/endRun` (src/runs/ledger.ts), `addEvidence` (evidence/stamp via `gk evidence add`).
- Commit per task; no docs/superpowers/, .tmp-*, .superpowers/.
- The engine is the single source of deterministic orchestration truth — the skill never re-implements wave order/retry/backoff; it renders the engine's outputs.

## File map

- Create `src/exec/{engine,types,spawn,runner}.ts`.
- Modify `src/index.ts` (`gk exec` verb), `src/cli/commands/run.ts` if shared verbs, `kits/_core/extensions/gk-subagent.ts` (thin caller of `src/exec/spawn`), `kits/_core/skills/gk-execute/SKILL.md` (adapter rewrite).
- Tests: new `tests/unit/exec-engine.test.ts`, `exec-runner.test.ts`, `exec-spawn.test.ts`, `exec-cli.test.ts` + existing `gk-subagent`/hooks tests re-pointed.

---

### Task 1: Engine types + `Runner` seam

**Files:**
- Create: `src/exec/types.ts` (EngineState, NodeRun, WaveRun, RunVerdict, DispatchOutcome, Runner interface).
- Test: `tests/unit/exec-types.test.ts` (shape + defaults)

**Interfaces:**
- Consumes: `PlanGraph`, `PlannedNode` (src/compiler/plan.ts), `TraceLine`/`LandEvent` (src/runs/ledger.ts), `GraphKitError`.
- Produces:
  ```ts
  export interface Runner { dispatch(node: PlannedNode, ctx: DispatchContext): Promise<DispatchOutcome> }
  export interface DispatchOutcome { ok: boolean; output: string; exitCode: number; durationMs: number; timedOut?: boolean }
  export interface DispatchContext { runId: string; cwd: string; node: PlannedNode; attempt: number; upstream: Map<string, NodeRun> }
  export interface NodeRun { id: string; wave: number; status: "ok"|"fail"|"skipped"|"challenge"|"landed"; outcome?: DispatchOutcome; attempts: number }
  export interface WaveRun { index: number; curator: boolean; nodes: NodeRun[] }
  export interface RunVerdict { status: "merged"|"blocked"|"failed"; runId: string; waves: WaveRun[]; nodes: NodeRun[]; unresolved: string[] }
  ```
  `Runner` is the seam: `taskTool` (interactive — host agent supplies results per node; engine just tracks) vs `childProcess` (headless — engine calls `spawn()` per node). Engine NEVER knows which.

- [ ] **Step 1: Write the failing test** — a stub Runner records dispatches; types carry through.

- [ ] **Step 2: Run to verify fail.**

- [ ] **Step 3: Implement types** (pure — no logic beyond zod-ish shape).

- [ ] **Step 4: Verify** — `bun test tests/unit/exec-types.test.ts && bun run typecheck` → PASS.

- [ ] **Step 5: Commit** — `feat(exec): engine types + Runner seam — interactive and headless share one engine`

---

### Task 2: `src/exec/spawn.ts` — port `gk_dispatch_agent` dispatch() into src/

**Files:**
- Create: `src/exec/spawn.ts` (childProcess Runner's core).
- Modify: `kits/_core/extensions/gk-subagent.ts` (becomes a thin caller — extension imports the shared module via its kit bridge, or duplicates the spawn contract; see plan note)
- Test: `tests/unit/exec-spawn.test.ts`, existing `gk-subagent` tests re-pointed

**Interfaces:**
- Consumes: `DispatchConstraints`, `DispatchArgs`, `DispatchResult` shapes from gk-subagent.ts (verbatim port — timeout_ms, process-group kill, abort signal, recordIntent into dispatch.jsonl).
- Produces: `export async function spawnDispatch(args, signal): Promise<DispatchOutcome>` — the ported `dispatch()`; `recordIntent` moves too (writes dispatch.jsonl via runs/ledger or direct append — same format).

- [ ] **Step 1: Write the failing test** — spawn a `node -e 'console.log("ok")'` via spawnDispatch → `{ok:true, output:"ok"}`; timeout case: `sleep 30` + `timeout_ms: 100` → `{ok:false, timed_out:true}` + dispatch.jsonl intent line.

- [ ] **Step 2: Run to verify fail.**

- [ ] **Step 3: Port** — move `dispatch()` + `buildPiArgs`/`buildPrompt`/`recordIntent`/process-group-kill + `DispatchConstraints/Args/Result` from `kits/_core/extensions/gk-subagent.ts` to `src/exec/spawn.ts`. Extension keeps only the `gkSubagentExtension` pi registration + calls `spawnDispatch` (if the extension can't import src/, keep its copy and mark `spawn.ts` the canonical one for `gk exec` — document the duplication as the P3 cleanup or share via a generated file; choose the less-fragile: share via `kits/_core/extensions/spawn-core.ts` re-export? DECIDE at implement time — extension bridge constraint).

- [ ] **Step 4: Verify** — `bun test tests/unit/exec-spawn.test.ts tests/unit/hooks.test.ts && bun run typecheck` → PASS.

- [ ] **Step 5: Commit** — `refactor(exec): port dispatch() from gk-subagent extension into src/exec/spawn — one spawn contract`

---

### Task 3: `src/exec/engine.ts` — wave loop + ledger + verdict

**Files:**
- Create: `src/exec/engine.ts`
- Modify: `src/runs/ledger.ts` (only if a new trace variant needed — prefer none)
- Test: `tests/unit/exec-engine.test.ts`

**Interfaces:**
- Consumes: `planGraph`, `Runner`, `startRun/appendNode/appendDispatch/landNode/endRun/readTrace/activeRun`, `addEvidence` (via shell `gk evidence add` for the stamp path — engine emits `evidence add` calls per declared key after node ok).
- Produces:
  ```ts
  export async function runGraph(plan: PlanGraph, opts: { cwd; runner: Runner; runId?: string; interactive?: InteractiveHooks }): Promise<RunVerdict>
  export interface InteractiveHooks {
    onWaveStart(w: PlanWave): void; onNodeResult(n: NodeRun): void
    askGate?(node: PlannedNode, gate): Promise<boolean>  // suspends for user; undefined = auto-skip gate (headless) or adapter-provided (interactive)
    askChallenge?(finding): Promise<"accept"|"modify"|"reject"|"defer">  // judgment stays out
  }
  ```
  Engine owns: wave iteration + hard barrier (all nodes of wave N before N+1), `when` skip evaluation, per-node attempt loop (retry with backoff — `retry.max_attempts/initial_interval_ms/backoff/non_retryable`), `timeout_ms` via Runner, ledger writes (startRun at entry, appendNode per result, endRun at exit with verdict), evidence stamp loop, `unresolved` detection (dispatch intents without trace lines), curator-wave handling (dispatches `memory-curator` with recall skill, parses `INJECTION:` line, prepends `[memory]` to next action wave's objectives), loop-round bookkeeping per `loop.enabled`/`stop_when`/`max_rounds`, `advisor` streak→escalation (dispatches advisor via Runner with `no_write`), `fan_out` brief read+parallel dispatch, `budget_tokens` context cap (compact upstream + spill to artifacts/), run verdict (`merged`/`blocked`/`failed`).

- [ ] **Step 1: Write the failing tests** — stub Runner over a 3-wave plan: wave order enforced; a failing node stops the graph with `failed`; `when:false` node skipped + dependents skipped; retry exhausted → fail; a node whose `stop_when` unmet loops to max_rounds; advisor fires at streak; `unresolved` lists intent-without-trace.

- [ ] **Step 2: Run to verify fail.**

- [ ] **Step 3: Implement engine.**

- [ ] **Step 4: Verify** — `bun test tests/unit/exec-engine.test.ts && bun run typecheck` → PASS.

- [ ] **Step 5: Commit** — `feat(exec): runGraph engine — waves/barrier/retry/loop/advisor/fan_out/budget/verdict, ledger-owned`

---

### Task 4: `gk exec` headless runner

**Files:**
- Modify: `src/index.ts`, `src/cli/commands/run.ts` (or new `src/cli/commands/exec.ts`)
- Test: `tests/unit/exec-cli.test.ts`

**Interfaces:**
- Consumes: `resolveGraphPath` (P0 resolver — `gk exec` takes the same `[graph]` arg + `--graph/--session` flags), `planGraph`, `runGraph`, `spawnDispatch` (childProcess Runner), `materializeNodeAgents` (for `.omp/agents/gk-<id>.md` the children read).
- Produces: `gk exec [graph] --session <id> --worktree --json` — resolves graph, `planGraph`, `runGraph` with `childProcess` Runner (spawnDispatch per node; `askGate` undefined → gate nodes auto-skip in headless unless `--yes` approves all); prints per-node lines + final `RunVerdict`; `--json` emits the verdict envelope. Worktree mode (`--worktree`): per write-capable node `git worktree add .graphkit/worktrees/<id> -b gk/<id>` + merge-on-land (the existing skill protocol, moved to code).

- [ ] **Step 1: Write the failing test** — `gk exec .tmp-e2e/graph.yaml --json` on a 2-node plan, stub children → verdict merged + trace.jsonl has the lines.

- [ ] **Step 2: Run to verify fail.**

- [ ] **Step 3: Implement** — verb + childProcess Runner + worktree branch lifecycle.

- [ ] **Step 4: Verify** — `bun test tests/unit/exec-cli.test.ts && bun run typecheck` → PASS.

- [ ] **Step 5: Commit** — `feat(exec): gk exec headless runner — resolves graph, runs engine with spawnDispatch`

---

### Task 5: Skill shrink — gk-execute becomes the interactive adapter

**Files:**
- Modify: `kits/_core/skills/gk-execute/SKILL.md` (~380 → ~80 lines), possibly `gk-init-graph`/`gk-run` prose pointers, `kits/_core/extensions/gk-subagent.ts` (docstring — engine is in src/ now)
- Test: `tests/unit/` — no new; `bun run scripts/gen-kits.ts` regen + `sync-omp`

**Interfaces:**
- Produces: gk-execute SKILL retains ONLY the host-agent responsibilities — "call `gk exec` if you want headless; else use the engine's wave spec via `gk graph waves --json` + dispatch each node with `task()`, feeding results via `gk run node`" — the skill keeps: CHALLENGE adjudication (accept/modify/reject/defer), gate suspension UX, worktree-vs-same-tree escalation judgment, curator `INJECTION:` interpretation, the task-tool batching recipe. All deterministic protocol (wave barrier arithmetic, retry backoff math, timeout, evidence stamp loop, unresolved scan) is DELETED from prose — the engine owns it and the skill points to `gk exec` / engine for it.

- [ ] **Step 1: Rewrite SKILL.md** — ~80 lines: when-to-use, interactive recipe (waves → task() batch → gk run node → gate), judgment parts, pointer to `gk exec` for headless. Kill the 380-line engine spec.

- [ ] **Step 2: Verify** — `bun run scripts/gen-kits.ts --check && bun run scripts/sync-omp.ts --check && bun run check-changelog` → PASS.

- [ ] **Step 3: Commit** — `docs(kits): gk-execute shrinks to adapter — deterministic engine lives in src/exec, skill keeps judgment`

---

## Self-review

- **P2 spec coverage:** one exec engine (interactive + headless share via Runner) ✓ · planGraph consumed ✓ · one writer per node ✓ (engine) · worktree mode in code ✓ · KIT#4 interactive/headless ✓ · EX F1 silent-drop — engine surfaces every dispatch+result explicitly ✓.
- **Ordering:** T1 types → T2 spawn port → T3 engine (needs both) → T4 `gk exec` (needs engine+spawn) → T5 skill (needs engine to reference). T2/T4 could overlap; keep serial for clarity.
- **Type consistency:** Runner/DispatchOutcome/NodeRun/RunVerdict consistent; engine consumes PlanGraph; Runner returns DispatchOutcome.
- **Scope honesty:** the full engine is large — this plan is the honest slice (engine + spawn + exec CLI + skill shrink); memory-curator cadence interleave inside engine comes from planGraph's `curator` flag, fan_out briefs from graph node field, both real.

## Deferred out of P2 (tracked — do not lose)

- **I3 worktree protocol-verification half**: per-merge test gate, `owns` check, `gk run land --commit`, post-merge evidence re-stamp — the second half of the skill's merge protocol not yet in `WorktreeRunner`/`mergeWave`. Own ticket.
- **Dual spawn-copy dedupe**: `kits/_core/extensions/gk-subagent.ts` keeps a verbatim `dispatch()` copy; `src/exec/spawn.ts` is canonical — pointer comments on both files name the dedupe as P3 (kit-bridge bundling or generated shared file).
- **`--resume` for `gk exec`**: engine `attachRun` validates activeness only — no skip-traced-nodes logic, so attaching would silently re-dispatch every node. Real resume lives in `src/runs/resume.ts`. Needs the resume-graph derivation wired through `runGraph`, not just a flag.
- **`fan_out.reduce` merge/vote + `effort` scaling**: declared in schema, engine appends/advisory-only — validate now warns (`unimplemented-field`). Implementation ticket pending multi-run aggregation semantics.
- **hooks `.cjs` family** (same parked ticket as P1): `kits/claude/hooks/evidence-persist.cjs` writes dead `.index`, `lease-enforce.cjs` reads ghost `current.json`, `gk-run` claude prose documents group rounds no flow drives — kill + rewrite pinned `hooks.test.ts` cases.
- **`docs/gk-slp-usage.html` staleness**: describes the pre-P2 flow; zero inbound refs — retire or rewrite.
- **Judge for `gk exec`**: `JUDGE_REQUIRED` fails fast rather than mis-executing `when:`/`stop_when:` graphs; a real JudgeFn (LLM predicate eval) for headless is the eventual answer.
- **`gk run round` orphaned in interactive recipe**: claude-kit prose documents group rounds — `gk exec` refuses groups (UNSUPPORTED_LOOPS); either wire `run round` into the skill recipe or mark it engine-only.

