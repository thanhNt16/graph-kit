---
name: gk:execute
description: Execute a graph.yaml by directly spawning parallel subagents via the Agent tool — no compilation, no Workflow tool. Transparent, real-time, interactive. Optional worktree mode (--worktree / "batch") isolates write nodes in git worktrees. Trigger: "execute graph", "run graph directly", "spawn agents for graph", "batch the graph".
when_to_use: User wants to execute a graph with full visibility — see each node dispatch and result, watch progress, debug failures. Use worktree mode when a wave has 2+ write nodes with overlapping scopes.
user-invocable: true
disable-model-invocation: false
---

# gk execute

## Purpose

Execute a graph.yaml by **directly spawning parallel subagents via the Agent tool** — YOU are the orchestrator. No compiled .workflow.js. Each node becomes one Agent call you can see and monitor.

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

1. **Read each node's agent definition** from `.claude/agents/<agent-name>.md` — this gives you the agent's identity, rules, and deliverables.

## Dispatching a wave (Claude Code)

Spawn one parallel subagent per node in the current wave via the **Agent tool** — issue all calls for the wave in a single message (they run in parallel), collect every result, then proceed. Agent definitions live at `.claude/agents/<agent-name>.md`; read the node's definition first for identity, rules, and deliverables.
Wave barrier: do NOT start wave N+1 until every agent of wave N returned. The same barrier holds across loop rounds — do not start round N+1 until every node of a loop group's last wave returned.
A failed agent stops the graph: report node name, objective, and error output — unless the node declares `retry` for a transient failure (see [Orchestration fields](#orchestration-fields)). Before dispatching a node, check its `when` (skip if false) and `gate` (suspend for approval).

Each Agent call gets:
   - `subagent_type: "general-purpose"` plus the agent definition (identity, rules) as context
   - The node's `objective` as its task
   - The node's `model` tier
   - Any upstream results from `depend_on` nodes (append to the objective)
   - The node's `refs` (read these files and include relevant content)
   - The node's `tools` and `skills` constraints

   In **worktree mode**: write-capable nodes additionally get `isolation: "worktree"` and their prompts must be fully self-contained (background workers cannot ask the user) — include repo conventions, the node's acceptance-check recipe, and landing instructions (commit to the worktree branch, conventional message). Read-only nodes skip worktrees — plain dispatch.
2. **Collect results** — when all agents in the wave return, collect their outputs.
   In **worktree mode** a wave is NOT done when agents return — it is done when
   merged and the gate is green (see Worktree merge protocol below).
3. **Handle loops** — if a node has `loop.enabled` and its result doesn't meet the stop condition (`stop_when` is advisory), re-dispatch that node (up to `max_rounds`). Top-level `loops:` (multi-node groups): see [Loop groups](#loop-groups-multi-node-loops) below.
## Example: Diamond with 3 workers

```
Wave 0: [scouter]                    → 1 agent (opus)
Wave 1: [worker-a, worker-b, worker-c] → 3 agents in parallel (sonnet)
Wave 2: [synthesizer]                 → 1 agent (opus)
```

- Wave 0: dispatch scouter, wait for ok:true
- Wave 1: dispatch worker-a, worker-b, worker-c, wait for all 3
- Wave 2: pass all 3 results to synthesizer, dispatch it

## Agent dispatch template

For each node, construct the Agent prompt:

```
You are {agent_name} from .claude/agents/{agent-file}.md.

Your task: {node.objective}

{if upstream results:}
Upstream results from dependencies:
{for each dep: dep_id: dep_result}

Constraints: {node.constraints}
Required evidence: {node.evidence}
Return your output with these evidence keys: {node.evidence}
```

Set the Agent's `model` to the node's `model` tier. Use `general-purpose` as the agent type.
## Orchestration fields

Nodes may declare optional orchestration fields. The schema validates them; you enforce them at dispatch time. `gk graph waves` output carries every field verbatim per node — read them from the wave payload, not from graph.yaml.

### `retry` — transient dispatch-failure policy

```yaml
retry: { max_attempts: 3, initial_interval_ms: 1000, backoff: 2.0, non_retryable: [TIMEOUT] }
```

Defaults: `max_attempts: 1` (no retry), `initial_interval_ms: 1000`, `backoff: 2.0` (exponential), `non_retryable: []`.

**Retry ONLY transient dispatch failures** — infrastructure errors: the dispatch tool itself errored, agent binary crashed, transport timeout. Prompt, parse, and validation errors are NEVER retried: the input was wrong, retrying repeats it. Before retry N+1 (0-indexed from 1): wait `initial_interval_ms * backoff^(N-1)` ms. An error string matching (case-insensitive, substring) any `non_retryable` entry is fatal even within budget. Attempts exhausted → treat as a failed node (stop the graph, report attempts made). Record attempts in the run report.

### `when` — conditional skip

```yaml
when: "no security findings were reported by upstream audit"
```

Natural-language predicate over upstream node results — judge it yourself (same read-and-judge pattern as `stop_when`), evaluated just before the node's dispatch, after its wave barrier. False → **skip the node**: record it via `gk run node <id> --status skipped`, do NOT dispatch, downstream nodes see it as satisfied for the wave barrier with no output to inject. Skips are recorded, never silent.

### `budget_tokens` — advisory context cap

```yaml
budget_tokens: 4000
```

Cap on the upstream context injected into the dispatch. Rough-estimate tokens (~chars/4); if injected upstream context exceeds the cap: compact (summarize per upstream node, keep verdicts/decisions/evidence keys, drop prose) and spill the full text to `.graphkit/artifacts/<node-id>-input.md`, passing the file path instead. Budgets are advisory — never truncate a verdict, evidence key, or acceptance recipe below usefulness.

### `gate` — human approval before dispatch

```yaml
gate: { question: "Deploy to staging?", details: "Runs migrations" }
```

Before dispatching a gated node, suspend the run: surface the question (+details) to the user and stop the wave loop — do NOT proceed past the barrier. On approval, continue normally; on rejection, record the node `skipped` and continue (downstream nodes judge `when` against that; a skipped node's dependents are skipped too — no evidence exists for them to consume). If the session dies mid-suspension, `gk run end` the stale run first, then `gk run resume` — skipped nodes stay skipped on resume (never re-asked). One gate pause per node.

### `fan_out` with `reduce` — fan out and reduce

```yaml
fan_out: { briefs_from: plan, template: "Implement {brief.title}: {brief.body}", reduce: merge }
```

`briefs_from` names an upstream node whose output (evidence key) is a JSON array; you dispatch one subagent per array item with `template` rendered per item (`{brief}` = the JSON item; `{brief.<field>}` = a field). `reduce` controls combining (default `append`):
- `append` — concatenate per-item outputs in order.
- `merge` — treat per-item outputs as partial views of one artifact; merge into a single coherent result.
- `vote` — judge per-item outputs against the node objective and keep the winning one (state the winner and why in the run report).

Record the reduced result as the node's output (and evidence). A fan_out node's dispatch count is items, not 1 — the wave barrier waits for all item dispatches.

### `effort` — dispatch scaling

```yaml
effort: deep   # node-level; default standard
```

`light` → single pass, tight `budget_tokens` (≤2000 if unset), 1 attempt, no parallel fan-out widening. `standard` → as declared. `deep` → widen: fan-out width doubles (dispatch up to 2× the `fan_out` items in parallel), loop `max_rounds` ×2 (round up), retry `max_attempts` +1, generous budget (≥8000 if unset). Effort scales the bounds declared on the node; it never overrides explicit user instructions mid-run.

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
    no_progress_limit: 2          # optional; fail early after N identical failing rounds
```

**Execution:** waves are computed once from the DAG. Walk waves normally; when you reach a loop group's head wave, enter the loop:

1. **Run a round** = one pass over the span's waves, dispatching normally. Round N outputs feed round N+1 node contexts.
2. **Record the round**: `gk run round <group-index>` after each pass — it appends a durable journal line and fingerprints the round's node statuses + evidence bytes. Do not skip it: round counts and no-progress detection come from this journal, not your memory.
3. **Hybrid stop ladder** — check in order:
   1. `gate_evidence` set and every listed `<evidence_dir>/<key>.md` exists and is non-whitespace → **stop: success** (deterministic, shell-testable).
   2. Else `stop_when` present → judge the previous round's node outputs against the text yourself (same LLM-read pattern as curator `INJECTION:` parsing). Satisfied → **stop: success**.
   3. Else read the `gk run round` response: `stop_reason: "no_progress"` (identical failing fingerprint `no_progress_limit` times) or `"max_rounds"` → **stop: fail the loop**; `null` → dispatch the next round.
4. **Evidence:** latest round wins — overwrite `<evidence_dir>/<key>.md` in place; never accumulate rounds.
5. **Exhaustion:** a failure stop (`no_progress` or `max_rounds`) → the loop fails and, per graph-stop rules, the whole run stops. Report rounds executed, last-round outputs, and which condition was being checked.
6. **Run report:** record rounds completed and stop reason per loop — `gate` | `judged` | `no_progress` | `exhausted`.

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
