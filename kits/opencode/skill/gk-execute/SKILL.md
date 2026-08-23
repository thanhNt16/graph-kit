---
name: gk-execute
description: Execute a graph.yaml by directly dispatching parallel subagents via the Task tool — no compilation. Transparent, real-time, interactive. Optional worktree mode (--worktree / "batch") isolates write nodes in git worktrees. Trigger: "execute graph", "run graph directly", "spawn agents for graph", "batch the graph".
when_to_use: User wants to execute a graph with full visibility — see each agent spawn, watch progress, debug failures. Use worktree mode when a wave has 2+ write nodes with overlapping scopes.
user-invocable: true
disable-model-invocation: false
---

# gk execute

## Purpose

Execute a graph.yaml by **directly dispatching subagents via the Task tool** — YOU are the orchestrator. No compiled .workflow.js. Each node becomes a real Task tool call you can see and monitor.

This is direct execution from graph.yaml — there is no compile step in this kit. Use this when you want:
- Real-time visibility into each node's execution
- Ability to debug/adapt when a node fails
- Interactive control (pause, ask user, resume)
- No compilation step

## Dispatch modes

| Mode | When | How |
|---|---|---|
| **Same-tree** (default) | Read-heavy waves, ≤3 writers with clean file scopes | plain background dispatch; the plan partitions files via an ownership map |
| **Worktree** (`--worktree`, "batch the graph", "run in worktrees") | 2+ write nodes per wave whose scopes overlap or would need an ownership map | each write-capable node dispatches into its own `git worktree` branch — collisions become impossible |

Escalate same-tree → worktree when you catch yourself drawing an ownership map. Escalate worktree → same-tree (sequenced via `depend_on`) only if the repo isn't git or the host lacks worktree support.

## Process

### Step 1: Get the wave structure

```bash
gk graph waves graph.yaml --json
```

This outputs the topological wave structure — which nodes run in parallel, which wait for dependencies. Parse the JSON to understand execution order.

Then mark the run active so the gk plugin's guards engage: create `.graphkit/runs/.active` (empty marker) and write `.graphkit/runs/current.json`:

```json
{ "name": "<graph name>", "started_at": "<ISO>", "constraints": { "<nodeId>": { "assigned_only": true } } }
```

`constraints` maps each node id to its declared constraints from graph.yaml (same shape the compiled workflow runtime uses).

### Step 2: Execute wave by wave

For each wave in the output:

**Curator waves (`wave.curator === true`):** if the wave is a curator wave (emitted by `memory-augmented` graphs at cadence), dispatch its single node — the **Memory Curator** (`.opencode/agent/memory-curator.md`) — with the `gk-recall` skill. Pass it the evidence paths written by the just-completed action wave. Curator calls are excluded from cadence counting — cadence counts completed **action-node** executions only, so a curator wave never triggers another. Read the curator's terminal line — its final non-empty line must be exactly `INJECTION: <reminder>` or `INJECTION: null`; parse only that line and treat it as the `injection_decision`:
- If the terminal line is `INJECTION: <reminder>` (non-null): prepend `[memory] <reminder>` to the **next** action wave's node `objective`(s).
- If `INJECTION: null` or malformed output (terminal line missing/unparseable): log a diagnostic to stderr and inject nothing — a malformed terminal line never blocks the action node.

Then continue to the next wave — skip the action-wave steps below for curator waves.

1. **Read each node's agent definition** from `.opencode/agent/<agent-name>.md` — this gives you the agent's identity, rules, and deliverables.

2. **Spawn parallel subagents** — dispatch each node via the **Task tool** with `subagent_type` set to the node's agent name; wave barrier = wait for all background tasks in the wave before proceeding. If a wave has 3 nodes, dispatch 3 Task calls in a single message (they run in parallel). Each agent gets:
   - The node's `objective` as its task
   - The agent definition (identity, rules) as context
   - The node's `model` tier
   - Any upstream results from `depend_on` nodes (append to the objective)
   - The node's `refs` (read these files and include relevant content)
   - The node's `tools` and `skills` constraints

   In **worktree mode**: for each write-capable node, create an isolated worktree first (`git worktree add .graphkit/worktrees/<node-id> -b gk/<node-id>`), dispatch the Task call with the worktree path in the prompt, and make prompts fully self-contained (background workers cannot ask the user) — include repo conventions, the node's acceptance-check recipe, and landing instructions (commit to the worktree branch, conventional message). Read-only nodes skip worktrees — plain dispatch.

3. **Collect results** — when all agents in the wave return, collect their outputs.
   In **worktree mode** a wave is NOT done when agents return — it is done when
   merged and the gate is green (see Worktree merge protocol below).

4. **Handle loops** — if a node has `loop.enabled` and its result doesn't meet the stop condition, re-spawn that node (up to `max_rounds`).

5. **Write evidence** — write each node's output to `.graphkit/evidence/<node-id>.md` with the declared evidence keys.

### Step 3: After all waves complete

Remove the run markers: delete `.graphkit/runs/.active` and write `.graphkit/runs/{name}-result.json`.

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

- Wave 0: spawn 1 subagent for scouter, wait for result
- Wave 1: spawn 3 subagents in ONE message (parallel), wait for all 3
- Wave 2: pass all 3 results to synthesizer, spawn 1 subagent

## Agent dispatch template

For each node, construct the Task tool prompt (with `subagent_type` set to the node's agent name):

```
You are {agent_name} from .opencode/agent/{agent-file}.md.

Your task: {node.objective}

{if upstream results:}
Upstream results from dependencies:
{for each dep: dep_id: dep_result}

Constraints: {node.constraints}
Required evidence: {node.evidence}

Return your output with these evidence keys: {node.evidence}
```

Set the Task tool's `model` to the node's `model` tier mapped through the agent's frontmatter default (`anthropic/claude-opus-4.5`, `anthropic/claude-sonnet-4.5`, or `anthropic/claude-haiku-4.5`). The `subagent_type` must match an agent filename in `.opencode/agent/`.

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
- **Native**: uses OpenCode's native Task tool and `.opencode/agent/` subagents

## vs compiled workflows

| | /gk:execute (this) | gk compile + Workflow-style runner |
|---|---|---|
| Visibility | Full — see every agent | Opaque — background |
| Compilation | Not needed | Required (gk compile) |
| Debugging | Interactive | Hard |
| Speed | Same (parallel within waves) | Same |
| Scale | Good for <20 nodes | Better for 100+ nodes |
| Adaptivity | Can adjust mid-run | Fixed script |

## Run-state contract

The gk plugin (`.opencode/plugins/gk.ts`) reads `.graphkit/runs/.active` and `.graphkit/runs/current.json`:
- While `.active` exists, manual writes to `.graphkit/evidence/**` are blocked — evidence files are workflow-owned during a run.
- Node `constraints` (`assigned_only`, `no_write`) from `current.json` are injected into each node's Task dispatch prompt — respect them when touching files.
- Writes under `.graphkit/evidence/` are auto-indexed to `.graphkit/evidence/.index` and distilled into `.graphkit/memory/`.

Always create the markers at run start and remove `.active` at run end, or these guards misfire.
