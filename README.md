# GraphKit

GraphKit is a graph engineering kit for AI coding agents (Claude Code, Cursor, OpenCode, Codex CLI, and pi). It installs agents, skills, hooks, and rules that let you define, validate, compile, and execute graph-structured agent workflows.

## What it is

- A **kit template** per target — `claude/`, `cursor/`, `opencode/`, `codex/`, `pi/` — each with 8 agents, skills, hooks (or their host-native equivalent), and rules in the target's native format
- A **compiler** (`gk`) that turns a `graph.yaml` into a runnable workflow
- **Two runtimes**: Claude Code's Workflow tool (`/gk:run`) or direct subagent dispatch (`/gk:execute`, works on every target)

gk never invokes a model, spawns an agent, or reads an API key. It validates and compiles only.

This is a **graph engineering kit** ([Simmons — *We Are Entering the Graph Engineering Phase*](https://www.drjoshcsimmons.com/writing/we-are-entering-the-graph-engineering-phase)): it compiles the coordination that LLM-choreographed alternatives delegate to a language model into a deterministic workflow file ([TURION — multi-agent orchestration infrastructure in production](https://turion.ai/blog/multi-agent-orchestration-infrastructure-production/)). Budgets are the safety story — `constraints` and loop `max_rounds` cap the blast radius where swarm-style setups have incurred runaway costs ([Edgeless Lab](https://edgelesslab.com/blog/swarm-tried-to-bankrupt-itself/)). Per-node binding replaces the state-schema tax competitors pay: every node carries its own model tier, tools, skills, and constraints instead of a shared typed state ([Orange ITS — LangGraph review](https://www.orange-its.ch/en/insights/langgraph-review), [Kalvium — LangGraph vs LangChain in production](https://www.kalviumlabs.ai/blog/langgraph-vs-langchain-production/)).

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

Memory files retain GraphKit's existing frontmatter and add OKF-compatible fields: `generated`, `recorded_at`, `status`, and `sources`. This is additive compatibility, not OKF conformance; see the [current OKF specification](https://github.com/GoogleCloudPlatform/open-knowledge-format/blob/main/SPEC.md). Unknown fields survive rewrites. Capture identity is `basename + sha1(source + body)[:8]`: identical re-captures are idempotent, while changed content creates a new file and supersedes the old one (`valid_to`, `superseded_by`, `status: deprecated`) rather than overwriting it.

The reader is strict at the filesystem boundary: malformed entries are dropped and counted in `malformed`; unreadable memory directories return `MEMORY_DIR_UNREADABLE` and fail, while a missing directory is treated as empty. Memory-augmented workflows use one terminal `INJECTION: <reminder>` / `INJECTION: null` contract on both execution paths. Curator cadence counts completed action-node executions, not curator calls. `recall_topk`, `expire_policy: manual`, and `null_intervention_allowed` are honored from graph configuration. Curator behavior is parity-tested across Claude Code, Cursor, OpenCode, Codex, and pi; Codex uses `workspace-write` so it can persist memory.

Deterministic checks: `bun test` — **461 pass, 0 fail**; `bun run eval:memory` — `hit_rate: 1`, `validity_violations: []`, `malformed: 14` / `malformed_expected: 14`; `bun run typecheck` passes. These are fixture and behavior checks, not benchmark-superiority claims. The [@0xwast3 memory-engineering article](https://x.com/0xwast3/status/2084625810112032849) is third-party evidence only; its `status: conflicted` and three-month capture criterion are follow-up scope, not shipped behavior.

## CBM boundary

gk can bridge to the codebase-memory-mcp (CBM) MCP server for indexing and code-graph queries (`gk graph index|search|ask|trace|query`, `gk memory index`). gk owns no graph database — CBM is the authority. This keeps gk a workflow compiler, not a re-implementation of CBM's LSP-backed indexer.

**The CBM bridge is currently unavailable**: `@graphkit/codebase-memory-mcp` is not yet published (npm 404). Until it is, those commands fail with code `CBM_UNAVAILABLE` and exit 1 unless you point `CBM_CMD`/`CBM_ARGS` at a local codebase-memory-mcp build. `gk memory recall|touch` (file-based) are unaffected and keep working.

## Install

### GitHub release

Each build on `main` publishes a new patch release (e.g. `v0.2.9`) with binaries and auto-generated changelogs. Install the latest for your platform:

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

## Host support

GraphKit targets five hosts. Pass `--target <id>` to install the host-flavored kit instead of `.claude/`:

```bash
gk init --target cursor      # also: opencode | codex | pi (installs `.omp/`, runs under OMP)
gk new --dir my-project --target opencode   # scaffold fresh
```

The `gk` CLI is identical across targets — `validate`, `graph new/ascii/svg/waves` all work the same. The kit differs:

| | Claude Code (`claude`) | Cursor (`cursor`) | OpenCode (`opencode`) | Codex CLI (`codex`) | pi (`pi`) |
|---|---|---|---|---|---|
| Rules | `.claude/rules/*.md` | `.cursor/rules/*.mdc` (Cursor frontmatter) | `AGENTS.md` sections appended by init | `AGENTS.md` section (+ spawn protocol) | `AGENTS.md` section |
| Agents | `.claude/agents/*.md` | `.cursor/agents/*.md` (+ `readonly`, `is_background`) | `.opencode/agent/*.md` (frontmatter) | `.codex/agents/*.toml` | `.omp/agents/*.md` (prompt fragments) |
| Skills | `.claude/skills/*/SKILL.md` | `.cursor/skills/*/SKILL.md` | `.opencode/skill/*/SKILL.md` | `.agents/skills/*/SKILL.md` (sibling dir, read natively by Codex) | `.omp/skills/*/SKILL.md` |
| Hooks | `.claude/settings.json` + `hooks/*.cjs` | `.cursor/hooks.json` (lowercase events) + `hooks/*.cjs` | TS plugin at `.opencode/plugins/gk.ts` | none — guards folded into `AGENTS.md` + skill checklists | TS extension `.omp/extensions/gk-subagent.ts` |
| Execution | `/gk:run` (Workflow tool) + `/gk:execute` | **`/gk:execute` only** (Task tool) | `/gk:execute` (Task-tool dispatch, wave barrier between waves) | `/gk:execute` (spawn-prompt driven; **wave barrier is instruction-enforced, not tool-enforced**) | `/skill:gk-execute` via the `gk_dispatch_agent` extension (**requires `omp` on PATH**) |

Cursor has no Workflow tool, so the compile→run path is omitted there too — `/gk:execute` is the sole execution path on every non-Claude target. It reads `gk graph waves --json` and dispatches subagents wave by wave (parallel within a wave). Two host-specific caveats:

- **Codex** spawns agents via prompt instructions rather than a subagent tool. The wave barrier ("wait for all results before continuing") is enforced by instruction, not by the host — a weaker guarantee than Task-tool hosts.
- **pi** installs into `.omp/` and runs under [OMP (Oh My Pi)](https://github.com/can1357/oh-my-pi) — OMP is pi-based and loads `.omp/` natively. Subagents and hooks come from the installed `gk_dispatch_agent` extension, which shells out to `omp -p`. The `omp` binary must be on your `PATH`.

`gk inventory --target <id>` reports installed agents/skills/hooks/commands for any target — names only, no credentials/tokens.

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
- `/gk:execute` — execute by dispatching subagents directly (all targets; **sole path outside Claude Code**). `--worktree` mode: write nodes run as worktree-isolated background agents (Claude Code's `/batch` technique, graph as the decomposition — parallel nodes can't collide, merge is the wave barrier)
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

gk is the compiler, not a runtime. It never invokes a model, spawns an agent, or reads an API key. Execution is delegated to the host: Claude Code's Workflow tool (`/gk:run`) or native subagent dispatch (`/gk:execute`, all targets).

## Execution contracts

Node constraints are enforced mechanically only on pi (via `gk_dispatch_agent`); on claude, cursor, codex, and opencode they are prompt-advisory — the skill passes them into each node's dispatch prompt, but the host does not filter tools.

| Constraint | Enforcement | Shell | Honest label |
|---|---|---|---|
| `tools_allowlist` | mechanical, pi `gk_dispatch_agent` | per list | real |
| `no_write` | mechanical tool filter, **Bash retained** | yes | best-effort (`echo >`, `git commit`, `curl \| sh` possible) |
| `no_exec` | mechanical tool filter, shell removed | no | hard no-mutation |

- `no_write` is best-effort: the tool filter keeps the shell in the allowlist, so a node can still mutate the filesystem through Bash. Treat it as a prompt-level guard, not a sandbox.
- `no_exec` removes Bash and overrides any `tools_allowlist` (`no_exec` > `tools_allowlist` > `no_write` on pi); it is advisory on the other four hosts.
- Loop semantics: `max_rounds` is the only mechanical loop bound; `stop_when` is advisory prompt text interpolated into each round, not an enforced exit condition.

## Evidence gate

Before reporting a graph run complete, produce one non-whitespace file per declared evidence key at `<graph.outputs.evidence_dir>/<key>.md`, then run:

```bash
gk gate graph.yaml
```

`gk gate` reads each required key `k` as `<evidence_dir>/<k>.md` and prints a deterministic MERGE/BLOCK verdict with a per-key scorecard and sha256 manifest. Exit 0 means `MERGE`; a missing or whitespace-only key yields `BLOCK` with exit 1 — repair or redispatch only the producer of that key, then rerun the gate. Compiled workflows do not invoke the gate automatically; it is the orchestrator's final step.
