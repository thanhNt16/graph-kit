# GraphKit v2 — Graph Engineering Kit for Claude Code

**For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform GraphKit from a standalone CLI workflow engine into a ClaudeKit-style kit template — a `claude/` scaffold of agents, skills, hooks, and rules that lets users define, validate, compile, and execute graph engineering workflows through Claude Code's native dynamic workflows.

**Architecture:** Three layers — Kit Template (`claude/`) provides agents, skills, hooks, and rules. gk CLI v2 validates and compiles graph YAML into `.workflow.js` scripts. Claude Code Workflows executes those scripts using `agent()`, `parallel()`, `pipeline()`.

**Tech Stack:** TypeScript (Bun runtime), Node.js hooks (.cjs), YAML (graph definitions), Excalidraw (visualization), Claude Code dynamic workflows (runtime).

## Global Constraints

- gk CLI never invokes a model, spawns an agent, or reads an API key — it validates and compiles only
- Claude Code Workflows owns all runtime execution — no custom state machine
- All 6 canonical graph topologies ship in v1: diamond, classify-and-act, adversarial-verification, loop-until-done, generate-and-filter, tournament
- Kit agents inherit from agency-agents (markdown + YAML frontmatter format)
- Kit install mechanism follows claudekit-engineer pattern (claude/ → .claude/ copy with metadata.json tracking)
- Hooks are fail-open (.cjs), never crash the session
- Skills use SKILL.md frontmatter contract (name, description, when_to_use, user-invocable)
- Graph YAML is the single source of truth — compiled output is derived, never hand-edited
- Per-node model tiering: opus for judgment, sonnet for implementation, haiku for verification, fable for specialized tasks
- `depend_on` controls parallelism — empty deps start immediately, shared deps run parallel, multiple deps wait at barrier
- Subgraph composition: topology templates can reference other topology templates as nested subgraphs
- Validation is a gate before compile — syntax, schema, topology contract, agent binding, refs, acyclic deps, evidence keys, loop exits, constraint types

---

## Section 1: Architecture

### Three-Layer Model

**Layer 1 — Kit Template (`claude/`)**: Installed by `gk init` into the user's `.claude/` directory. Contains 7 agents, 8 skills (+ vendored excalidraw-diagram), 3 hooks, 3 rules, JSON schemas, and 6 topology workflow templates.

**Layer 2 — gk CLI v2**: A compiler and installer. Commands: `gk init` (install kit), `gk new` (scaffold project + install), `gk validate` (check graph YAML), `gk compile` (YAML → .workflow.js), `gk graph list/inspect` (topology catalog). No runtime — no state machine, no leases, no checkpoints.

**Layer 3 — Claude Code Runtime**: The compiled `.workflow.js` executes via Claude Code's Workflow tool. Uses `agent()` for single workers, `parallel()` for fan-out, `pipeline()` for streaming stages. Each node's model, tools, skills, and refs come from the graph YAML definition.

### User Session Flow

1. `/gk:init-graph --template diamond` → generates `graph.yaml`
2. `/gk:visualize` → renders graph structure
3. User edits `graph.yaml` (binds agents, configures nodes)
4. `/gk:brainstorm` → agent asks clarifying Qs, updates graph.yaml
5. `/gk:visualize` → see updated structure
6. `/gk:validate` → gate check (syntax, schema, topology, agents, refs, deps, evidence)
7. `/gk:compile` → `.claude/workflows/{name}.workflow.js`
8. `/gk:run` → invoke Claude Code Workflow tool
9. `/gk:evidence` → report results

---

## Section 2: Graph Topologies

Six canonical topologies, each a parameterized `.workflow.js` template under `claude/templates/`. Templates compose via subgraph references.

### 2.1 Diamond (fan-out → reduce → synthesize)

Fan-out work to N parallel workers, reduce results with deterministic code (dedup, rank), synthesize with one high-tier agent. The most common pattern for code review, research, and migrations.

**Workflow mapping**: `pipeline(items, fanout, reduce, synthesize)`

**Topo config keys**: `fanout.strategy`, `fanout.isolation`, `reduce` (dedup|rank|dedup+rank), `verify` (subgraph ref to adversarial-verification), `synthesizer`

### 2.2 Classify-and-Act (routing)

A classifier inspects input and routes to exactly one handler. Each handler is a different agent. Includes a fallback for inputs that match no category.

**Workflow mapping**: `agent(classify) → route → agent(handler)`

**Topo config keys**: `classifier`, `routes[].handler`, `routes[].condition`, `fallback`

### 2.3 Adversarial Verification

A producer generates items. Each item gets its own bracket of independent refuters with fresh context. An adjudicator checks votes — items surviving ≥ threshold are kept. Verifiers must be genuinely different from producer (different model, different training corpus).

**Workflow mapping**: `agent(produce) → parallel(refuters) → adjudicate`

**Topo config keys**: `producer`, `refuters[]`, `survive_threshold` (default 2), `adjudicator`

### 2.4 Loop Until Done

For tasks of unknown size. A scouter discovers work items, a batch of workers processes them, results are deduped. Loop continues until K consecutive rounds return nothing new (loop-until-dry). Budget and max-rounds as safety caps.

**Workflow mapping**: `while (!dry && budget > 0) { agent(scout) → parallel(work) → dedup }`

**Topo config keys**: `scouter`, `worker_batch`, `stop_rule` (dry_rounds|budget|count), `dedup`, `dry_threshold` (default 2)

### 2.5 Generate-and-Filter

Multiple generators propose candidates. A rubric scores and deduplicates in one deterministic pass. Keep top-K. Reduce step is code, not agent.

**Workflow mapping**: `parallel(generators) → score(dedup) → keep(K)`

**Topo config keys**: `generators[]`, `rubric`, `keep_top`, `dedup_keys`

### 2.6 Tournament

N candidates compete in pairwise judged rounds. A judge agent compares two at a time. Rounds continue until one champion remains (or full ordering via tournament-sort).

**Workflow mapping**: `round(candidates) → while(n > 1) { pair(judge) }`

**Topo config keys**: `candidates[]`, `judge`, `rounds` (optional, auto until champion)

### 2.7 Subgraph Composition

Templates reference other templates as subgraphs via the `template` field in topo_config. The compiler resolves these references and expands them inline. Example: diamond with adversarial verification inside each fan-out worker.

```yaml
topology: diamond
topology_config:
  fanout:
    template: adversarial-verification
    refuters: [QA Engineer, Security Engineer]
    survive_threshold: 2
  synthesizer: Software Architect
```

---

## Section 3: Graph YAML Schema

The user-facing graph definition. Validates against `claude/schemas/graph.schema.json`.

### 3.1 Root Schema

```yaml
apiVersion: graphkit.dev/v2
kind: Graph
metadata:
  name: string              # required
  description: string       # optional

topology: string            # one of 6 canonical names (required)

inputs:                      # what the user provides
  <name>:
    type: string|array
    required: boolean
    default: any

nodes:                       # rich per-node configuration (required)
  <role>:
    agent: string            # kit agent name from claude/agents/
    model: string            # opus|sonnet|haiku|fable
    objective: string        # prompt injected into agent context
    tools: string[]          # available tools: Read, Write, Edit, Bash, Glob, Grep
    skills: string[]          # loaded from .claude/skills/
    refs:                    # reference docs loaded into context
      - path: string         # file path relative to project root
        purpose: string       # why this doc matters for this node
    depend_on: string[]      # node roles this waits for (empty = immediate)
    loop:                    # internal loop-until-done
      enabled: boolean
      stop_when: string      # natural language exit condition
      max_rounds: integer    # safety cap (default 3)
      exit_condition: string # detailed condition for the agent
    constraints:             # per-node guardrails
      - key: value           # no_write, max_files, assigned_only, etc.
    evidence: string[]      # what this node produces

limits:
  max_workers: integer
  max_iterations: integer
  max_findings: integer     # topology-specific
  budget_tokens: integer

evidence:
  required_keys: string[]   # must be produced by terminal nodes
  format: string            # markdown|json

topology_config:             # topology-specific parameters (see Section 2; validated by claude/schemas/topology/<name>.schema.json)
  ...

hooks:                       # lifecycle hooks
  on_node_complete: string[]
  on_fanout_dispatch: string[]
  on_graph_complete: string[]

outputs:
  evidence_dir: string      # default .graphkit/evidence/
  report: string             # default .graphkit/reports/{name}.md
```

### 3.2 Node Binding Fields

| Field | Required | Description |
|---|---|---|
| `agent` | yes | Kit agent name (must exist in `claude/agents/`) |
| `model` | no | Default from agent frontmatter, overridden here |
| `objective` | yes | Prompt for the agent, injected at node start |
| `tools` | no | Default to agent's tool set, scoped here |
| `skills` | no | Kit skills loaded into the subagent's context |
| `refs` | no | Documents read and injected as context with purpose label |
| `depend_on` | no | Empty array = starts immediately |
| `loop` | no | Internal loop config; if enabled, the node runs a loop-until-done internally |
| `constraints` | no | Per-node rules (no_write, max_files, assigned_only, max_findings_per_file) |
| `evidence` | no | Output keys this node produces for downstream nodes |

### 3.3 depend_on Controls Parallelism

- Empty `depend_on`: node starts immediately with other zero-dependency nodes
- Single `depend_on`: waits for that specific node
- Multiple `depend_on`: barrier — waits for all listed nodes to complete
- Shared dependencies: nodes depending on the same source run in parallel

The compiler resolves `depend_on` into `parallel()` vs sequential calls in the workflow script.

### 3.4 What Changed from v1

- v1 asked users to define every node, edge, condition, and merge policy (~60 lines YAML minimum). gk CLI owned the runtime.
- v2 asks users to pick a topology, bind agents, and configure params (~20 lines for common cases). Templates handle graph structure. Claude Code Workflows own runtime.
- v1 had 8 node types and an expression engine. v2 has the topology template system with subgraph composition.

---

## Section 4: Kit Agents — Engineering Team

Seven agents inherited from agency-agents, adapted for graph node binding.

### 4.1 Agent Definition Format

ClaudeKit-style markdown with YAML frontmatter in `claude/agents/`:

```yaml
---
name: Software Architect
description: System design, DDD, trade-off analysis
model: opus
graph_roles: [scouter, planner, synthesizer]
evidence_keys: [architecture_decisions, trade_offs]
source: agency-agents/engineering-software-architect
---
```

Body contains two sections:
1. **Identity & Mission** — inherited from agency-agents (core mission, critical rules, technical deliverables, workflow process)
2. **Graph Node Behavior** — auto-generated: how this agent behaves when bound to a graph node (reads objective, refs, constraints; respects depend_on; produces declared evidence)

### 4.2 Agent Roster

| Agent | Source | Graph Roles | Default Model | Evidence Keys |
|---|---|---|---|---|
| Software Architect | engineering-software-architect | scouter, planner, synthesizer | opus | architecture_decisions, trade_offs, context_map |
| Code Reviewer | engineering-code-reviewer | worker, verifier | sonnet | findings, severity, remediation, lines_affected |
| QA Engineer | testing-evidence-collector + model-qa | verifier, worker | haiku | test_results, bug_reports, coverage_gaps |
| Data Engineer | engineering-data-engineer | worker, scouter | sonnet | schema_changes, data_quality, migration_plan |
| UI Designer / UX Researcher | design-ux-researcher + design-ui-designer | worker, synthesizer | sonnet | design_specs, accessibility_audit, user_flows |
| Agents Orchestrator | specialized-agents-orchestrator | scouter, synthesizer | opus | task_breakdown, agent_assignments, orchestration_log |
| Document Generator | specialized-document-generator | synthesizer, worker | sonnet | report, executive_summary, recommendations |

### 4.3 Custom Agents

Users add agents to `claude/agents/` following the same format. Available in graph.yaml immediately. No registration step needed.

---

## Section 5: Session Skills — 8 Total

Installed into `.claude/skills/` by `gk init`. Invoked via `/gk:*`.

| Skill | Model | Purpose |
|---|---|---|
| `gk:init-graph` | sonnet | Generate graph.yaml from a template. If --template omitted, agent suggests topology based on user's description. |
| `gk:brainstorm` | sonnet | Refine graph.yaml via dialogue. Asks clarifying questions, suggests agent/model choices, updates node config. |
| `gk:visualize` | sonnet | Render graph.yaml as Excalidraw diagram. Nodes color-coded by model tier. Shows depend_on edges, loop indicators, subgraph boundaries, evidence flow. Persists as .excalidraw. |
| `gk:validate` | haiku | Gate check: syntax, schema, topology contract, agent binding, refs exist, depend_on acyclic, evidence keys, loop exit conditions, constraint types. |
| `gk:compile` | sonnet | Parse YAML, resolve topology template, inject agent prompts, expand subgraph refs, generate .workflow.js. |
| `gk:run` | varies | Invoke Claude Code Workflow tool with compiled script. Node model set per graph.yaml. |
| `gk:evidence` | haiku | Report what the graph produced. Node results, evidence keys, verdict, timing. |
| `gk:status` | none | Show current graph run state. Reads state files. |

Plus vendored `excalidraw-diagram` skill from coleam00/excalidraw-diagram-skill for the visualize skill's render pipeline.

---

## Section 6: Hooks

Three graph-specific hooks in `claude/hooks/`, following claudekit's fail-open .cjs pattern.

| Hook | Event | Purpose |
|---|---|---|
| `graph-state-guard.cjs` | PreToolUse | Before write operations in graph workflows, validate graph state consistency. Prevent writes to evidence files during active runs. |
| `evidence-persist.cjs` | PostToolUse | After node completion, auto-persist evidence to `.graphkit/evidence/`. Structured markdown per evidence key. |
| `lease-enforce.cjs` | SubagentStart | Inject lease context into worker subagents. Validate lease hasn't expired. Enforce assigned-only constraint. |

---

## Section 7: Rules

Three rules in `claude/rules/`:

### graph-authority.md
gk owns graph state. Never improvise edges, skip nodes, or modify topology at runtime. The compiled workflow is the execution plan — agents follow it.

### agent-binding.md
Agent names in graph.yaml must match files in `claude/agents/`. If a bound agent doesn't exist, fail validation with a helpful message listing available agents.

### topology-routing.md
Decision tree for selecting which topology to suggest in `/gk:init-graph`. Based on user's description: "audit/review" → adversarial-verification or diamond; "triage/route" → classify-and-act; "discovery/sweep" → loop-until-done; "brainstorm/naming" → generate-and-filter or tournament.

---

## Section 8: Kit Template Structure

```
claude/
├── settings.json
├── metadata.json
├── .gk.json
├── agents/                          # 7 kit agents
├── skills/                          # 8 graph skills + vendored excalidraw
├── hooks/                           # 3 graph hooks
├── rules/                           # 3 graph rules
├── schemas/                         # validation JSON schemas
│   ├── graph.schema.json
│   ├── node.schema.json
│   └── topology/                    # per-topology contract schemas
└── templates/                       # 6 .workflow.js topology templates
```

---

## Section 9: ClaudeKit Reuse

### Adopt Directly
- Kit install mechanism (claude/ → .claude/ copy, metadata.json deletions)
- Hook architecture (fail-open .cjs, event slots, naming)
- Agent definition format (markdown + YAML frontmatter)
- SKILL.md contract (frontmatter, references/ pattern)
- Validation CI scripts pattern (lint + cross-refs + routing)
- Skill routing rules (domain + workflow decision trees)
- portable-manifest.json (multi-provider path migrations)
- Release pipeline (commitlint + semantic-release)

### Adapt for GraphKit
- settings.json hooks (same events, graph-specific logic)
- Rules content (graph-authority vs development-rules)
- Domain routing (graph state-based vs ck:* commands)
- .gkignore (same concept, graph artifacts)
- Environment resolver (7-tier hierarchy, directly reusable)
- Skill-native task management (hydration/sync-back for graph runs)

### Skip
- 90+ domain skills (GraphKit has 8 graph-specific skills)
- Agent Teams experimental (Workflows handle parallelism)
- GEMINI.md / multi-provider prompts (v1 scope)
- Cook/orchestration skills (graph-driven, not cook-driven)

---

## Section 10: gk CLI v2 Commands

### Kit Installation
- `gk init` — install kit template into current project's .claude/
- `gk new --dir <path>` — scaffold new project + install kit

### Graph Lifecycle
- `gk validate [graph.yaml]` — validate graph YAML against schema + topology contract
- `gk compile [graph.yaml] --output <path>` — compile to .workflow.js
- `gk graph list` — list available topologies with descriptions
- `gk graph inspect <topology>` — show one topology's contract and config keys

### NOT in gk CLI v2
All v1 runtime commands removed: workflow start/next/submit/execute, leases, checkpoints, events, state machine, expression engine, merges. Runtime is Claude Code Workflows only.

---

## Section 11: Testing Strategy

### Unit Tests
- Graph YAML parser and validator (schema, topology contract, node binding, acyclic deps)
- Compiler (YAML → .workflow.js output for each topology)
- Hook logic (graph-state-guard, evidence-persist, lease-enforce)

### Integration Tests
- Full flow: init-graph → brainstorm → validate → compile → verify .workflow.js structure
- Subgraph composition: diamond referencing adversarial-verification
- Agent binding: validate agent names resolve to claude/agents/ files

### Acceptance Criteria
- AC01: `gk init` installs claude/ with all 7 agents, 8 skills, 3 hooks, 3 rules
- AC02: `gk validate` rejects invalid graph.yaml with specific error messages
- AC03: `gk compile` produces valid .workflow.js for all 6 topologies
- AC04: `gk compile` resolves subgraph references correctly
- AC05: `/gk:visualize` produces .excalidraw file with correct node/edge rendering
- AC06: `gk validate` detects acyclic dependency violations
- AC07: `gk validate` detects missing refs (files that don't exist)
- AC08: `/gk:init-graph --template diamond` produces valid graph.yaml
- AC09: `/gk:brainstorm` updates graph.yaml with user's answers
- AC10: Model tiering in graph.yaml propagates to compiled .workflow.js

---

## Section 12: Multi-Provider (Future)

v1 scope is Claude Code only. The portable-manifest.json mechanism from claudekit-engineer is adopted for future provider support (Codex, Gemini CLI, Cursor, Windsurf). Agent definitions are markdown — portable across any LLM platform. The excalidraw visual output is provider-agnostic.
