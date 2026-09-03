---
name: gk:execute
description: Execute a graph.yaml by directly spawning parallel subagents — no compilation, no Workflow tool. Transparent, real-time, interactive. Optional worktree mode (--worktree / "batch") isolates write nodes in git worktrees. Trigger: "execute graph", "run graph directly", "spawn agents for graph", "batch the graph".
when_to_use: User wants to execute a graph with full visibility — see each agent spawn, watch progress, debug failures. Prefer this over /gk:run for development and iteration. Use worktree mode when a wave has 2+ write nodes with overlapping scopes.
user-invocable: true
disable-model-invocation: false
---

# gk execute

## Purpose

Execute a graph.yaml by **directly spawning Claude Code subagents** — YOU are the orchestrator. No compiled .workflow.js, no Workflow tool. Each node becomes a real Agent tool call you can see and monitor.

This is the transparent alternative to `/gk:run` (which uses the opaque Workflow tool). Use this when you want:
- Real-time visibility into each node's execution
- Ability to debug/adapt when a node fails
- Interactive control (pause, ask user, resume)
- No compilation step

## Dispatch modes

| Mode | When | How |
|---|---|---|
| **Same-tree** (default) | Read-heavy waves, ≤3 writers with clean file scopes | plain background dispatch; the plan partitions files via an ownership map |
| **Worktree** (`--worktree`, "batch the graph", "run in worktrees") | 2+ write nodes per wave whose scopes overlap or would need an ownership map | write-capable nodes dispatch with `isolation: "worktree"` + `run_in_background: true` — collisions become impossible |

Escalate same-tree → worktree when you catch yourself drawing an ownership map. Escalate worktree → same-tree (sequenced via `depend_on`) only if the repo isn't git or the host lacks worktree support.

## Process

### Step 1: Get the wave structure

```bash
gk graph waves graph.yaml --json
```

This outputs the topological wave structure — which nodes run in parallel, which wait for dependencies. Parse the JSON to understand execution order.

### Step 1b: Start the run ledger

```bash
gk run start graph.yaml --json
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

**Curator waves (`wave.curator === true`):** if the wave is a curator wave (emitted by `memory-augmented` graphs at cadence), dispatch its single node — the **Memory Curator** (`.claude/agents/memory-curator.md`) — with the `gk-recall` skill. Pass it the evidence paths written by the just-completed action wave. Curator calls are excluded from cadence counting — cadence counts completed **action-node** executions only, so a curator wave never triggers another. Read the curator's terminal line — its final non-empty line must be exactly `INJECTION: <reminder>` or `INJECTION: null`; parse only that line and treat it as the `injection_decision`:
- If the terminal line is `INJECTION: <reminder>` (non-null): prepend `[memory] <reminder>` to the **next** action wave's node `objective`(s).
- If `INJECTION: null` or malformed output (terminal line missing/unparseable): log a diagnostic to stderr and inject nothing — a malformed terminal line never blocks the action node.

Then continue to the next wave — skip the action-wave steps below for curator waves.

1. **Read each node's agent definition** from `.claude/agents/<agent-name>.md` — this gives you the agent's identity, rules, and deliverables.

2. **Spawn parallel subagents** — one Agent tool call per node in the wave. If a wave has 3 nodes, dispatch 3 Agent calls in a single message (they run in parallel). Each agent gets:
   - The node's `objective` as its task
   - The agent definition (identity, rules) as context
   - The node's `model` tier
   - Any upstream results from `depend_on` nodes (append to the objective)
   - The node's `refs` (read these files and include relevant content)
   - The node's `tools` and `skills` constraints

   In **worktree mode**: write-capable nodes additionally get `isolation: "worktree"` and their prompts must be fully self-contained (background workers cannot ask the user) — include repo conventions, the node's acceptance-check recipe, and landing instructions (commit to the worktree branch, conventional message). Read-only nodes skip worktrees — plain dispatch.

3. **Collect results** — when all agents in the wave return, collect their outputs.
   In **worktree mode** a wave is NOT done when agents return — it is done when
   merged and the gate is green (see Worktree merge protocol below).

4. **Handle loops** — if a node has `loop.enabled` and its result doesn't meet the stop condition (`stop_when` is advisory), re-dispatch that node (up to `max_rounds`).


5. **Write evidence** — write one non-whitespace file per declared evidence key: `<evidence_dir>/<key>.md`


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

- Wave 0: spawn 1 Agent for scouter, wait for result
- Wave 1: spawn 3 Agents in ONE message (parallel), wait for all 3
- Wave 2: pass all 3 results to synthesizer, spawn 1 Agent

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

Set the Agent's model to the node's `model` tier. Use `general-purpose` agent type.

## Worktree merge protocol (worktree mode)

After all agents in a wave finish (wait on notifications — never assume):

1. `git worktree list` → each worker's branch.
2. Merge sequentially into the main tree in node order (`git merge --no-commit --no-ff <branch>`):
   - Conflict (unmerged paths / `UU` in `git status`): `git merge --abort` immediately, stop the graph, and report node id, branch, and conflicting files — never hand-resolve mid-run and never start the next merge. Conflicts on the same lines are a plan smell; the graph should have sequenced those nodes via `depend_on`.
   - Clean merge: run the repo's test gate; seal with `git commit --no-edit` only while the gate stays green. A failing gate: stop and fix (or `git merge --abort`) before merging the next branch.
3. Remove worktrees (`git worktree remove`); keep branches until the whole graph passes. Open actual PRs only if the user asked.

Graph authority is unchanged in worktree mode — topology, `depend_on` ordering, and loops still come from graph.yaml; worktrees are transport-level isolation only.

**Fallback (Cursor / no worktree support):** same-tree mode with a strict per-node file ownership map; if files can't be partitioned, sequence the nodes via `depend_on` and re-validate.

## Why this is effective

- **Transparent**: every agent spawn is visible in the conversation
- **Debuggable**: if a node fails, you see the error and can retry
- **Adaptive**: you can adjust objectives between waves based on results
- **No compilation**: skip `gk compile` entirely — execute directly from graph.yaml
- **Native**: uses Claude Code's native Agent tool, not the Workflow tool

## vs /gk:run

| | /gk:execute (this) | /gk:run (Workflow tool) |
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
