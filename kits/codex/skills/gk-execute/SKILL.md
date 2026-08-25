---
name: gk-execute
description: Execute a graph.yaml by directly spawning custom agents in parallel waves — no compilation. Transparent, real-time, interactive. Optional worktree mode (--worktree / "batch") isolates write nodes in git worktrees. Trigger: "execute graph", "run graph directly", "spawn agents for graph", "batch the graph".
when_to_use: User wants to execute a graph with full visibility — see each agent spawn, watch progress, debug failures. Use worktree mode when a wave has 2+ write nodes with overlapping scopes.
user-invocable: true
disable-model-invocation: false
---

# gk execute

## Purpose

Execute a graph.yaml by **directly spawning custom agents by name** — YOU are the orchestrator. No compiled .workflow.js. Each node becomes an agent spawn you can see and monitor.

This is direct execution from graph.yaml — there is no compile step in this kit. Use this when you want:
- Real-time visibility into each node's execution
- Ability to debug/adapt when a node fails
- Interactive control (pause, ask user, resume)
- No compilation step

## Dispatch modes

| Mode | When | How |
|---|---|---|
| **Same-tree** (default) | Read-heavy waves, ≤3 writers with clean file scopes | plain sequential spawns; the plan partitions files via an ownership map |
| **Worktree** (`--worktree`, "batch the graph", "run in worktrees") | 2+ write nodes per wave whose scopes overlap or would need an ownership map | each write-capable node spawns inside its own `git worktree` branch — collisions become impossible |

Escalate same-tree → worktree when you catch yourself drawing an ownership map. Escalate worktree → same-tree (sequenced via `depend_on`) only if the repo isn't git or the host lacks worktree support.

## Process

### Step 1: Get the wave structure

```bash
gk graph waves graph.yaml --json
```

This outputs the topological wave structure — which nodes run in parallel, which wait for dependencies. Parse the JSON to understand execution order.

### Step 2: Execute wave by wave

For each wave in the output:

**Curator waves (`wave.curator === true`):** if the wave is a curator wave (emitted by `memory-augmented` graphs at cadence), dispatch its single node — the **Memory Curator** (`memory_curator`) — with the gk-recall skill. Pass it the evidence paths written by the just-completed action wave. Curator calls are excluded from cadence counting — cadence counts completed **action-node** executions only, so a curator wave never triggers another. Read the curator's terminal line — its final non-empty line must be exactly `INJECTION: <reminder>` or `INJECTION: null`; parse only that line and treat it as the `injection_decision`:
- If the terminal line is `INJECTION: <reminder>` (non-null): prepend `[memory] <reminder>` to the **next** action wave's node `objective`(s).
- If `INJECTION: null` or malformed output (terminal line missing/unparseable): log a diagnostic to stderr and inject nothing — a malformed terminal line never blocks the action node.

Then continue to the next wave — skip the action-wave steps below for curator waves.

1. **Read each node's agent definition** from `.codex/agents/<agent-name>.toml` (`developer_instructions`) — this gives you the agent's identity, rules, and deliverables.

## Dispatching a wave (Codex)

For each node in the current wave, instruct Codex to spawn its custom agent by name,
in parallel, then WAIT for all results before continuing to the next wave. Example prompt:

"Spawn one <agent_name> agent per item below. Give each the objective and inputs listed.
Wait for ALL agents to finish before summarizing results back to me."

Wave barrier rule: never start wave N+1 until every agent of wave N has returned its summary.
If an agent fails, stop the graph and report which node failed — do not skip ahead.

Each spawned agent gets:
   - The node's `objective` as its task
   - The agent definition (identity, rules) as context
   - The node's `model` tier
   - Any upstream results from `depend_on` nodes (append to the objective)
   - The node's `refs` (read these files and include relevant content)
   - The node's `tools` and `skills` constraints

   In **worktree mode**: for each write-capable node, create an isolated worktree first (`git worktree add .graphkit/worktrees/<node-id> -b gk/<node-id>`), spawn the agent with the worktree path in its prompt, and make prompts fully self-contained (workers cannot ask the user) — include repo conventions, the node's acceptance-check recipe, and landing instructions (commit to the worktree branch, conventional message). Read-only nodes skip worktrees — plain dispatch.

2. **Collect results** — when all agents in the wave return, collect their outputs.
   In **worktree mode** a wave is NOT done when agents return — it is done when
   merged and the gate is green (see Worktree merge protocol below).

3. **Handle loops** — if a node has `loop.enabled` and its result doesn't meet the stop condition (`stop_when` is advisory), re-dispatch that node (up to `max_rounds`).


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

- Wave 0: spawn 1 agent for scouter, wait for result
- Wave 1: spawn 3 agents in parallel, wait for ALL 3
- Wave 2: pass all 3 results to synthesizer, spawn 1 agent

## Agent dispatch template

For each node, construct the spawn prompt (agent name = the TOML `name` field, underscored):

```
You are {agent_name} from .codex/agents/{agent-file}.toml.

Your task: {node.objective}

{if upstream results:}
Upstream results from dependencies:
{for each dep: dep_id: dep_result}

Constraints: {node.constraints}
Required evidence: {node.evidence}

Return your output with these evidence keys: {node.evidence}
```

The agent's `model` and `model_reasoning_effort` come from its TOML definition — do not override per node.

## Worktree merge protocol (worktree mode)

After all agents in a wave finish (wait on notifications — never assume):

1. `git worktree list` → each worker's branch.
2. Merge sequentially into the main tree in node order (`git merge --no-ff <branch>`); after each merge run the repo's test gate. A merge that breaks the gate: stop, fix, before merging the next.
3. Conflicts on the same lines = plan smell — the graph should have sequenced those nodes via `depend_on`. Resolve in favor of the more specific change, note it in the report.
4. Remove worktrees (`git worktree remove`); keep branches until the whole graph passes. Open actual PRs only if the user asked.

Graph authority is unchanged in worktree mode — topology, `depend_on` ordering, and loops still come from graph.yaml; worktrees are transport-level isolation only.

**Fallback (no worktree support):** same-tree mode with a strict per-node file ownership map; if files can't be partitioned, sequence the nodes via `depend_on` and re-validate.

## Why this is effective

- **Transparent**: every agent spawn is visible in the conversation
- **Debuggable**: if a node fails, you see the error and can retry
- **Adaptive**: you can adjust objectives between waves based on results
- **No compilation**: no compile step exists for this target — execute directly from graph.yaml
- **Native**: uses Codex custom agents defined in `.codex/agents/`

## vs compiled workflows

| | gk-execute (this) | gk compile + Workflow-style runner |
|---|---|---|
| Visibility | Full — see every agent | Opaque — background |
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
