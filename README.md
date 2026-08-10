# GraphKit

GraphKit is a graph engineering kit for AI coding agents (Claude Code and Cursor). It installs agents, skills, hooks, and rules that let you define, validate, compile, and execute graph-structured agent workflows.

## What it is

- A **kit template** per target: `claude/` (Claude Code) and `cursor/` (Cursor) — each with 8 agents, skills, 4 hooks, and rules in the target's native format
- A **compiler** (`gk`) that turns a `graph.yaml` into a runnable workflow
- **Two runtimes**: Claude Code's Workflow tool (`/gk:run`) or direct subagent dispatch (`/gk:execute`, works in both hosts)

gk never invokes a model, spawns an agent, or reads an API key. It validates and compiles only.

## CBM boundary

gk bridges to the [codebase-memory-mcp](https://github.com/) (CBM) MCP server for indexing and code-graph queries (`gk graph index|search|trace|query`). gk owns no graph database — CBM is the authority. This keeps gk a workflow compiler, not a re-implementation of CBM's LSP-backed indexer.

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

## Cursor IDE support

GraphKit also targets Cursor. Pass `--target cursor` to install the Cursor-flavored kit into `.cursor/` instead of `.claude/`:

```bash
gk init --target cursor      # install into an existing project
gk new --dir my-project --target cursor   # scaffold fresh
```

The `gk` CLI is identical across targets — `validate`, `graph new/ascii/svg/waves` all work the same. The kit differs:

| | Claude Code (`--target claude`) | Cursor (`--target cursor`) |
|---|---|---|
| Rules | `.claude/rules/*.md` | `.cursor/rules/*.mdc` (Cursor frontmatter) |
| Agents | `.claude/agents/*.md` | `.cursor/agents/*.md` (+ `readonly`, `is_background`) |
| Skills | `.claude/skills/*/SKILL.md` | `.cursor/skills/*/SKILL.md` |
| Hooks | `.claude/settings.json` + `hooks/*.cjs` | `.cursor/hooks.json` (lowercase events) + `hooks/*.cjs` |
| Execution | `/gk:run` (Workflow tool) + `/gk:execute` | **`/gk:execute` only** (Cursor has no Workflow tool) |

Cursor has no Workflow tool, so the compile→run path is omitted — `/gk:execute` is the sole execution path. It reads `gk graph waves --json` and dispatches Cursor subagents via the Task tool, wave by wave (parallel within a wave).

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

Inside a Claude Code or Cursor session (after `gk init`):

- `/gk:init-graph --template diamond` — generate a graph.yaml
- `/gk:brainstorm` — refine nodes, model tiers, loops, constraints
- `/gk:visualize` — render the graph (ASCII inline, SVG, or Excalidraw)
- `/gk:validate` — gate-check before compile
- `/gk:compile` — graph.yaml → .workflow.js (Claude Code only)
- `/gk:run` — execute via Claude Code Workflows (Claude Code only)
- `/gk:execute` — execute by dispatching subagents directly (both hosts; **sole path in Cursor**)
- `/gk:eval` — score evidence / memory against rubrics
- `/gk:recall` — query the codebase-memory graph
- `/gk:evidence` — report what the graph produced
- `/gk:status` — current run state

## Eleven topologies

| Topology | Shape | Use |
|----------|-------|-----|
| diamond | fan-out → reduce → synthesize | reviews, research, migrations |
| classify-and-act | route one input to one handler | triage, routing |
| adversarial-verification | produce → refute → adjudicate | security, fact-check |
| loop-until-done | scout → work → dedup until dry | discovery, sweeps |
| generate-and-filter | generate many → keep best K | naming, ideation |
| tournament | pairwise elimination | ranking, evals |
| memory-augmented | wrap any graph with recall + curator | long-context work |
| custom | arbitrary DAG via `depend_on` | any shape you define |
| sdd | brainstorm → plan → parallel workers → review → test | subagent-driven dev |
| superpowers | brainstorm → plan → workers → test loop | brainstorm/plan/execute |
| research-and-build | scout → research → plan → build → review | research-first features |

Topologies compose: a diamond's fan-out can embed an adversarial-verification subgraph, or use `custom` to mix patterns (diamond + per-node loops).

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

gk is the compiler, not a runtime. It never invokes a model, spawns an agent, or reads an API key. Execution is delegated to the host: Claude Code's Workflow tool (`/gk:run`) or native subagent dispatch (`/gk:execute`, both hosts).
