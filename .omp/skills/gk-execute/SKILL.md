---
name: gk-execute
description: Execute a graph.yaml by dispatching isolated subagent runs through the gk_dispatch_agent tool — no compilation. Transparent, real-time, interactive. Optional worktree mode (--worktree / "batch") isolates write nodes in git worktrees. Trigger: "execute graph", "run graph directly", "spawn agents for graph", "batch the graph".
when_to_use: User wants to execute a graph with full visibility — see each node dispatch and result, watch progress, debug failures. Use worktree mode when a wave has 2+ write nodes with overlapping scopes.
user-invocable: true
disable-model-invocation: false
---

# gk execute

## Purpose

Execute a graph.yaml by **dispatching subagent runs through the `gk_dispatch_agent` tool** (provided by the gk-subagent extension) — YOU are the orchestrator. No compiled .workflow.js. Each node becomes one dispatch call you can see and monitor.

This is direct execution from graph.yaml — there is no compile step in this kit. Use this when you want:
- Real-time visibility into each node's execution
- Ability to debug/adapt when a node fails
- Interactive control (pause, ask user, resume)
- No compilation step

## Dispatch modes

| Mode | When | How |
|---|---|---|
| **Same-tree** (default) | Read-heavy waves, ≤3 writers with clean file scopes | plain sequential dispatches; the plan partitions files via an ownership map |
| **Worktree** (`--worktree`, "batch the graph", "run in worktrees") | 2+ write nodes per wave whose scopes overlap or would need an ownership map | each write-capable node runs inside its own `git worktree` branch — collisions become impossible |

Escalate same-tree → worktree when you catch yourself drawing an ownership map. Escalate worktree → same-tree (sequenced via `depend_on`) only if the repo isn't git or the host lacks worktree support.

## Process

### Step 1: Get the wave structure

```bash
gk graph waves graph.yaml --json
```

This outputs the topological wave structure — which nodes run in parallel, which wait for dependencies. Parse the JSON to understand execution order.

### Step 1b: Start the run ledger

```bash
gk run start --graph graph.yaml --json
```

Before dispatching wave 1, start the ledger. If it fails with `RUN_ACTIVE`, a previous
run never ended — ask the user, or run `gk run status` to inspect, before proceeding.

### Recording nodes

After EVERY node dispatch returns (ok or fail), append a trace line:

```bash
gk run node <node-id> --status ok|fail --wave <wave-index> --agent <agent> --evidence <comma,keys> --duration-ms <ms>
```

A failed dispatch (ok:false) MUST be recorded with `--status fail` BEFORE stopping the
graph — the failure pattern is exactly what `gk memory consolidate` later surfaces.

If the waves payload carries `hooks: [...]` on a node, run those command strings
verbatim instead of hand-writing the equivalent `gk run node` call; `{node}` in the
string substitutes the node id.

### Ending

After the final wave (and the evidence gate): `gk run end --status merged|blocked|failed`,
then `gk memory consolidate --json`. If the payload has `on_graph_complete`, run those
commands verbatim — `gk run end` + `gk memory consolidate` are what they normally contain.

### Step 2: Execute wave by wave

For each wave in the output:

**Curator waves (`wave.curator === true`):** if the wave is a curator wave (emitted by `memory-augmented` graphs at cadence), dispatch its single node — the **Memory Curator** (`memory-curator`) — with the gk-recall skill. Pass it the evidence paths written by the just-completed action wave. Curator calls are excluded from cadence counting — cadence counts completed **action-node** executions only, so a curator wave never triggers another. Read the curator's terminal line — its final non-empty line must be exactly `INJECTION: <reminder>` or `INJECTION: null`; parse only that line and treat it as the `injection_decision`:
- If the terminal line is `INJECTION: <reminder>` (non-null): prepend `[memory] <reminder>` to the **next** action wave's node `objective`(s).
- If `INJECTION: null` or malformed output (terminal line missing/unparseable): log a diagnostic to stderr and inject nothing — a malformed terminal line never blocks the action node.

Then continue to the next wave — skip the action-wave steps below for curator waves.

1. **Resolve each node's agent fragment** at `.omp/agents/<agent-name>.md` — `gk_dispatch_agent` loads it automatically; you only need it to check the agent exists and understand its deliverables.

## Dispatching a wave (pi)

Use the `gk_dispatch_agent` tool (provided by the gk-subagent extension) once per node in
the current wave — issue all calls for the wave, collect every result, then proceed.
Wave barrier: do NOT start wave N+1 until every node of wave N returned ok:true. The same barrier holds across loop rounds — do not start round N+1 until every node of a loop group's last wave returned.
A failed node (ok:false) stops the graph: report node name, objective, and error output.
Pass node constraints: no_write → constraints.no_write=true; tools → constraints.tools_allowlist.

Each dispatch gets:
   - The node's `agent` (must match a `.omp/agents/<name>.md` fragment)
   - The node's `objective` as the objective
   - Any upstream results from `depend_on` nodes (append to the objective or context)
   - The node's `refs` (mention these files in the context)
   - The node's `tools` and `no_write` constraints via `constraints`

   In **worktree mode**: for each write-capable node, create an isolated worktree first (`git worktree add .graphkit/worktrees/<node-id> -b gk/<node-id>`), run the dispatch with the worktree path in the objective, and make objectives fully self-contained (workers cannot ask the user) — include repo conventions, the node's acceptance-check recipe, and landing instructions (commit to the worktree branch, conventional message). Read-only nodes skip worktrees — plain dispatch.

2. **Collect results** — when all dispatches in the wave return ok:true, collect their outputs.
   In **worktree mode** a wave is NOT done when agents return — it is done when
   merged and the gate is green (see Worktree merge protocol below).

3. **Handle loops** — per-node `loop.enabled`: if the result doesn't satisfy its `stop_when`, re-dispatch that node (up to `max_rounds`). Top-level `loops:` (multi-node groups): see [Loop groups](#loop-groups-multi-node-loops) below — the hybrid stop ladder replaces the advisory-only rule.

4. **Write evidence** — write one non-whitespace file per declared evidence key: `<evidence_dir>/<key>.md`


### Step 3: After all waves complete

Write a summary to `.graphkit/reports/<graph-name>.md` with:
- Each node's verdict/output
- Evidence coverage check (all `required_keys` present?)
- Overall verdict (passed/failed/partial)

## Example: Diamond with 3 workers

```
Wave 0: [scouter]                    → 1 agent (opus)
Wave 1: [worker-a, worker-b, worker-c] → 3 agents in parallel (sonnet)
Wave 2: [synthesizer]                 → 1 agent (opus)
```

- Wave 0: dispatch scouter, wait for ok:true
- Wave 1: dispatch worker-a, worker-b, worker-c, wait for all 3
- Wave 2: pass all 3 results to synthesizer, dispatch it

## Dispatch call shape

```
gk_dispatch_agent({
  agent: "<node.agent>",          // must match .omp/agents/<agent>.md
  objective: "<node.objective>",
  context: "<upstream results, refs, acceptance recipe>",
  constraints: {                  // only when the node declares them
    no_write: true,
    tools_allowlist: ["read", "grep", "bash"]
  },
  timeout_ms: 600000              // optional budget override
})
```

The result is `{ ok, output, exit_code }`. Only `ok:true` counts toward the wave barrier.

## Worktree merge protocol (worktree mode)

After all agents in a wave finish (wait on notifications — never assume):

1. `git worktree list` → each worker's branch.
2. Merge sequentially into the main tree in node order (`git merge --no-commit --no-ff <branch>`):
   - Conflict (unmerged paths / `UU` in `git status`): `git merge --abort` immediately, stop the graph, and report node id, branch, and conflicting files — never hand-resolve mid-run and never start the next merge. Conflicts on the same lines are a plan smell; the graph should have sequenced those nodes via `depend_on`.
   - Clean merge: run the repo's test gate; seal with `git commit --no-edit` only while the gate stays green. A failing gate: stop and fix (or `git merge --abort`) before merging the next branch.
3. Remove worktrees (`git worktree remove`); keep branches until the whole graph passes. Open actual PRs only if the user asked.

Graph authority is unchanged in worktree mode — topology, `depend_on` ordering, and loops still come from graph.yaml; worktrees are transport-level isolation only.

**Fallback (no worktree support):** same-tree mode with a strict per-node file ownership map; if files can't be partitioned, sequence the nodes via `depend_on` and re-validate.

## Loop groups (multi-node loops)

Top-level `loops:` repeats a **contiguous wave span** as a round trip (e.g. implement → test) until a stop condition. Semantics are authoritative in the design spec §4.3:

```yaml
loops:
  - nodes: [implement, test]      # required; contiguous wave span (validator-enforced)
    max_rounds: 5                 # required; ≥ 1 hard cap
    stop_when: "all tests pass"   # LLM-judged; required unless gate_evidence
    gate_evidence: [test-report]  # optional deterministic machine gate
```

**Execution:** waves are computed once from the DAG. Walk waves normally; when you reach a loop group's head wave, enter the loop:

1. **Run a round** = one pass over the span's waves, dispatching normally. Round N outputs feed round N+1 node contexts.
2. **Hybrid stop ladder** — after each round, check in order:
   1. `gate_evidence` set and every listed `<evidence_dir>/<key>.md` exists and is non-whitespace → **stop: success** (deterministic, shell-testable).
   2. Else `stop_when` present → judge the previous round's node outputs against the text yourself (same LLM-read pattern as curator `INJECTION:` parsing). Satisfied → **stop: success**.
   3. Else dispatch the next round.
3. **Evidence:** latest round wins — overwrite `<evidence_dir>/<key>.md` in place; never accumulate rounds.
4. **Exhaustion:** `max_rounds` reached without satisfaction → the loop fails and, per graph-stop rules, the whole run stops. Report rounds executed, last-round outputs, and which condition was being checked.
5. **Run report:** record rounds completed and stop reason per loop — `gate` | `judged` | `exhausted`.

Per-node `loop:` keeps its existing behavior and is orthogonal — a node inside a group may still carry its own internal loop.

## Why this is effective

- **Transparent**: every dispatch and its result are visible in the conversation
- **Debuggable**: if a node fails (ok:false), you see the error output and can retry
- **Adaptive**: you can adjust objectives between waves based on results
- **No compilation**: skip `gk compile` entirely — execute directly from graph.yaml
- **Native**: uses the pi gk-subagent extension tool, no external orchestrator

## vs compiled workflows

| | gk-execute (this) | gk compile + runner |
|---|---|---|
| Visibility | Full — see every result | Opaque — background |
| Compilation | Not needed | Required (gk compile) |
| Debugging | Interactive | Hard |
| Speed | Same (parallel within waves) | Same |
| Scale | Good for <20 nodes | Better for 100+ nodes |
| Adaptivity | Can adjust mid-run | Fixed script |

## Evidence gate

Before reporting completion, write one non-whitespace file per declared evidence key:
`<graph.outputs.evidence_dir>/<key>.md`

After all producer waves finish, run:

```bash
gk gate graph.yaml
```

The gate maps each required key `k` to `<evidence_dir>/<k>.md`. Missing or whitespace-only files produce `BLOCK` and exit 1; repair or redispatch only the producer for each missing/empty key, then rerun the gate. Only `MERGE` with exit 0 permits completion. The compiled workflow does not invoke the gate automatically.
