# GraphKit

[![CI](https://github.com/thanhNt16/graph-kit/actions/workflows/ci.yml/badge.svg)](https://github.com/thanhNt16/graph-kit/actions/workflows/ci.yml)
[![Release](https://github.com/thanhNt16/graph-kit/actions/workflows/release.yml/badge.svg)](https://github.com/thanhNt16/graph-kit/releases/latest)
[![GitHub Pages](https://img.shields.io/badge/docs-pages-2ea043?logo=githubpages)](https://thanhnt16.github.io/graph-kit/)
[![Tests](https://img.shields.io/badge/tests-575_passing-2ea043)](https://github.com/thanhNt16/graph-kit/actions/workflows/ci.yml)

> **11 topologies · 5 targets · 8 agents · 13 skills (claude) · 575 tests · zero-model runtime**

GraphKit is a graph engineering kit for AI coding agents (Claude Code, Cursor, OpenCode, Codex CLI, and pi). It installs agents, skills, hooks, and rules that let you define, validate, compile, and execute graph-structured agent workflows — with a run ledger, checkpoint resume, and project memory.

**TOC** — [What it is](#what-it-is) · [Install](#install) · [Quickstart](#quickstart) · [Host support](#host-support) · [Define a graph](#define-a-graph) · [Session skills](#session-skills) · [Topologies](#eleven-topologies) · [Per-node binding](#per-node-binding) · [Loop groups](#loop-groups) · [CLI reference](#cli-reference) · [Project memory](#project-memory) · [CBM boundary](#cbm-boundary) · [Diagrams](#diagrams) · [Docs site](https://thanhnt16.github.io/graph-kit/)

> **Changelog**: [CHANGELOG.md](CHANGELOG.md) documents all feature releases.
> **Worktree merge protocol**: [docs/worktree-merge-protocol.md](docs/worktree-merge-protocol.md) details conflict-safe concurrent agent editing.

## What it is

- A **kit template** per target — `claude/`, `cursor/`, `opencode/`, `codex/`, `pi/` — each with 8 agents, skills, hooks (or their host-native equivalent), and rules in the target's native format
- A **compiler** (`gk`) that turns a `graph.yaml` into a runnable workflow
- **Two runtimes**: Claude Code's Workflow tool (`/gk:run`) or direct subagent dispatch (`/gk:execute`, works on every target)

gk never invokes a model, spawns an agent, or reads an API key. It validates and compiles only.

This is a **graph engineering kit** ([Simmons — *We Are Entering the Graph Engineering Phase*](https://www.drjoshcsimmons.com/writing/we-are-entering-the-graph-engineering-phase)): it compiles the coordination that LLM-choreographed alternatives delegate to a language model into a deterministic workflow file ([TURION — multi-agent orchestration infrastructure in production](https://turion.ai/blog/multi-agent-orchestration-infrastructure-production/)). Budgets are the safety story — `constraints` and loop `max_rounds` cap the blast radius where swarm-style setups have incurred runaway costs ([Edgeless Lab](https://edgelesslab.com/blog/swarm-tried-to-bankrupt-itself/)). Per-node binding replaces the state-schema tax competitors pay: every node carries its own model tier, tools, skills, and constraints instead of a shared typed state ([Orange ITS — LangGraph review](https://www.orange-its.ch/en/insights/langgraph-review), [Kalvium — LangGraph vs LangChain in production](https://www.kalviumlabs.ai/blog/langgraph-vs-langchain-production/)).

## Diagrams

`/gk:visualize` renders graph.yaml as a self-contained HTML diagram via [archify](https://github.com/tt-a1i/archify) — pan/zoom, search, guided views, no server:

- **Archify HTML** (default) — the skill reads `gk graph waves`, authors a typed archify IR (waves become columns, model tiers become lanes), validates it at showcase quality, and delivers `.graphkit/diagrams/{name}.html`. One file: shareable, attachable to a PR
- **Install on first use** — the skill asks before running `npx -y skills add tt-a1i/archify -g`; decline or no network falls back to SVG
- **Other modes** — `--ascii` (instant, in-session), `--svg` (fast export), `--excalidraw` (editable)

## Project memory

`gk memory` keeps cross-run project memory in `.graphkit/memory/` — salience-ranked recall with validity/supersede filters, ACT-R decay, and a full audit trail:

```bash
gk memory recall "diagram output"   # top-k relevant memories (auto-touches)
gk memory touch <id>             # reinforce a memory
gk memory trace                  # decay pass + consolidation audit log
```

Memory files retain GraphKit's existing frontmatter and add OKF-compatible fields: `generated`, `recorded_at`, `status`, and `sources`. This is additive compatibility, not OKF conformance; see the [current OKF specification](https://github.com/GoogleCloudPlatform/open-knowledge-format/blob/main/SPEC.md). Unknown fields survive rewrites. Capture identity is `basename + sha1(source + body)[:8]`: identical re-captures are idempotent, while changed content creates a new file and supersedes the old one (`valid_to`, `superseded_by`, `status: deprecated`) rather than overwriting it.

The reader is strict at the filesystem boundary: malformed entries are dropped and counted in `malformed`; unreadable memory directories return `MEMORY_DIR_UNREADABLE` and fail, while a missing directory is treated as empty. Memory-augmented workflows use one terminal `INJECTION: <reminder>` / `INJECTION: null` contract on both execution paths. Curator cadence counts completed action-node executions, not curator calls. `recall_topk`, `expire_policy: manual`, and `null_intervention_allowed` are honored from graph configuration. Curator behavior is parity-tested across Claude Code, Cursor, OpenCode, Codex, and pi; Codex uses `workspace-write` so it can persist memory.

Deterministic checks: `bun test` — **575 pass, 0 fail**; `bun run eval:memory` — `hit_rate: 1`, `validity_violations: []`, `malformed: 14` / `malformed_expected: 14`; `bun run typecheck` passes. These are fixture and behavior checks, not benchmark-superiority claims. The [@0xwast3 memory-engineering article](https://x.com/0xwast3/status/2084625810112032849) is third-party evidence only; its `status: conflicted` and three-month capture criterion are follow-up scope, not shipped behavior.

## CBM boundary

gk can bridge to the codebase-memory-mcp (CBM) MCP server for indexing and code-graph queries (`gk graph index|search|ask|trace|query`, `gk memory index`). gk owns no graph database — CBM is the authority. This keeps gk a workflow compiler, not a re-implementation of CBM's LSP-backed indexer.

**The CBM bridge is currently unavailable**: `@graphkit/codebase-memory-mcp` is not yet published (npm 404). Until it is, those commands fail with code `CBM_UNAVAILABLE` and exit 1 unless you point `CBM_CMD`/`CBM_ARGS` at a local codebase-memory-mcp build. `gk memory recall|touch` (file-based) are unaffected and keep working.

## Install

### GitHub release

Each build on `main` publishes a new patch release (e.g. `v0.2.9`) with binaries and auto-generated changelogs. Install the latest for your platform:

**macOS Apple Silicon** (no sudo — installs into your home dir):

```bash
mkdir -p ~/.local/bin && rm -rf ~/.local/bin/gk ~/.local/bin/share
curl -fsSL https://github.com/thanhNt16/graph-kit/releases/latest/download/gk-darwin-arm64.tar.gz \
  | tar -xz -C ~/.local/bin
```

> The tarball holds `gk` plus a `share/gk/kits/` tree; `gk` finds its kits beside itself, so any writable dir on `PATH` works. Ensure `~/.local/bin` is on `PATH` (`echo $PATH | tr : '\n' | grep .local/bin`) — add `export PATH="$HOME/.local/bin:$PATH"` to your shell rc if missing.
> Clearing the two paths first matters: `tar -xz` overlays and never removes files a newer release dropped.

System-wide instead (needs sudo, and every upgrade needs it again):

```bash
curl -fsSL https://github.com/thanhNt16/graph-kit/releases/latest/download/gk-darwin-arm64.tar.gz \
  | sudo tar -xz -C /usr/local/bin
```

> `releases/latest` always resolves to the newest version tag. `/usr/local/bin` is on `PATH` and is not SIP-protected.
> ⚠️ Do **not** install to `/usr/bin` — it is SIP-protected on macOS; extraction fails with `Operation not permitted` even with `sudo`.
> ⚠️ If you install to both, whichever dir comes first on `PATH` wins. `which -a gk` shows every copy; stale ones are silently shadowed, not upgraded.

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

- `/gk:init-graph --template diamond` — generate a **session graph** (from a topology preset **or a packaged GraphTemplate**, with capability suggestions); writes `.graphkit/graphs/<date>-<slug>.yaml` and sets the active pointer
- `/gk:template` — package a validated graph.yaml as a reusable `GraphTemplate v1` (`gk template pack|list|show`)
- `/gk:brainstorm` — refine nodes, model tiers, loops, constraints
- `/gk:visualize` — archify HTML diagram (default) or `--ascii` / `--svg` / `--excalidraw`
- `/gk:validate` — gate-check before compile
- `/gk:compile` — graph.yaml → .workflow.js (Claude Code only)
- `/gk:run` — execute via Claude Code Workflows (Claude Code only)
- `/gk:execute` — execute by dispatching subagents directly (all targets; **sole path outside Claude Code**). `--worktree` mode: write nodes run as worktree-isolated background agents (Claude Code's `/batch` technique, graph as the decomposition — parallel nodes can't collide, merge is the wave barrier)
- `/gk:eval` — score evidence / memory against rubrics
- `/gk:recall` — query the codebase-memory graph
- `/gk:evidence` — report what the graph produced
- `/gk:status` — current run state

Templates resolve in order: `<project>/.graphkit/templates/` ⇒ `~/.graphkit/templates/` ⇒ the bundled gallery (`audit-pr`, `refactor-module`, `bench-eval`, `doc-sweep`); `gk template list` reports an `origin` column (`project` | `global` | `gallery`) showing which store won. Materialize any of them into an immutable session graph with `gk template materialize <name> --params '{"task":"…"}' [--use]` (`--use` sets the active pointer), then browse sessions with `gk graph list|switch|show`. `gk inventory` reports installed agents/skills/tools/MCP servers for the active target — names only, no credentials/tokens. See [docs/templates-and-viewer.md](docs/templates-and-viewer.md) for template storage, parameter reference, the smart `/gk:init-graph` flow, and the archify diagram mode.

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

## Loop groups

Beyond per-node `loop:`, graphs can repeat a **contiguous wave span** — e.g. implement → test cycles — via a top-level `loops:` array:

```yaml
loops:
  - nodes: [implement, test]      # required; wave-contiguous span (validated)
    max_rounds: 5                 # required; ≥ 1 hard cap
    stop_when: "all tests pass"   # LLM-judged; required unless gate_evidence
    gate_evidence: [test-report]  # optional deterministic machine gate
```

The hybrid stop ladder runs after each round: first the deterministic `gate_evidence` check (every listed `<evidence_dir>/<key>.md` exists and is non-whitespace), then the orchestrator-judged `stop_when` text; otherwise another round, capped hard at `max_rounds`. Exhaustion fails the run, recording rounds executed and the stop reason (`gate` / `judged` / `exhausted`). Validation enforces node existence, wave-span contiguity, non-overlapping groups, `max_rounds ≥ 1`, a stop condition being present, and every `gate_evidence` key declared on a node inside the span. Per-node `loop:` stays unchanged and orthogonal.

## Boundary

## CLI reference

```text
$ gk --help

  gk/0.3.0

  Usage:
    $ gk <command> [options]

  Commands:
    init                             Install the GraphKit kit into the current project
    new                              Scaffold a new project with the GraphKit kit
    gate [file]                      Deterministic evidence gate: MERGE/BLOCK over required evidence keys
    validate [file]                  Validate a graph.yaml
    compile [file]                   Compile graph.yaml to a .workflow.js script
    graph [subcommand] [args...]     Graph lifecycle commands
                                     Subcommands: list switch show topologies inspect new ascii svg waves index search ask trace query
    memory [subcommand] [args...]    Memory commands
                                     Subcommands: index trace touch recall consolidate
    models [subcommand] [args...]    Per-target model mapping commands
    template [subcommand] [args...]  Package, list, inspect, and materialize reusable GraphTemplates
    inventory                        Inventory installed agents, skills, tools, and MCP servers
    status                           Summarize active graph run and evidence coverage
    execute [file]                   Execute a graph.yaml (not yet implemented)
    visualize [file]                 Visualize a graph.yaml (not yet implemented)
    run [subcommand] [args...]       Run ledger commands
                                     Subcommands: start node end status resume
    suggest                          Show ranked workflow suggestions from memory

  Options:
    -v, --version  Display version number
    -h, --help     Display this message
```

Use `gk <command> --help` for per-command details.

### `gk status`

`gk status` summarizes the active graph run without touching state — it reads `.graphkit/runs/.active` (written by `gk run start`) and reports the run's metadata, current round, and required vs. produced evidence keys:

```bash
$ gk status            # human-readable
$ gk status --json     # machine-readable: run, round, coverage, verdict
```

No active run prints a stable "no run" summary and exits 0 — safe to call from scripts and CI.

### `gk run resume`

Resume a failed or interrupted run from its checkpoint — no restart from zero:

```bash
$ gk run resume <run-id>            # reconcile → derive pending-only graph → start child run
$ gk run resume <run-id> --dry-run  # preview reconciliation, write nothing
$ gk run resume <run-id> --from-node scan   # redo scan + dependents
```

A node counts as satisfied only if its last trace line passed **and** every declared evidence key exists on disk; dependents of failures reopen, satisfied upstreams drop out and their evidence reattaches as `refs`. The derived graph is validated against the compiler's structural rules (`RESUME_DERIVED_INVALID` — nothing written) before activation; the graph is drift-guarded by sha256 (`RESUME_GRAPH_DRIFT`, `--force` to override). The child run carries `resumes:` provenance — `gk run status` prints the full chain.

### `gk execute` / `gk visualize`

Both are pointer stubs for tools that are implemented inside the kits (the `/gk:execute` and `/gk:visualize` skills), not in the CLI binary:

```bash
$ gk execute graph.yaml    # NOT_IMPLEMENTED — use /gk:execute skill or compile
$ gk visualize graph.yaml  # NOT_IMPLEMENTED — use /gk:visualize skill
```

They exit 1 with `NOT_IMPLEMENTED` and a hint pointing at the skill that does the real work.

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
- Loop semantics: for single nodes (`node.loop`), `max_rounds` is the only mechanical bound while `stop_when` is prompt-advisory; for multi-node groups (`loops:`), orchestrators follow the **hybrid stop ladder** (deterministic `gate_evidence` check first, then LLM-judged `stop_when`, hard capped at `max_rounds` with graph-failure on exhaustion).

### Advisor escalation

A looping node may declare `advisor: {model, after_failed_rounds, max_calls}`. When a node's
failed-round streak reaches `after_failed_rounds` and `max_calls` hasn't been exhausted (within
`loop.max_rounds`), the host's execute-skill dispatches a read-only advisor subagent at
`advisor.model` (default `fable`), appends its guidance to the node's objective (`## Advisor guidance`),
and re-dispatches the node at its original tier. Escalations are recorded via `gk run node <id>
--advisor-fired <round>` into the run's `advisor.jsonl`; `gk run status` reports the count;
`gk memory consolidate` surfaces `advisor-repeat` patterns ("raise tier or loosen stop_when").

### Fan-out execution

A node may declare `fan_out: {briefs_from, template}`. The referenced upstream node writes
`briefs.json` (array of `{id, title, body}`) into its evidence; the fan-out node dispatches one
parallel host subagent per brief at the node's own tier (`template` rendered per brief, default
`{brief.body}`), barriers on all briefs, and consolidates their outputs. Briefs are data, never
edges — the wave topology stays static. `briefs_from` must be a reachable predecessor
(`depend_on` closure). A missing or malformed `briefs.json` counts as a failed round; an empty
array is ok ("no briefs").

## Evidence gate

Before reporting a graph run complete, produce one non-whitespace file per declared evidence key at `<graph.outputs.evidence_dir>/<key>.md`, then run:

```bash
gk gate graph.yaml
```

`gk gate` reads each required key `k` as `<evidence_dir>/<k>.md` and prints a deterministic MERGE/BLOCK verdict with a per-key scorecard and sha256 manifest. Exit 0 means `MERGE`; a missing or whitespace-only key yields `BLOCK` with exit 1 — repair or redispatch only the producer of that key, then rerun the gate. Compiled workflows do not invoke the gate automatically; it is the orchestrator's final step.

## Memory

gk remembers every run and improves suggestions over time — all deterministic, no model calls.

```bash
gk run start --graph graph.yaml # begin a run (fails if one is active)
gk run node <id> --status ok --wave 0 --agent <agent>
gk run node <id> --advisor-fired <round> [--streak <n>]  # record advisor escalation
gk run end --status merged  # append to .graphkit/runs/index.jsonl
gk memory consolidate       # derive patterns, suggestions, .links.json, index.md
gk suggest                  # ranked suggestions (--json, --dismiss <id>)
gk memory recall <query>    # searches root + patterns/ + suggestions/, joins links
```

Runs append episodic traces under `.graphkit/runs/<id>/` (`trace.jsonl`, `run.md`).
Consolidation counts repeated node sequences, evidence co-occurrence, recurring
failures, and graph reuse (salience = count with a 14-day half-life), writes
`.graphkit/memory/patterns/*.md` and `suggestions/*.md`, and rebuilds the derived
link graph. The bundled `dream` template (`gk template list`) dispatches agents to
propose deeper consolidations as a unified diff into `.graphkit/inbox/` — applied
only by a human via `git apply`.
