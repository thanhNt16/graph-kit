---
name: gk:execute
description: Execute a graph.yaml by directly spawning parallel subagents — no compilation, no Workflow tool. Transparent, real-time, interactive. Trigger: "execute graph", "run graph directly", "spawn agents for graph", "direct execution".
when_to_use: User wants to execute a graph with full visibility — see each agent spawn, watch progress, debug failures. Prefer this over /gk:run for development and iteration.
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

## Process

### Step 1: Get the wave structure

```bash
gk graph waves graph.yaml --json
```

This outputs the topological wave structure — which nodes run in parallel, which wait for dependencies. Parse the JSON to understand execution order.

### Step 2: Execute wave by wave

For each wave in the output:

**Curator waves (`wave.curator === true`):** if the wave is a curator wave (emitted by `memory-augmented` graphs at cadence), dispatch its single node — the **Memory Curator** (`.claude/agents/memory-curator.md`) — with the `gk:recall` skill. Pass it the evidence paths written by the just-completed action wave. Collect its `injection_decision` evidence key:
- If `injection_decision` is non-null (a reminder, not silence): prepend that reminder to the **next** action wave's node `objective`(s).
- If null (explicit silence): inject nothing.

Then continue to the next wave — skip the action-wave steps below for curator waves.

1. **Read each node's agent definition** from `.claude/agents/<agent-name>.md` — this gives you the agent's identity, rules, and deliverables.

2. **Spawn parallel subagents** — one Agent tool call per node in the wave. If a wave has 3 nodes, dispatch 3 Agent calls in a single message (they run in parallel). Each agent gets:
   - The node's `objective` as its task
   - The agent definition (identity, rules) as context
   - The node's `model` tier
   - Any upstream results from `depend_on` nodes (append to the objective)
   - The node's `refs` (read these files and include relevant content)
   - The node's `tools` and `skills` constraints

3. **Collect results** — when all agents in the wave return, collect their outputs.

4. **Handle loops** — if a node has `loop.enabled` and its result doesn't meet the stop condition, re-spawn that node (up to `max_rounds`).

5. **Write evidence** — write each node's output to `.graphkit/evidence/<node-id>.md` with the declared evidence keys.

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
