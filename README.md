# GraphKit

GraphKit is a graph engineering kit for AI coding agents (Claude Code and Cursor). It installs agents, skills, hooks, and rules that let you define, validate, compile, and execute graph-structured agent workflows.

## What it is

- A **kit template** per target: `claude/` (Claude Code) and `cursor/` (Cursor) — each with 8 agents, skills, 4 hooks, and rules in the target's native format
- A **compiler** (`gk`) that turns a `graph.yaml` into a runnable workflow
- **Two runtimes**: Claude Code's Workflow tool (`/gk:run`) or direct subagent dispatch (`/gk:execute`, works in both hosts)

gk never invokes a model, spawns an agent, or reads an API key. It validates and compiles only.

## Viewer

`/gk:visualize` launches a private, read-only local viewer (127.0.0.1, cryptographically random access key, live updates over SSE):

- **Interactive graph** — drag nodes (edges re-route live), hover/select edges via wide hit-targets, Shift+click two nodes to trace a route, click a node for the detail sidebar (objective, model tier, depend_on, evidence, filters), arrow-key navigation, Esc to clear
- **Pinned port** — binds `4800` by default; override with `GK_VIEWER_PORT`. Port busy → probes +1…+9, then falls back to ephemeral so it always starts
- **Browser open is opt-in** — by default it just prints the keyed URL. Set `GK_VIEWER_OPEN=1` to open the default browser, or `GK_VIEWER_BROWSER=chrome` to target Chrome specifically
- Up to 250 nodes; idle timeout shuts the server down

## Memory

`gk memory` keeps cross-run project memory in `.graphkit/memory/` — salience-ranked recall with validity/supersede filters, ACT-R decay, and a full audit trail:

```bash
gk memory recall "viewer port"   # top-k relevant memories (auto-touches)
gk memory touch <id>             # reinforce a memory
gk memory trace                  # decay pass + consolidation audit log
```

## CBM boundary

gk bridges to the [codebase-memory-mcp](https://github.com/) (CBM) MCP server for indexing and code-graph queries (`gk graph index|search|trace|query`). gk owns no graph database — CBM is the authority. This keeps gk a workflow compiler, not a re-implementation of CBM's LSP-backed indexer.

## Install

### GitHub release

Each build on `main` publishes a new patch release (e.g. `v0.2.1`) with binaries and auto-generated changelogs. Install the latest for your platform:

**macOS Apple Silicon:**

```bash
curl -fsSL https://github.com/thanhNt16/graph-kit/releases/latest/download/gk-darwin-arm64.tar.gz \
  | sudo tar -xz -C /usr/local/bin
```

> `releases/latest` always resolves to the newest version tag. `/usr/local/bin` is on `PATH` and is not SIP-protected, so no extra setup is needed.
> ⚠️ Do **not** install to `/usr/bin` — it is SIP-protected on macOS; extraction fails with `Operation not permitted` even with `sudo`.

Verify:

```bash
gk --version
```

Install the kit into a project:

```bash
gk init
```

Or scaffold a new project:

```bash
gk new --dir my-project
```

Upgrading the binary does not touch installed projects — re-run `gk init` in each project to refresh agents/skills/hooks to the new kit. Kit files always overwrite; user config (`.gk.json`) is preserved. `gk init --force` wipes and reinstalls clean.

## Quickstart

```bash
gk init                                   # install kit into .claude/
gk graph new diamond > graph.yaml         # scaffold a graph
gk validate graph.yaml                    # gate-check
gk graph ascii graph.yaml                 # instant in-terminal preview
```

Then in a Claude Code session: `/gk:visualize` to see it, `/gk:execute` to run it wave by wave.

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
    agent: software-architect
    model: opus
    objective: Identify files to review
    depend_on: []
  worker:
    agent: code-reviewer
    model: sonnet
    depend_on: [scouter]
  synthesizer:
    agent: software-architect
    model: opus
    depend_on: [worker]
limits:
  max_workers: 3
evidence:
  required_keys: [report]
```

## Session skills

Inside a Claude Code or Cursor session (after `gk init`):

- `/gk:init-graph --template diamond` — generate a graph.yaml (from a topology preset **or a packaged GraphTemplate**, with capability suggestions)
- `/gk:template` — package a validated graph.yaml as a reusable `GraphTemplate v1` (`gk template pack|list|show`)
- `/gk:brainstorm` — refine nodes, model tiers, loops, constraints
- `/gk:visualize` — interactive viewer (default) or `--ascii` / `--svg` / `--excalidraw`
- `/gk:validate` — gate-check before compile
- `/gk:compile` — graph.yaml → .workflow.js (Claude Code only)
- `/gk:run` — execute via Claude Code Workflows (Claude Code only)
- `/gk:execute` — execute by dispatching subagents directly (both hosts; **sole path in Cursor**)
- `/gk:eval` — score evidence / memory against rubrics
- `/gk:recall` — query the codebase-memory graph
- `/gk:evidence` — report what the graph produced
- `/gk:status` — current run state

Templates live in `<project>/.graphkit/templates/` (overrides) and `~/.graphkit/templates/`; `gk inventory` reports installed agents/skills/tools/MCP servers for the active target — names only, no credentials/tokens. See [docs/templates-and-viewer.md](docs/templates-and-viewer.md) for template storage, parameter reference, the smart `/gk:init-graph` flow, and the interactive viewer's controls and troubleshooting.

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
    agent: software-architect
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
