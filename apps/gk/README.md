# GraphKit

GraphKit is a graph engineering kit for Claude Code. It installs agents, skills, hooks, and rules that let you define, validate, compile, and execute graph-structured agent workflows.

## What it is

- A **kit template** (`claude/`) of 7 agents, 8 skills, 3 hooks, 3 rules
- A **compiler** (`gk`) that turns a `graph.yaml` into a Claude Code dynamic workflow script
- **Claude Code Workflows** as the runtime — no custom state machine, no model calls inside gk

gk never invokes a model, spawns an agent, or reads an API key. It validates and compiles only.

## Install

```bash
npm install -g @graphkit/gk
```

Install the kit into a project:

```bash
gk init
```

Or scaffold a new project:

```bash
gk new --dir my-project
```

## Define a graph

Create `graph.yaml` with a topology, node bindings, and inputs:

```yaml
apiVersion: graphkit.dev/v2
kind: Graph
metadata:
  name: my-review
topology: diamond
inputs:
  repo_path:
    type: string
    required: true
nodes:
  scouter:
    agent: Software Architect
    model: opus
    objective: Identify files to review
    depend_on: []
  worker:
    agent: Code Reviewer
    model: sonnet
    depend_on: [scouter]
  synthesizer:
    agent: Software Architect
    model: opus
    depend_on: [worker]
limits:
  max_workers: 3
evidence:
  required_keys: [report]
```

## Session skills

Inside a Claude Code session (after `gk init`):

- `/gk:init-graph --template diamond` — generate a graph.yaml
- `/gk:brainstorm` — refine nodes, model tiers, loops, constraints
- `/gk:visualize` — render the graph as an Excalidraw diagram
- `/gk:validate` — gate-check before compile
- `/gk:compile` — graph.yaml → .workflow.js
- `/gk:run` — execute via Claude Code Workflows
- `/gk:evidence` — report what the graph produced
- `/gk:status` — current run state

## Six topologies

| Topology | Shape | Use |
|----------|-------|-----|
| diamond | fan-out → reduce → synthesize | reviews, research, migrations |
| classify-and-act | route one input to one handler | triage, routing |
| adversarial-verification | produce → refute → adjudicate | security, fact-check |
| loop-until-done | scout → work → dedup until dry | discovery, sweeps |
| generate-and-filter | generate many → keep best K | naming, ideation |
| tournament | pairwise elimination | ranking, evals |

Topologies compose: a diamond's fan-out can embed an adversarial-verification subgraph.

## Per-node binding

Each node carries its own model tier, tools, skills, refs, constraints, and optional internal loop:

```yaml
nodes:
  scouter:
    agent: Software Architect
    model: opus
    tools: [Read, Glob, Grep]
    refs:
      - path: docs/standards.md
        purpose: checklist
    loop:
      enabled: true
      max_rounds: 3
      stop_when: evidence found
    constraints:
      no_write: true
```

`depend_on` controls parallelism: empty = start immediately, shared = parallel, multiple = barrier.

## Boundary

gk is the compiler, not a runtime. It never invokes a model, spawns an agent, or reads an API key. Claude Code's native Workflow tool executes the compiled graph.
