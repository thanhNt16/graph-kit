---
name: gk-execute
description: Execute a graph.yaml by dispatching parallel subagents via the Task tool — no compilation, no Workflow tool. Transparent, real-time, interactive. Use when the user wants to execute a graph with full visibility — see each agent spawn, watch progress, debug failures. Trigger: "execute graph", "run graph directly", "spawn agents for graph", "direct execution".
disable-model-invocation: false
---

# gk execute

## Purpose

Execute a graph.yaml by **dispatching Cursor subagents via the Task tool** — YOU are the orchestrator. No compiled workflow, no Workflow tool. Each node becomes a real Task tool call you can see and monitor.

This is the sole execution path in Cursor (Cursor has no Workflow tool equivalent). Use this when you want:
- Real-time visibility into each node's execution
- Ability to debug/adapt when a node fails
- Interactive control (pause, ask user, resume)
- No compilation step

## Process

### Step 1: Get the wave structure

```bash
gk graph waves graph.yaml --json
```

This outputs the topological wave structure — which nodes run in parallel, which wait for dependencies. Parse the JSON to understand execution order.

### Step 2: Execute wave by wave

For each wave in the output:

**Curator waves (`wave.curator === true`):** if the wave is a curator wave (emitted by `memory-augmented` graphs at cadence), dispatch its single node — the **Memory Curator** (`.cursor/agents/memory-curator.md`) — with the `gk:recall` skill. Pass it the evidence paths written by the just-completed action wave. Collect its `injection_decision` evidence key:
- If `injection_decision` is non-null (a reminder, not silence): prepend that reminder to the **next** action wave's node `objective`(s).
- If null (explicit silence): inject nothing.

Then continue to the next wave — skip the action-wave steps below for curator waves.

1. **Read each node's agent definition** from `.cursor/agents/<agent-name>.md` — this gives you the agent's identity, rules, and deliverables.

2. **Dispatch subagents via the Task tool** — one Task tool call per node in the wave. If a wave has 3 nodes, send multiple Task tool calls in a single message (they run concurrently). Each task gets:
   - The node's `objective` as its task
   - The agent definition (identity, rules) as context
   - The node's `model` tier
   - Any upstream results from `depend_on` nodes (append to the objective)
   - The node's `refs` (read these files and include relevant content)
   - The node's `tools` and `skills` constraints

3. **Collect results** — when all tasks in the wave return, collect their outputs.

4. **Handle loops** — if a node has `loop.enabled` and its result doesn't meet the stop condition, re-dispatch that node (up to `max_rounds`).

5. **Write evidence** — write each node's output to `.graphkit/evidence/<node-id>.md` with the declared evidence keys.

### Step 3: After all waves complete

Write a summary to `.graphkit/reports/<graph-name>.md` with:
- Each node's verdict/output
- Evidence coverage check (all `required_keys` present?)
- Overall verdict (passed/failed/partial)

## Example: Diamond with 3 workers

```
Wave 0: [scouter]                    → 1 task (opus)
Wave 1: [worker-a, worker-b, worker-c] → 3 tasks in parallel (sonnet)
Wave 2: [synthesizer]                 → 1 task (opus)
```

- Wave 0: dispatch 1 Task for scouter, wait for result
- Wave 1: dispatch 3 Tasks in ONE message (parallel), wait for all 3
- Wave 2: pass all 3 results to synthesizer, dispatch 1 Task

## Task dispatch template

For each node, construct the Task prompt:

```
You are {agent_name} from .cursor/agents/{agent-file}.md.

Your task: {node.objective}

{if upstream results:}
Upstream results from dependencies:
{for each dep: dep_id: dep_result}

Constraints: {node.constraints}
Required evidence: {node.evidence}

Return your output with these evidence keys: {node.evidence}
```

Dispatch via the Task tool with the node's model tier and the matching `.cursor/agents/<agent>.md` definition.

## Model resolution (Cursor)

The node's `model` tier is a GraphKit tier, not a Cursor model. Resolve it
before setting the Task tool's model:

| GraphKit tier | Cursor model |
|---|---|
| `opus` | `Grok 4.5` |
| `sonnet` | `Composer 2.5` |
| `haiku` | `Auto` |
| `fable` | `Auto` |

Custom overrides live in `.graphkit/models.cursor.json` and win over the table
above. Query the effective mapping with `gk models cursor`. If a tier is
missing from the map, fall back to `Auto`.

## Why this is effective

- **Transparent**: every task dispatch is visible in the conversation
- **Debuggable**: if a node fails, you see the error and can retry
- **Adaptive**: you can adjust objectives between waves based on results
- **No compilation**: skip `gk compile` entirely — execute directly from graph.yaml
- **Native**: uses Cursor's native Task tool, no Workflow tool needed

## Note

Cursor has no Workflow tool equivalent; gk:execute is the sole execution path.
