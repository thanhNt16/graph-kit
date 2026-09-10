# GraphKit

> **The execution and evidence plane for AI coding agents.**

[![npm version](https://img.shields.io/npm/v/graphkit-gk.svg)](https://www.npmjs.com/package/graphkit-gk)
[![npm downloads](https://img.shields.io/npm/dt/graphkit-gk.svg)](https://www.npmjs.com/package/graphkit-gk)
[![CI](https://github.com/thanhNt16/graph-kit/actions/workflows/ci.yml/badge.svg)](https://github.com/thanhNt16/graph-kit/actions/workflows/ci.yml)
[![Release](https://github.com/thanhNt16/graph-kit/actions/workflows/release.yml/badge.svg)](https://github.com/thanhNt16/graph-kit/releases/latest)
[![GitHub Pages](https://img.shields.io/badge/docs-pages-2ea043?logo=githubpages)](https://thanhnt16.github.io/graph-kit/)
[![Tests](https://img.shields.io/badge/tests-575_passing-2ea043)](https://github.com/thanhNt16/graph-kit/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

GraphKit gives Claude Code, Cursor, OpenCode, Codex CLI, and Pi one deterministic execution and verification layer: 11 canonical topologies, wave-ordered subagent dispatch, worktree-isolated parallel edits, machine-checked evidence gates, and durable resume across crashes.

- **Deterministic execution graphs** — `graph.yaml` compiles multi-agent coordination into static, wave-ordered DAGs instead of trusting LLM ad-hoc routing
- **Evidence gates over agent prose** — `gk gate` checks machine-evaluated criteria, provenance, and freshness before admitting completion; prose is never proof
- **Conflict-safe parallel worktrees** — run concurrent agent edits in isolated git worktrees with barrier merges (`/gk:execute --worktree`)
- **Bounded loops with no-progress limits** — `loops[].no_progress_limit` fingerprints round outputs and stops repetitive failing cycles before burning budgets
- **Crash & resume without zero restarts** — durable run ledger reconciles satisfied nodes and resumes child runs with ancestor provenance
- **One kit across every coding agent** — `gk init` configures host-native agents, skills, hooks, and rules for 5 target IDEs and CLIs

The future is many AI coding agents. GraphKit is the layer that makes their execution deterministic, isolated, and verified.

Run `npm i -g graphkit-gk && gk init` and your project gets:

| What you need | What GraphKit provides |
|---|---|
| Deterministic coordination | 11 canonical topologies compiled into wave-ordered DAGs |
| Verified completion | Machine-checked evidence gates (`gk gate`, `gk evidence`) |
| Bounded recovery | Hard loop limits, `stop_when` ladders, and `no_progress_limit` early exhaustion |
| Crash resilience | Checkpoint reconciliation and partial-graph resume (`gk run resume`) |
| Isolated parallel edits | Git worktree isolation per write node with wave barrier merges |
| Multi-host support | One kit configuring Claude Code, Cursor, OpenCode, Codex, and Pi |
| Visual architecture | Standalone Archify HTML diagrams, SVG, and Excalidraw exports |

---

## Who this is for

Developers whose AI coding workflows have outgrown single chat prompts into multi-step, multi-agent systems:

- An agent says "All tests pass and the feature is done!" — but tests were never actually run, or failed in silence
- Parallel subagents edit the same files at the same time and overwrite each other's changes
- A retry loop runs 10 times making the exact same error, burning tokens with zero progress
- A multi-step workflow crashes on step 4 of 5 and forces you to restart from step 1
- You have to maintain different rules, prompt templates, and configs across Claude Code, Cursor, Codex, OpenCode, and Pi

Before GraphKit, multi-agent workflows are improvised, brittle, and unverified. After GraphKit, agents follow compiled execution waves, produce auditable evidence, and respect hard budget bounds.

| Without GraphKit | With GraphKit |
|---|---|
| Agent prose is accepted as proof of completion | `gk gate` requires machine-verified evidence artifacts |
| Parallel agents collide and produce git merge conflicts | Agents run in isolated worktrees; wave barriers merge cleanly |
| Retries loop endlessly on identical errors | `no_progress_limit` stops loops after consecutive identical failures |
| Crashed runs restart from step 1, re-billing work | `gk run resume` reconciles satisfied nodes and resumes from checkpoint |
| LLMs improvise edges and invent ad-hoc steps | Static wave-ordered DAG compiled from validated YAML |
| Hand-written configs per agent tool | `gk init` configures all 5 hosts from one canonical kit |

---

## Start in 30 seconds

### 1. Install `gk`

```bash
# Via npm or bun (~1-second install, 380 KB)
npm install -g graphkit-gk
# or
bun add -g graphkit-gk

# Or one-line installer (auto-detects bun/npm; falls back to standalone binary)
curl -fsSL https://raw.githubusercontent.com/thanhNt16/graph-kit/main/install.sh | sh
```

### 2. Initialize your project

```bash
cd your-project

# Install kit into your IDE / CLI of choice:
gk init                             # → .claude/   (Claude Code)
gk init --target cursor             # → .cursor/   (Cursor)
gk init --target opencode           # → .opencode/ (OpenCode)
gk init --target codex              # → .codex/    (Codex CLI)
gk init --target pi                 # → .omp/      (Pi / OMP)

# Scaffold an execution graph from the template gallery:
gk template materialize audit-pr --use

# Gate-check the graph against 9 static DAG rules:
gk validate

# Instant terminal preview:
gk graph ascii
```

Here's what lands in your repository:

```text
your-project/
├── graph.yaml                       # active workflow DAG
├── .graphkit/
│   ├── runs/                        # durable run ledger, traces, and loop journals
│   ├── evidence/                    # content-addressed evidence artifacts & markers
│   ├── memory/                      # salience-ranked cross-session project memory
│   └── diagrams/                    # generated Archify HTML diagrams
└── .claude/                         # or .cursor/, .omp/, .opencode/, .codex/
    ├── agents/                      # 8 specialized role agents (architect, reviewer...)
    ├── skills/                      # 13 session skills (brainstorm, execute, gate...)
    └── rules/                       # host-native constraints & guardrails
```

---

## A workflow, end-to-end (The Diamond Pattern)

```text
You:    /gk:execute

Graph:  Wave 0 (Scout):
        software-architect audits the target module in read-only mode.
        Produces: .graphkit/evidence/scout-report.md

        Wave 1 (Parallel Fan-Out):
        Worker A audits authentication security in worktree-A.
        Worker B audits database query performance in worktree-B.
        Both run concurrently without git conflicts.
        Produces: .graphkit/evidence/security.md, .graphkit/evidence/perf.md

        Wave Barrier:
        Worktree branches merge back to main. Any conflict halts before synthesis.

        Wave 2 (Synthesize):
        lead-engineer consolidates findings into a unified fix proposal.
        Produces: .graphkit/evidence/summary.md

You:    gk gate graph.yaml

Gate:   [PASS] scout-report.md (fresh, non-empty, sha256: 4e8a...)
        [PASS] security.md     (fresh, non-empty, sha256: d19c...)
        [PASS] perf.md         (fresh, non-empty, sha256: 82ab...)
        [PASS] summary.md      (fresh, non-empty, sha256: f012...)
        
        VERDICT: MERGE (exit 0)
```

---

## What changes in agent behavior

| Failure mode | GraphKit mechanism |
|---|---|
| Agent claims "Done!" with broken tests | `gk gate` blocks completion without declared machine-checked evidence files |
| Agents overwrite each other's code | `--worktree` runs write-nodes in isolated worktrees with wave barrier merges |
| Retries loop indefinitely burning budget | `no_progress_limit` fingerprints failed rounds and exits early on identical errors |
| Agent improvises steps outside the plan | Topology compiler enforces strict wave sequence; edges cannot be bypassed |
| Context gets stuffed with outdated facts | Salience-ranked project memory (`gk memory recall`) retrieves only relevant context |
| Crashed run requires full restart | `gk run resume` keeps verified predecessor outputs and re-executes only pending nodes |
| Host tool permissions elevated in secret | Per-node `constraints` (`no_write`, `no_exec`, `tools_allowlist`) restrict agent capabilities |

---

## Eleven canonical topologies

Workflows compile from eleven proven topological patterns:

| Topology | Shape | Best for |
|---|---|---|
| **diamond** | fan-out → reduce → synthesize | Code audits, architecture reviews, research sweeps |
| **classify-and-act** | route one input to one handler | Bug triage, ticket routing, specialized handling |
| **adversarial-verification** | produce → refute → adjudicate | Security audits, mission-critical changes, fact-checking |
| **loop-until-done** | scout → work → dedup until clean | Lint sweeps, migration passes, deprecation cleanup |
| **generate-and-filter** | generate many → evaluate → keep top K | API naming, design variations, prompt optimization |
| **tournament** | pairwise bracket elimination | Model comparison, prompt benchmark evals |
| **memory-augmented** | wrap any graph with recall + curation | Complex multi-turn tasks requiring institutional memory |
| **sdd** | brainstorm → plan → parallel workers → review → test | Subagent-driven feature development |
| **superpowers** | brainstorm → plan → workers → test loop | Rapid prototyping with tight feedback cycles |
| **research-and-build** | scout → research → plan → build → review | Research-first exploratory features |
| **custom** | arbitrary DAG via `depend_on` | Specialized team workflows and hybrid compositions |

---

## Core capabilities

### 1. Evidence gates (`gk gate`)

Before marking a workflow complete, the orchestrator evaluates declared evidence:

```yaml
evidence:
  required_keys: [unit-tests, security-audit]
  criteria: [unit-tests, security-audit] # criteria/<id>.md
  freshness: strict                     # strict | report
```

```bash
# Add content-addressed artifact with cryptographic provenance:
gk evidence add test-results.json --key unit-tests --node test-runner

# Run deterministic gate evaluation:
gk gate graph.yaml
# → Exit 0: MERGE (all keys exist, non-empty, fresh)
# → Exit 1: BLOCK (missing keys, whitespace-only, or stale under strict mode)

# Generate self-contained HTML evidence report:
gk evidence report --html
```

### 2. Bounded loops & no-progress exhaustion

Avoid runaway loops when agents get stuck on the same failing state:

```yaml
loops:
  - nodes: [implement, run-tests]
    max_rounds: 5
    stop_when: "all unit tests pass"
    gate_evidence: [unit-tests]
    no_progress_limit: 2 # stop early if 2 consecutive rounds fail identically
```

After each iteration, `gk run round <group-index>` fingerprints node statuses and evidence sha256 digests. If the state matches `no_progress_limit` times in a row, the loop exhausts immediately with `stop_reason: "no_progress"` — saving tokens and signaling human intervention.

### 3. Checkpoint resume (`gk run resume`)

If a run fails or crashes mid-way, resume without restarting from scratch:

```bash
# Preview what would be reused vs re-executed:
gk run resume <run-id> --dry-run

# Reconcile evidence, prune completed nodes, and run remaining work:
gk run resume <run-id>
```

Satisfied nodes retain their verified evidence markers and attach to downstream nodes as read-only references (`refs`).

### 4. Interactive architecture diagrams (`/gk:visualize`)

Render your `graph.yaml` as an explorable, standalone HTML diagram via [Archify](https://github.com/tt-a1i/archify):

```bash
# In your agent session:
/gk:visualize

# Or export from CLI:
gk graph ascii graph.yaml    # in-terminal ASCII
gk graph svg graph.yaml      # vector SVG export
```

HTML diagrams include animated signal trace motion, wave columns, model tier lanes, pan/zoom, and dark/light themes.

### 5. Cross-session project memory (`gk memory`)

Store and retrieve project decisions, recurring bug patterns, and conventions without polluting prompt context:

```bash
# Search salience-ranked memories (ACT-R decay curve):
gk memory recall "database migration conventions"

# Reinforce a memory when applied:
gk memory touch <memory-id>

# Run background consolidation pass:
gk memory consolidate
```

---

## Works across coding agents

One `gk init` command configures all five host targets:

| Host | Init target | Rule format | Agents | Skills | Execution path |
|---|---|---|---|---|---|
| **Claude Code** | `gk init` | `.claude/rules/` | `.claude/agents/` | `.claude/skills/` | `/gk:run` (Workflow tool) & `/gk:execute` |
| **Cursor** | `gk init --target cursor` | `.cursor/rules/*.mdc` | `.cursor/agents/` | `.cursor/skills/` | `/gk:execute` (Task tool dispatch) |
| **OpenCode** | `gk init --target opencode` | `AGENTS.md` | `.opencode/agent/` | `.opencode/skill/` | `/gk:execute` (Task tool dispatch) |
| **Codex CLI** | `gk init --target codex` | `AGENTS.md` | `.codex/agents/` | `.agents/skills/` | `/gk:execute` (Spawn-prompt driven) |
| **Pi (OMP)** | `gk init --target pi` | `AGENTS.md` | `.omp/agents/` | `.omp/skills/` | `/skill:gk-execute` (`gk_dispatch_agent`) |

---

## How is this different?

| | Static rules files (`CLAUDE.md`, `.cursorrules`) | LLM Swarm / Agent Frameworks | GraphKit |
|---|---|---|---|
| **Execution structure** | Unstructured prompts | Non-deterministic agent-to-agent chatter | Deterministic, wave-ordered DAGs |
| **Completion proof** | Agent declares "done" | Agent conversation finishes | Cryptographically-hashed evidence gate |
| **Parallel safety** | Blind edits in working tree | Unchecked file collisions | Git worktree isolation per write node |
| **Loop control** | Ad-hoc prompt instructions | Often unbound; risk runaway costs | Hard `max_rounds` + `no_progress_limit` |
| **Recovery** | Restart session from zero | State lost on crash | Reconciled checkpoint resume |
| **Runtime footprint** | None | Heavy cloud SDKs / daemon | Zero-model local CLI compiler |

---

## What this isn't

- **Not an LLM model runner.** GraphKit never invokes models directly or bills API tokens; execution runs through your host coding agent.
- **Not a black-box cloud service.** GraphKit is 100% local, MIT-licensed, and inspectable. Your graphs, runs, and memories live in git-friendly plain files in `.graphkit/`.
- **Not an unconstrained autonomous swarm.** Nodes cannot schedule arbitrary successors, spawn unsanctioned tools, or edit their own execution topology.
- **Not a replacement for your editor.** GraphKit enhances Claude Code, Cursor, OpenCode, Codex, and Pi — giving them the coordination layer they lack.

---

## CLI reference

```text
$ gk --help

  gk/0.3.21

  Usage:
    $ gk <command> [options]

  Commands:
    init                             Install GraphKit into the current project
    new                              Scaffold a new project with GraphKit
    gate [file]                      Deterministic evidence gate: MERGE/BLOCK
    validate [file]                  Validate graph.yaml against 9 static rules
    compile [file]                   Compile graph.yaml to .workflow.js (Claude)
    graph [subcommand]               Graph operations (ascii, svg, waves, new...)
    evidence [subcommand]            Evidence management (add, report)
    run [subcommand]                 Run ledger (start, node, round, resume, end)
    template [subcommand]            Template gallery (list, materialize, pack)
    memory [subcommand]              Project memory (recall, touch, consolidate)
    inventory                        List installed agents, skills, and tools
    status                           Active run metadata and evidence coverage
```

---

## Documentation & resources

- **Live Documentation Site:** [thanhnt16.github.io/graph-kit](https://thanhnt16.github.io/graph-kit/)
- **Changelog:** [CHANGELOG.md](./CHANGELOG.md)
- **Worktree Merge Protocol:** [docs/worktree-merge-protocol.md](./docs/worktree-merge-protocol.md)
- **Interactive Diagram Gallery:** [docs/diagrams/](./docs/diagrams/)

```bash
# Build from source
git clone https://github.com/thanhNt16/graph-kit.git
cd graph-kit
bun install && bun run ci:local
```

## License

MIT © [thanhNt16](https://github.com/thanhNt16)
