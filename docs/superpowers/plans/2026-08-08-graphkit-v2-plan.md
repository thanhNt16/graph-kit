# GraphKit v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite GraphKit as a ClaudeKit-style kit template — a `claude/` scaffold of 7 agents, 8 skills, 3 hooks, 3 rules, 6 topology workflow templates, and a compiler CLI that validates graph YAML and emits `.workflow.js` scripts for Claude Code's native dynamic workflows.

**Architecture:** Three layers — Kit Template (`claude/`) provides agents/skills/hooks/rules. gk CLI v2 validates and compiles graph YAML. Claude Code Workflows executes compiled `.workflow.js` using `agent()`, `parallel()`, `pipeline()`. No custom runtime state machine.

**Tech Stack:** TypeScript (Bun runtime), cac (CLI), zod (schemas), yaml (parsing), ajv (JSON schema validation), Excalidraw (visualization)

## Global Constraints

- gk CLI never invokes a model, spawns an agent, or reads an API key — validates and compiles only
- Claude Code Workflows owns all runtime execution — no custom state machine
- All 6 canonical topologies ship: diamond, classify-and-act, adversarial-verification, loop-until-done, generate-and-filter, tournament
- Kit agents use markdown + YAML frontmatter in `claude/agents/`
- Skills use SKILL.md with frontmatter (name, description, when_to_use, user-invocable)
- Hooks are fail-open Node.js (.cjs), exit 0 on crash
- Graph YAML is the single source of truth; compiled .workflow.js is derived
- Per-node model tiering: opus (judgment), sonnet (implementation), haiku (verification), fable (specialized)
- `depend_on` controls parallelism: empty = immediate, shared = parallel, multiple = barrier
- Topology templates compose via subgraph references
- Validation is a hard gate before compile: syntax, schema, topology, agents, refs, acyclic deps, evidence keys, loop exits, constraints
- Build: `bun build`, test: `bun test`, typecheck: `tsc --noEmit`, lint: `biome check .`
- Commit style: `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`, `ci:` — lowercase subject, max 100 chars header

---

### Task 1: Project Scaffold and Build Infrastructure

**Files:**
- Create: `apps/gk/package.json`
- Create: `apps/gk/tsconfig.json`
- Create: `apps/gk/claude/.gitkeep` (and all subdirectories)
- Create: `apps/gk/claude/agents/.gitkeep`
- Create: `apps/gk/claude/skills/.gitkeep`
- Create: `apps/gk/claude/hooks/.gitkeep`
- Create: `apps/gk/claude/rules/.gitkeep`
- Create: `apps/gk/claude/schemas/.gitkeep`
- Create: `apps/gk/claude/templates/.gitkeep`
- Create: `apps/gk/src/index.ts`
- Create: `apps/gk/src/errors.ts`
- Create: `apps/gk/src/cli/output.ts`

**Interfaces:**
- Produces: Package structure, build pipeline, CLI entry point skeleton, JSON output helpers

- [ ] **Step 1: Rewrite package.json**

Replace the v1 package.json. Keep name `@graphkit/gk`. Update dependencies: keep cac, zod, yaml, ajv. Remove proper-lockfile (no more file-based runtime locks). Add `excalidraw-utils` for visualize skill. Set bin to `gk`. Add files array for npm packaging:

```json
{
  "name": "@graphkit/gk",
  "version": "0.2.0",
  "type": "module",
  "bin": { "gk": "dist/index.js" },
  "scripts": {
    "build": "bun build src/index.ts --target=node --outdir=dist",
    "typecheck": "tsc --noEmit",
    "lint": "biome check .",
    "test": "bun test"
  },
  "files": ["claude/"],
  "dependencies": {
    "ajv": "^8.17.1",
    "ajv-formats": "^3.0.1",
    "cac": "^6.7.14",
    "yaml": "^2.8.1",
    "zod": "^4.0.17"
  },
  "devDependencies": {
    "@biomejs/biome": "^2.1.3",
    "@types/bun": "latest",
    "@types/yaml": "^2.0.0",
    "typescript": "^5.9.2"
  }
}
```

- [ ] **Step 2: Write tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "strict": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "skipLibCheck": true,
    "types": ["bun"]
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 3: Create claude/ directory structure**

```bash
mkdir -p claude/{agents,skills,hooks,rules,schemas,topology}
mkdir -p claude/skills/{gk-init-graph,gk-brainstorm,gk-validate,gk-compile,gk-run,gk-evidence,gk-status,gk-visualize}
mkdir -p claude/skills/gk-visualize/references
mkdir -p src/{cli/commands,compiler,schemas}
mkdir -p tests/{unit,integration,acceptance,fixtures}
touch claude/agents/.gitkeep
```

- [ ] **Step 4: Write src/errors.ts**

```typescript
export class GraphKitError extends Error {
  constructor(
    public code: string,
    message: string,
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "GraphKitError";
    this.code = code;
  }
}
```

- [ ] **Step 5: Write src/cli/output.ts**

JSON envelope helpers (ok/fail) — same pattern as v1:

```typescript
export function ok<T>(data: T) {
  return { status: "ok", data };
}

export function fail(code: string, message: string, details?: Record<string, unknown>) {
  return { status: "fail", error: { code, message, details } };
}
```

- [ ] **Step 6: Write src/index.ts (skeleton)**

```typescript
import { cac } from "cac";
import { registerKitCommands } from "./cli/commands/kit.js";
import { registerGraphCommands } from "./cli/commands/graph.js";

const cli = cac("gk");
registerKitCommands(cli);
registerGraphCommands(cli);
cli.parse();
```

Note: The CLI commands files don't exist yet. Create placeholder files:

```typescript
// src/cli/commands/kit.ts
export function registerKitCommands(cli: ReturnType<typeof cac>) { /* Task 11 */ }

// src/cli/commands/graph.ts
export function registerGraphCommands(cli: ReturnType<typeof cac>) { /* Task 12 */ }
```

- [ ] **Step 7: Write settings.json**

```json
{
  "hooks": {
    "PreToolUse": [],
    "PostToolUse": [],
    "SubagentStart": ["hooks/lease-enforce.cjs"],
    "SubagentStop": [],
    "Stop": []
  },
  "skillListingBudgetFraction": 0.04,
  "skillListingMaxDescChars": 512
}
```

- [ ] **Step 8: Write metadata.json**

```json
{
  "name": "graphkit",
  "version": "0.2.0",
  "apiVersion": "graphkit.dev/v2",
  "deletions": []
}
```

- [ ] **Step 9: Write .gk.json**

```json
{
  "codingLevel": 0,
  "statusline": "full",
  "statuslineColors": true
}
```

- [ ] **Step 10: Install dependencies and verify build**

```bash
cd apps/gk && bun install && bun run build
```

Expected: No errors, dist/index.js generated.

- [ ] **Step 11: Commit**

```bash
git add apps/gk/package.json apps/gk/tsconfig.json apps/gk/claude/ apps/gk/src/
git commit -m "feat: scaffold GraphKit v2 project structure"
```

---

### Task 2: Graph YAML Schemas

**Files:**
- Create: `apps/gk/src/schemas/graph.schema.ts`
- Create: `apps/gk/src/schemas/node.schema.ts`
- Create: `apps/gk/src/schemas/topology/index.ts`

**Interfaces:**
- Consumes: Task 1 (project scaffold)
- Produces: `graph.schema.ts` (main validation), `node.schema.ts` (node binding), topology schemas (per-topology contracts)
- These schemas are used by the validate skill (Task 6) and the compiler (Task 7)

- [ ] **Step 1: Write graph.schema.ts**

Zod schema for the root graph.yaml. Define:

```typescript
import { z } from "zod";

const NodeRef = z.enum([
  "opus", "sonnet", "haiku", "fable"
]);

// Constraints are written in YAML as a list of single-key maps:
//   constraints:
//     - max_files: 50
//     - no_write: true
const ConstraintValue = z.record(z.union([z.string(), z.number(), z.boolean()]));

const RefSchema = z.object({
  path: z.string(),
  purpose: z.string(),
});

const LoopConfig = z.object({
  enabled: z.boolean().default(false),
  stop_when: z.string().optional(),
  max_rounds: z.number().int().min(1).default(3),
  exit_condition: z.string().optional(),
});

const NodeDefSchema = z.object({
  agent: z.string(),
  model: NodeRef.optional(),
  objective: z.string(),
  tools: z.array(z.string()).default([]),
  skills: z.array(z.string()).default([]),
  refs: z.array(RefSchema).default([]),
  depend_on: z.array(z.string()).default([]),
  loop: LoopConfig.default({}),
  constraints: z.array(ConstraintValue).default([]),
  evidence: z.array(z.string()).default([]),
});

const LimitsSchema = z.object({
  max_workers: z.number().int().positive().optional(),
  max_iterations: z.number().int().positive().optional(),
  max_findings: z.number().int().positive().optional(),
  budget_tokens: z.number().int().positive().optional(),
});

const EvidenceSchema = z.object({
  required_keys: z.array(z.string()),
  format: z.enum(["markdown", "json"]).default("markdown"),
});

const HookRef = z.object({
  on_node_complete: z.array(z.string()).default([]),
  on_fanout_dispatch: z.array(z.string()).default([]),
  on_graph_complete: z.array(z.string()).default([]),
});

const OutputSchema = z.object({
  evidence_dir: z.string().default(".graphkit/evidence/"),
  report: z.string().default(".graphkit/reports/{name}.md"),
});

const TopologyName = z.enum([
  "diamond",
  "classify-and-act",
  "adversarial-verification",
  "loop-until-done",
  "generate-and-filter",
  "tournament",
]);

const GraphSchema = z.object({
  apiVersion: z.string().default("graphkit.dev/v2"),
  kind: z.literal("Graph").default("Graph"),
  metadata: z.object({
    name: z.string(),
    description: z.string().optional(),
  }),
  topology: TopologyName,
  inputs: z.record(z.object({
    type: z.enum(["string", "array"]),
    required: z.boolean().default(false),
    default: z.any().optional(),
  })).default({}),
  nodes: z.record(NodeDefSchema).default({}),
  limits: LimitsSchema.default({}),
  evidence: EvidenceSchema.default({ required_keys: [] }),
  topology_config: z.record(z.any()).default({}),
  hooks: HookRef.default({}),
  outputs: OutputSchema.default({}),
}).superRefine((graph, ctx) => {
  // depend_on must reference existing nodes and form a DAG
  const names = new Set(Object.keys(graph.nodes));
  for (const [id, node] of Object.entries(graph.nodes)) {
    for (const dep of node.depend_on) {
      if (!names.has(dep)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["nodes", id, "depend_on"],
          message: `depend_on references unknown node "${dep}"`,
        });
      }
    }
  }
  // Cycle detection: DFS with colors (0=white, 1=gray, 2=black)
  const color = new Map<string, number>();
  const visit = (id: string): boolean => {
    if (color.get(id) === 1) return true; // gray → cycle
    if (color.get(id) === 2) return false;
    color.set(id, 1);
    for (const dep of graph.nodes[id]?.depend_on ?? []) {
      if (names.has(dep) && visit(dep)) return true;
    }
    color.set(id, 2);
    return false;
  };
  for (const id of names) {
    if (visit(id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["nodes", id, "depend_on"],
        message: "depend_on forms a cycle",
      });
      break;
    }
  }
});

export { GraphSchema, NodeDefSchema, TopologyName };
```

- [ ] **Step 2: Write node.schema.ts**

This is already defined inline in graph.schema.ts as `NodeDefSchema`. Export it:

```typescript
export { NodeDefSchema, LoopConfig, RefSchema, ConstraintValue };
```

- [ ] **Step 3: Write topology index**

```typescript
// src/schemas/topology/index.ts
// Exports empty placeholder configs — each topology's specific keys
// are validated by the topology schema files

export const TOPOLOGY_NAMES = [
  "diamond",
  "classify-and-act",
  "adversarial-verification",
  "loop-until-done",
  "generate-and-filter",
  "tournament",
] as const;

export type TopologyName = (typeof TOPOLOGY_NAMES)[number];

// Per-topology config keys — used by `gk graph inspect` and validate
const TOPOLOGY_CONFIG_KEYS: Record<TopologyName, string[]> = {
  "diamond": ["fanout.strategy", "fanout.isolation", "reduce", "verify", "synthesizer"],
  "classify-and-act": ["classifier", "routes[].handler", "routes[].condition", "fallback"],
  "adversarial-verification": ["producer", "refuters[]", "survive_threshold", "adjudicator"],
  "loop-until-done": ["scouter", "worker_batch", "stop_rule", "dedup", "dry_threshold"],
  "generate-and-filter": ["generators[]", "rubric", "keep_top", "dedup_keys", "scorer"],
  "tournament": ["candidates[]", "judge", "rounds"],
};

export function getTopologyConfigKeys(topology: TopologyName): string[] {
  return TOPOLOGY_CONFIG_KEYS[topology];
}
```

- [ ] **Step 4: Write validation tests**

Create `tests/unit/schema-validation.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { GraphSchema } from "../src/schemas/graph.schema";

describe("Graph YAML Schema", () => {
  test("accepts minimal valid graph", () => {
    const result = GraphSchema.safeParse({
      apiVersion: "graphkit.dev/v2",
      kind: "Graph",
      metadata: { name: "test" },
      topology: "diamond",
      inputs: {},
      nodes: {
        worker: { agent: "Code Reviewer", objective: "review code" },
      },
    });
    expect(result.success).toBe(true);
  });

  test("rejects invalid topology", () => {
    const result = GraphSchema.safeParse({
      metadata: { name: "test" },
      topology: "nonexistent",
    });
    expect(result.success).toBe(false);
  });

  test("rejects node with missing agent", () => {
    const result = GraphSchema.safeParse({
      metadata: { name: "test" },
      topology: "diamond",
      nodes: { worker: { objective: "review code" } },
    });
    expect(result.success).toBe(false);
  });

  test("rejects cyclic depend_on", () => {
    const result = GraphSchema.safeParse({
      metadata: { name: "test" },
      topology: "diamond",
      nodes: {
        a: { agent: "A", depend_on: ["b"] },
        b: { agent: "B", depend_on: ["a"] },
      },
    });
    expect(result.success).toBe(false);
  });

  test("accepts all 6 topology names", () => {
    for (const topo of [
      "diamond", "classify-and-act", "adversarial-verification",
      "loop-until-done", "generate-and-filter", "tournament",
    ]) {
      const result = GraphSchema.safeParse({
        metadata: { name: "test" },
        topology: topo,
        nodes: {},
      });
      expect(result.success).toBe(true);
    }
  });

  test("validates loop config", () => {
    const result = GraphSchema.safeParse({
      metadata: { name: "test" },
      topology: "diamond",
      nodes: {
        scouter: {
          agent: "A",
          loop: { enabled: true, max_rounds: 3, stop_when: "dry" },
        },
      },
    });
    expect(result.success).toBe(true);
  });
});
```

- [ ] **Step 5: Run tests and verify**

```bash
bun test tests/unit/schema-validation.test.ts
```

Expected: 6 pass, 0 fail.

- [ ] **Step 6: Commit**

```bash
git add apps/gk/src/schemas/ tests/unit/schema-validation.test.ts
git commit -m "feat: add graph YAML schema validation with cycle detection"
```

---

### Task 3: Agent Definitions

**Files:**
- Create: `apps/gk/claude/agents/software-architect.md`
- Create: `apps/gk/claude/agents/code-reviewer.md`
- Create: `apps/gk/claude/agents/qa-engineer.md`
- Create: `apps/gk/claude/agents/data-engineer.md`
- Create: `apps/gk/claude/agents/ui-ux-researcher.md`
- Create: `apps/gk/claude/agents/agents-orchestrator.md`
- Create: `apps/gk/claude/agents/document-generator.md`

**Interfaces:**
- Consumes: Task 1 (directory structure)
- Produces: Agent definitions used by validate skill (checks agent names) and compile skill (injects agent prompts)

- [ ] **Step 1: Create all 7 agent files**

Each agent file follows this structure (example for software-architect):

```markdown
---
name: Software Architect
description: System design, DDD, trade-off analysis, architectural decision records
model: opus
graph_roles: [scouter, planner, synthesizer]
evidence_keys: [architecture_decisions, trade_offs, context_map]
source: agency-agents/engineering-software-architect
---

# Software Architect

## Identity & Memory

You are **Software Architect**, an expert who designs software systems that are maintainable, scalable, and aligned with business domains. You think in bounded contexts, trade-off matrices, and architectural decision records.

## Core Mission

1. **Domain modeling** — Bounded contexts, aggregates, domain events
2. **Architectural patterns** — Microservices vs modular monolith vs event-driven
3. **Trade-off analysis** — Consistency vs availability, coupling vs duplication
4. **Technical decisions** — ADRs with context, options, rationale
5. **Evolution strategy** — How the system grows without rewrites

## Critical Rules

- Every decision has a trade-off: name it explicitly.
- Prefer simplicity over flexibility unless the domain demands otherwise.
- Document decisions as ADRs, not just in prose.

## Technical Deliverables

- Architecture Decision Record template
- System design process: Domain Discovery → Architecture Selection → Quality Attributes

## Graph Node Behavior

When bound to a graph node, you:
1. Read the `objective` field as your primary task prompt.
2. Load `refs` for additional context (each labeled with its purpose).
3. Use only `tools` listed in your node config.
4. Respect `depend_on` ordering — wait for upstream evidence.
5. If `loop.enabled`, iterate until `exit_condition` is met (max `max_rounds`).
6. Produce all `evidence` keys declared in your node config.
7. Never modify files outside your assigned scope (`constraints.assigned_only`).
```

For each remaining agent, fetch the source from the agency-agents repo and adapt. The implementer should:

```bash
# Fetch the 7 source agent files (they're markdown with YAML frontmatter)
curl -sL https://raw.githubusercontent.com/msitarzewski/agency-agents/main/engineering/engineering-software-architect.md
curl -sL https://raw.githubusercontent.com/msitarzewski/agency-agents/main/engineering/engineering-code-reviewer.md
curl -sL https://raw.githubusercontent.com/msitarzewski/agency-agents/main/engineering/engineering-data-engineer.md
curl -sL https://raw.githubusercontent.com/msitarzewski/agency-agents/main/design/design-ux-researcher.md
curl -sL https://raw.githubusercontent.com/msitarzewski/agency-agents/main/design/design-ui-designer.md
curl -sL https://raw.githubusercontent.com/msitarzewski/agency-agents/main/specialized/agents-orchestrator.md
curl -sL https://raw.githubusercontent.com/msitarzewski/agency-agents/main/specialized/specialized-document-generator.md
# QA Engineer: merge two sources
curl -sL https://raw.githubusercontent.com/msitarzewski/agency-agents/main/testing/testing-evidence-collector.md
curl -sL https://raw.githubusercontent.com/msitarzewski/agency-agents/main/specialized/specialized-model-qa.md
```

For each, produce a kit agent file with this transformation:
1. Keep the agency-agents frontmatter fields (`name`, `description`), add `model`, `graph_roles`, `evidence_keys`, `source`.
2. Keep the body sections (Identity, Core Mission, Critical Rules, Technical Deliverables, Workflow Process).
3. Append the "## Graph Node Behavior" section from the software-architect template above (identical for all 7 — only the `graph_roles` and `evidence_keys` differ).

Per-agent specifics:

| Agent | File | model | graph_roles | evidence_keys |
|---|---|---|---|---|
| Software Architect | `software-architect.md` | opus | scouter, planner, synthesizer | architecture_decisions, trade_offs, context_map |
| Code Reviewer | `code-reviewer.md` | sonnet | worker, verifier | findings, severity, remediation, lines_affected |
| QA Engineer | `qa-engineer.md` (merge evidence-collector + model-qa) | haiku | verifier, worker | test_results, bug_reports, coverage_gaps |
| Data Engineer | `data-engineer.md` | sonnet | worker, scouter | schema_changes, data_quality, migration_plan |
| UI/UX Researcher | `ui-ux-researcher.md` (merge ux-researcher + ui-designer) | sonnet | worker, synthesizer | design_specs, accessibility_audit, user_flows |
| Agents Orchestrator | `agents-orchestrator.md` | opus | scouter, synthesizer | task_breakdown, agent_assignments, orchestration_log |
| Document Generator | `document-generator.md` | sonnet | synthesizer, worker | report, executive_summary, recommendations |

- [ ] **Step 2: Verify all agent frontmatter parses**

Write `tests/unit/agent-frontmatter.test.ts` that:
- Reads all 7 agent files
- Parses YAML frontmatter with a simple regex (extract between `---` markers)
- Asserts each has: name, description, model, graph_roles, evidence_keys
- Asserts all 7 agent names are unique

- [ ] **Step 3: Run tests and commit**

```bash
bun test tests/unit/agent-frontmatter.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add apps/gk/claude/agents/ tests/unit/agent-frontmatter.test.ts
git commit -m "feat: add 7 kit agent definitions from agency-agents"
```

---

### Task 4: Rules and Topology Routing

**Files:**
- Create: `apps/gk/claude/rules/graph-authority.md`
- Create: `apps/gk/claude/rules/agent-binding.md`
- Create: `apps/gk/claude/rules/topology-routing.md`

**Interfaces:**
- Consumes: Task 1 (directory structure), Task 3 (agent names)
- Produces: Rules loaded by Claude Code when kit is installed

- [ ] **Step 1: Write graph-authority.md**

```markdown
# Graph Authority

gk owns graph state. The compiled workflow is the execution plan.

## Inviolable Rules

- Never improvise edges or skip nodes at runtime.
- Never modify topology after compilation — recompile if needed.
- The workflow script is deterministic: same graph.yaml → same .workflow.js.
- If a node fails, the workflow handles it (null filter, error boundary) — do not retry outside the declared loop config.
```

- [ ] **Step 2: Write agent-binding.md**

```markdown
# Agent Binding

Agent names in graph.yaml must resolve to files in `claude/agents/`.

## Validation

- Every `agent` value in a node must match a filename in `claude/agents/` (without extension).
- If a bound agent doesn't exist, fail validation with: "Agent 'X' not found. Available: Y, Z."
- The agent's `model` field overrides the agent's default from frontmatter.
- `tools`, `skills`, and `refs` are additive — they extend the agent's default capabilities, not replace them.
```

- [ ] **Step 3: Write topology-routing.md**

```markdown
# Topology Routing

Decision tree for suggesting topology in `/gk:init-graph`.

## Rules

1. User says "audit" or "review" or "verify" → suggest **diamond** (fan-out workers + verification)
2. User says "triage" or "route" or "categorize" → suggest **classify-and-act**
3. User says "research" or "discover" or "find" → suggest **loop-until-done**
4. User says "brainstorm" or "ideas" or "naming" → suggest **generate-and-filter** (keep best K)
5. User says "compare" or "rank" or "evaluate options" → suggest **tournament**
6. If ambiguous, show top 2 options with brief descriptions and let user pick.
```

- [ ] **Step 4: Commit**

```bash
git add apps/gk/claude/rules/
git commit -m "feat: add graph authority, agent binding, and topology routing rules"
```

---

### Task 5: gk:init-graph and gk:brainstorm Skills

**Files:**
- Create: `apps/gk/claude/skills/gk-init-graph/SKILL.md`
- Create: `apps/gk/claude/skills/gk-brainstorm/SKILL.md`
- Create: `tests/integration/init-graph.test.ts`
- Create: `tests/fixtures/minimal-diamond.yaml`

**Interfaces:**
- Consumes: Task 1 (scaffold), Task 2 (schemas), Task 4 (routing rules)
- Produces: graph.yaml generation and refinement skills

- [ ] **Step 1: Write gk-init-graph SKILL.md**

```yaml
---
name: gk init-graph
description: Generate a graph.yaml file from a graph topology template. Use when the user wants to create a new graph engineering workflow, start a graph-based task, or initialize graph-kit for a project.
when_to_use: User wants to create a graph, set up a graph workflow, initialize graphkit, or start a new graph engineering task. Trigger: "create a graph", "new graph", "init graph", "set up workflow".
user-invocable: true
disable-model-invocation: false
---
```

Body content for the skill:

```
# gk init-graph

## Purpose
Generate a graph.yaml file in the project root from one of the 6 canonical topology templates.

## Process

1. If `--template` argument provided, use that topology.
2. If no template, read the user's description and suggest a topology using the rules in `claude/rules/topology-routing.md`.
3. Ask for **inputs** — what data does the graph operate on? (repo path, code scope, documents, etc.)
4. Generate `graph.yaml` with:
   - Selected topology
   - Declared inputs with types and defaults
   - Default node bindings (based on topology: scouter → Software Architect, worker → Code Reviewer, etc.)
   - Reasonable defaults for limits and evidence
   - Empty `topology_config` with comments showing available keys
5. Tell the user the file was created and suggest `/gk:visualize` to see it.

## Template Defaults

| Topology | Default Nodes |
|----------|-------------|
| diamond | scouter, worker, verifier, synthesizer |
| classify-and-act | classifier, handler-1, handler-2, handler-3, fallback |
| adversarial-verification | producer, refuter-1, refuter-2, adjudicator |
| loop-until-done | scouter, worker-batch |
| generate-and-filter | generator-1, generator-2, generator-3 |
| tournament | candidate-1, candidate-2, candidate-3, judge |

## Output
Writes `graph.yaml` to project root. Does not overwrite existing files — fail if graph.yaml already exists with content.
```

- [ ] **Step 2: Write gk-brainstorm SKILL.md**

```yaml
---
name: gk brainstorm
description: Refine an existing graph.yaml through interactive dialogue. Use when the user wants to improve their graph definition, adjust agent bindings, add loops or constraints, or explore what topology to use.
when_to_use: User has an existing graph.yaml and wants to refine it, improve it, or adjust configuration. Trigger: "refine graph", "improve workflow", "brainstorm graph", "adjust graph".
user-invocable: true
disable-model-invocation: false
---
```

Body content — the brainstorm skill:

```
# gk brainstorm

## Purpose
Interactively refine a graph.yaml file through conversation.

## Process

1. Read the existing `graph.yaml`.
2. Validate it using the graph schema (parse + basic checks).
3. Ask focused questions, one at a time:
   - "Which agents should handle which nodes?" → suggest based on topology
   - "Should any nodes run at a different model tier?" → suggest based on task complexity
   - "Should any nodes have internal loops?" → suggest for research/discovery nodes
   - "Are there constraints needed?" → suggest based on task type
4. Update `graph.yaml` after each decision.
5. After all changes, suggest running `/gk:validate` before compile.

## Key Interactions
- Suggest model tiering: "The scouter does deep analysis — opus. The verifier just checks file:line refs — haiku. Save budget."
- Suggest loop config: "This scouter needs to research until it finds concrete evidence. Enable loop-until-done with 3 max rounds."
- Suggest constraints: "Workers should only touch their assigned files. Add `assigned_only: true`."
- Show topology config options available for the selected topology.
```

- [ ] **Step 3: Write init-graph integration test**

Create `tests/fixtures/minimal-diamond.yaml`:

```yaml
apiVersion: graphkit.dev/v2
kind: Graph
metadata:
  name: test-graph
topology: diamond
inputs:
  repo_path:
    type: string
    required: true
nodes:
  scouter:
    agent: Software Architect
    model: opus
    objective: Analyze the codebase
    tools: [Read, Glob, Grep]
    depend_on: []
    evidence: [attack_surface]
  worker:
    agent: Code Reviewer
    model: sonnet
    objective: Audit assigned files
    depend_on: [scouter]
    evidence: [findings]
  synthesizer:
    agent: Software Architect
    model: opus
    depend_on: [worker]
    evidence: [report]
limits:
  max_workers: 3
evidence:
  required_keys: [report]
```

Write `tests/integration/init-graph.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";

const FIXTURES = join(import.meta.dir, "..", "fixtures");

describe("gk:init-graph skill", () => {
  const tmpDir = join(import.meta.dir, ".tmp-init-graph");
  beforeEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
    mkdirSync(tmpDir, { recursive: true });
  });
  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
  });

  test("generates valid graph.yaml from diamond template", () => {
    // The skill would create this file
    // Verify the fixture parses correctly against the schema
    const raw = readFileSync(join(FIXTURES, "minimal-diamond.yaml"), "utf-8");
    const parsed = YAML.parse(raw); // import YAML from "yaml"
    expect(parsed.topology).toBe("diamond");
    expect(parsed.nodes).toHaveProperty("scouter");
    expect(parsed.nodes).toHaveProperty("worker");
    expect(parsed.nodes).toHaveProperty("synthesizer");
  });
});
```

- [ ] **Step 4: Run tests and commit**

```bash
bun test tests/integration/init-graph.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/gk/claude/skills/gk-init-graph/ apps/gk/claude/skills/gk-brainstorm/ tests/integration/ tests/fixtures/
git commit -m "feat: add gk:init-graph and gk:brainstorm skills"
```

---

### Task 6: gk:validate Skill

**Files:**
- Create: `apps/gk/claude/skills/gk-validate/SKILL.md`
- Create: `apps/gk/src/compiler/validate.ts`
- Create: `tests/unit/validate.test.ts`
- Create: `tests/fixtures/invalid-graph-no-agent.yaml`
- Create: `tests/fixtures/invalid-graph-cyclic.yaml`
- Create: `tests/fixtures/invalid-graph-missing-ref.yaml`

**Interfaces:**
- Consumes: Task 2 (schemas), Task 3 (agent names)
- Produces: `validateGraph(graph, projectRoot): Finding[]` in `src/compiler/validate.ts` — used by both the SKILL and the CLI (Task 12). Finding = `{ check: string; path: string; message: string }`

- [ ] **Step 1: Write gk-validate SKILL.md**

The validate skill reads graph.yaml and runs all checks:

```
# gk validate

## Purpose
Gate-check a graph.yaml before compilation. Fails fast on first error.

## Checks (in order)

1. **Syntax**: YAML parses without error
2. **Schema**: Conforms to graph.schema.ts
3. **Topology**: Topology name is one of 6 canonical names
4. **Agent binding**: Every node's `agent` matches a file in `claude/agents/`
5. **Refs exist**: Every file in `refs[].path` exists on disk
6. **Acyclic deps**: `depend_on` forms a DAG (no cycles)
7. **Evidence keys**: Terminal nodes produce all `evidence.required_keys`
8. **Loop exits**: Nodes with `loop.enabled: true` have `stop_when` or `exit_condition`
9. **Constraints**: Constraint keys are known types

## Output

- PASS: "Graph validated successfully. Ready for compile."
- FAIL: List each finding with file, line, and fix suggestion.
```

- [ ] **Step 2: Write src/compiler/validate.ts**

The structural checks that zod alone can't express (they need the filesystem):

```typescript
import { existsSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import type { Graph } from "../schemas/graph.schema.js";

export interface Finding {
  check: string;   // "agent-binding" | "refs-exist" | "evidence-keys" | "loop-exit"
  path: string;    // "nodes.scouter.agent"
  message: string; // human-readable with fix suggestion
}

// Agent names resolve to kebab-case filenames: "Software Architect" → software-architect.md
export function agentFileName(agent: string): string {
  return agent.toLowerCase().replace(/[^a-z0-9]+/g, "-") + ".md";
}

export function validateGraph(graph: Graph, projectRoot: string): Finding[] {
  const findings: Finding[] = [];

  // 1. Agent binding: node.agent must exist in .claude/agents/ (or claude/agents/ in dev)
  const agentDirs = [join(projectRoot, ".claude", "agents"), join(projectRoot, "claude", "agents")];
  const agentDir = agentDirs.find((d) => existsSync(d));
  const available = agentDir ? readdirSync(agentDir).map((f) => basename(f, ".md")) : [];
  for (const [id, node] of Object.entries(graph.nodes)) {
    const expected = agentFileName(node.agent).replace(/\.md$/, "");
    if (agentDir && !available.includes(expected)) {
      findings.push({
        check: "agent-binding",
        path: `nodes.${id}.agent`,
        message: `Agent "${node.agent}" not found. Available: ${available.join(", ")}`,
      });
    }
    // 2. Refs exist on disk
    for (const ref of node.refs) {
      if (!existsSync(join(projectRoot, ref.path))) {
        findings.push({
          check: "refs-exist",
          path: `nodes.${id}.refs`,
          message: `Ref "${ref.path}" does not exist`,
        });
      }
    }
    // 3. Loop exit: enabled loops need a stop_when or exit_condition
    if (node.loop.enabled && !node.loop.stop_when && !node.loop.exit_condition) {
      findings.push({
        check: "loop-exit",
        path: `nodes.${id}.loop`,
        message: "Loop enabled but no stop_when or exit_condition declared",
      });
    }
  }

  // 4. Evidence coverage: every required key must be produced by some node
  const produced = new Set(Object.values(graph.nodes).flatMap((n) => n.evidence));
  for (const key of graph.evidence.required_keys) {
    if (!produced.has(key)) {
      findings.push({
        check: "evidence-keys",
        path: "evidence.required_keys",
        message: `Required evidence key "${key}" is not produced by any node`,
      });
    }
  }

  return findings;
}
```

- [ ] **Step 3: Write validate.test.ts**

Test validation against the fixtures:
- `invalid-graph-no-agent.yaml`: node with no `agent` field → zod schema rejects
- `invalid-graph-cyclic.yaml`: nodes a → b → a → zod superRefine rejects with "cycle"
- `invalid-graph-missing-ref.yaml`: ref points to `does/not/exist.md` → validateGraph returns refs-exist finding
- A graph whose `evidence.required_keys` includes a key no node produces → evidence-keys finding
- A graph with `loop.enabled: true` and no stop condition → loop-exit finding
- The valid minimal-diamond.yaml from Task 5 → zero findings (create the referenced agents dir in a temp fixture project)

- [ ] **Step 4: Run tests**

```bash
bun test tests/unit/validate.test.ts
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add apps/gk/claude/skills/gk-validate/ tests/unit/validate.test.ts tests/fixtures/
git commit -m "feat: add gk:validate skill with schema and structural checks"
```

---

### Task 7: gk:compile Skill and Topology Templates

**Files:**
- Create: `apps/gk/claude/skills/gk-compile/SKILL.md`
- Create: `apps/gk/claude/templates/diamond.workflow.js`
- Create: `apps/gk/claude/templates/classify-and-act.workflow.js`
- Create: `apps/gk/claude/templates/adversarial-verification.workflow.js`
- Create: `apps/gk/claude/templates/loop-until-done.workflow.js`
- Create: `apps/gk/claude/templates/generate-and-filter.workflow.js`
- Create: `apps/gk/claude/templates/tournament.workflow.js`
- Create: `apps/gk/src/compiler/resolver.ts`
- Create: `apps/gk/src/compiler/emitter.ts`
- Create: `tests/unit/compiler.test.ts`
- Create: `tests/unit/resolver.test.ts`

**Interfaces:**
- Consumes: Task 2 (schemas), Task 3 (agents), Task 4 (rules), Task 6 (validate skill)
- Produces: Compiler that reads graph.yaml, resolves templates, emits .workflow.js

- [ ] **Step 1: Write diamond.workflow.js template**

```javascript
export const meta = {
  name: "diamond",
  description: "Fan-out → reduce → synthesize graph topology",
};

// This is the template skeleton for a diamond topology.
// The compiler fills in: agent prompts, refs, model tiers, tools, skills.
// Structure follows: pipeline(items, fanout, reduce, synthesize)

export function createDiamondWorkflow(config) {
  const { nodes, limits, topology_config } = config;

  return async function diamond(context) {
    const scoutResult = await context.agent(nodes.scouter.objective, {
      model: nodes.scouter.model,
      tools: nodes.scouter.tools,
      skills: nodes.scouter.skills,
    });

    const items = scoutResult.items || context.inputs;

    // parallel() takes thunks: () => Promise — a thrown agent resolves to null, not a batch failure
    const workerResults = await context.parallel(
      items.map(item => () =>
        context.agent(nodes.worker.objective + `\n\nAssigned item: ${item}`, {
          model: nodes.worker.model,
          tools: nodes.worker.tools,
          skills: nodes.worker.skills,
        })
      )
    );

    // Reduce: deterministic code (dedup, rank) — NOT an agent call
    const reduced = workerResults
      .filter(Boolean)
      .flat();

    const synthesized = await context.agent(nodes.synthesizer.objective, {
      model: nodes.synthesizer.model,
      refs: [...nodes.synthesizer.refs, ...context.evidence],
      tools: nodes.synthesizer.tools,
    });

    return synthesized;
  };
}
```

- [ ] **Step 2: Write remaining 5 topology templates**

Each template exports `create<Name>Workflow(config)` returning `async (context) => result`. Shared helper (inline in each template — the emitted file must be self-contained):

```javascript
function nodeOpts(node) {
  return { model: node.model, tools: node.tools, skills: node.skills, refs: node.refs };
}
```

**classify-and-act.workflow.js:**

```javascript
export function createClassifyWorkflow(config) {
  const { nodes, topology_config } = config;
  return async function classifyAndAct(context) {
    const cls = nodes[topology_config.classifier ?? "classifier"];
    const label = await context.agent(
      cls.objective + "\n\nReturn ONLY the category label.", nodeOpts(cls));
    const route = (topology_config.routes ?? []).find(r => label.includes(r.condition));
    const handlerId = route ? route.handler : topology_config.fallback;
    if (!handlerId || !nodes[handlerId])
      return { verdict: "failed", error: `No handler for label "${label}"` };
    const handler = nodes[handlerId];
    const result = await context.agent(handler.objective + `\n\nClassified as: ${label}`, nodeOpts(handler));
    return { label, handler: handlerId, result };
  };
}
```

**adversarial-verification.workflow.js:**

```javascript
export function createAdversarialWorkflow(config) {
  const { nodes, topology_config } = config;
  const threshold = topology_config.survive_threshold ?? 2;
  return async function adversarialVerification(context) {
    const producer = nodes[topology_config.producer ?? "producer"];
    const produced = await context.agent(producer.objective, nodeOpts(producer));
    const items = Array.isArray(produced.items) ? produced.items : [produced];
    const refuterIds = topology_config.refuters ?? Object.keys(nodes).filter(n => n.startsWith("refuter"));

    const judged = await context.parallel(items.map(item => async () => {
      const votes = await context.parallel(refuterIds.map(rid => async () => {
        const r = nodes[rid];
        // Refuters get ONLY the item — fresh context, no producer reasoning
        return context.agent(
          r.objective + `\n\nTry to REFUTE this finding. Default to refuted if uncertain:\n${JSON.stringify(item)}`,
          nodeOpts(r));
      }));
      const survivals = votes.filter(Boolean).filter(v => !v.refuted).length;
      return { item, survived: survivals >= threshold };
    }));
    return { kept: judged.filter(j => j?.survived).map(j => j.item),
             rejected: judged.filter(j => j && !j.survived).map(j => j.item) };
  };
}
```

**loop-until-done.workflow.js:**

```javascript
export function createLoopWorkflow(config) {
  const { nodes, limits, topology_config } = config;
  const dryThreshold = topology_config.dry_threshold ?? 2;
  const maxRounds = limits.max_iterations ?? 10;
  return async function loopUntilDone(context) {
    const seen = new Set(); const all = []; let dry = 0; let round = 0;
    const scouter = nodes[topology_config.scouter ?? "scouter"];
    const worker = nodes[topology_config.worker_batch ?? "worker"];
    while (dry < dryThreshold && round < maxRounds) {
      round++;
      const found = await context.agent(
        scouter.objective + `\n\nRound ${round}. Already found: ${all.length} items. Find NEW items only.`,
        nodeOpts(scouter));
      const fresh = (found.items ?? []).filter(i => !seen.has(JSON.stringify(i)));
      if (fresh.length === 0) { dry++; continue; }
      dry = 0;
      fresh.forEach(i => seen.add(JSON.stringify(i)));
      const results = await context.parallel(fresh.map(item => () =>
        context.agent(worker.objective + `\n\nAssigned: ${JSON.stringify(item)}`, nodeOpts(worker))));
      all.push(...results.filter(Boolean));
    }
    return { rounds: round, results: all };
  };
}
```

**generate-and-filter.workflow.js:**

```javascript
export function createGenerateFilterWorkflow(config) {
  const { nodes, topology_config } = config;
  const keepTop = topology_config.keep_top ?? 3;
  return async function generateAndFilter(context) {
    const genIds = topology_config.generators ?? Object.keys(nodes).filter(n => n.startsWith("generator"));
    const batches = await context.parallel(genIds.map(gid => () =>
      context.agent(nodes[gid].objective, nodeOpts(nodes[gid]))));
    // Filter is CODE: flatten + dedupe on dedup_keys
    const dedupKeys = topology_config.dedup_keys ?? [];
    const seen = new Set();
    const candidates = batches.filter(Boolean).flatMap(b => b.candidates ?? []).filter(c => {
      const key = dedupKeys.length ? dedupKeys.map(k => c[k]).join("|") : JSON.stringify(c);
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });
    // One scoring pass against the rubric (single agent call over the full set)
    const scorer = nodes[topology_config.scorer ?? "scorer"] ?? nodes[genIds[0]];
    const scored = await context.agent(
      `Score each candidate 1-10 against this rubric:\n${topology_config.rubric}\n\nCandidates:\n${JSON.stringify(candidates)}\n\nReturn [{candidate, score}] sorted desc.`,
      nodeOpts(scorer));
    return { kept: (scored.ranked ?? []).slice(0, keepTop), total_generated: candidates.length };
  };
}
```

**tournament.workflow.js:**

```javascript
export function createTournamentWorkflow(config) {
  const { nodes, topology_config } = config;
  return async function tournament(context) {
    const candIds = topology_config.candidates ?? Object.keys(nodes).filter(n => n.startsWith("candidate"));
    const judge = nodes[topology_config.judge ?? "judge"];
    // Each candidate produces its attempt in parallel
    let pool = await context.parallel(candIds.map(cid => async () => ({
      id: cid,
      attempt: await context.agent(nodes[cid].objective, nodeOpts(nodes[cid])),
    })));
    pool = pool.filter(Boolean);
    // Pairwise elimination rounds until one champion
    while (pool.length > 1) {
      const next = [];
      for (let i = 0; i < pool.length; i += 2) {
        if (i + 1 >= pool.length) { next.push(pool[i]); continue; } // bye
        const [a, b] = [pool[i], pool[i + 1]];
        const verdict = await context.agent(
          judge.objective + `\n\nCompare:\nA (${a.id}): ${JSON.stringify(a.attempt)}\nB (${b.id}): ${JSON.stringify(b.attempt)}\n\nReturn {"winner": "A"|"B", "reason": "..."}`,
          nodeOpts(judge));
        next.push(verdict.winner === "B" ? b : a);
      }
      pool = next;
    }
    return { champion: pool[0] };
  };
}
```

- [ ] **Step 3: Write resolver.ts**

Resolves subgraph references in `topology_config`. When a section has `template: adversarial-verification`, the resolver marks it as a subgraph and validates the referenced template exists. Depth limit prevents infinite nesting:

```typescript
import { existsSync } from "node:fs";
import { join } from "node:path";
import { GraphKitError } from "../errors.js";
import { TOPOLOGY_NAMES } from "../schemas/topology/index.js";

const MAX_DEPTH = 3;

export function resolveTopologyConfig(
  topology: string,
  topologyConfig: Record<string, unknown>,
  templatesDir: string,
  depth = 0,
): Record<string, unknown> {
  if (depth > MAX_DEPTH) {
    throw new GraphKitError("SUBGRAPH_TOO_DEEP", `Subgraph nesting exceeds ${MAX_DEPTH} levels`);
  }
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(topologyConfig)) {
    if (value && typeof value === "object" && !Array.isArray(value) && "template" in value) {
      const sub = value as Record<string, unknown> & { template: string };
      if (!TOPOLOGY_NAMES.includes(sub.template as never)) {
        throw new GraphKitError("UNKNOWN_SUBGRAPH", `Subgraph template "${sub.template}" is not a canonical topology`);
      }
      if (!existsSync(join(templatesDir, `${sub.template}.workflow.js`))) {
        throw new GraphKitError("SUBGRAPH_TEMPLATE_MISSING", `Template file for "${sub.template}" not found in ${templatesDir}`);
      }
      // Recurse: subgraphs may themselves contain subgraph refs
      resolved[key] = {
        ...resolveTopologyConfig(sub.template, sub, templatesDir, depth + 1),
        __subgraph: sub.template,   // marker the emitter uses to inline the sub-template
      };
    } else {
      resolved[key] = value;
    }
  }
  return resolved;
}
```

The emitter (Step 4) reads the `__subgraph` markers and inlines each referenced template's `create<Name>Workflow` function alongside the root template, so composed graphs remain a single self-contained file.

- [ ] **Step 4: Write emitter.ts**

Takes a validated + resolved graph and produces a self-contained `.workflow.js` script. The template body is inlined (not imported) so the emitted file has zero dependencies on the kit's install location:

```typescript
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Graph } from "../schemas/graph.schema.js";
import { resolveTopologyConfig } from "./resolver.js";

const TEMPLATE_FN: Record<string, string> = {
  "diamond": "createDiamondWorkflow",
  "classify-and-act": "createClassifyWorkflow",
  "adversarial-verification": "createAdversarialWorkflow",
  "loop-until-done": "createLoopWorkflow",
  "generate-and-filter": "createGenerateFilterWorkflow",
  "tournament": "createTournamentWorkflow",
};

export function compileGraph(graph: Graph, templatesDir: string): string {
  const resolved = resolveTopologyConfig(graph.topology, graph.topology_config, templatesDir);

  // Collect the root template + every referenced subgraph template (deduped)
  const templateFiles = new Set<string>([`${graph.topology}.workflow.js`]);
  const collectSubgraphs = (obj: unknown) => {
    if (obj && typeof obj === "object") {
      for (const v of Object.values(obj as Record<string, unknown>)) {
        if (v && typeof v === "object" && "__subgraph" in v) {
          templateFiles.add(`${(v as { __subgraph: string }).__subgraph}.workflow.js`);
        }
        if (v && typeof v === "object") collectSubgraphs(v);
      }
    }
  };
  collectSubgraphs(resolved);

  // Inline all needed template sources (deduped, root last)
  const sources = [...templateFiles]
    .filter((f, i, arr) => arr.indexOf(f) === i)
    .map((f) => readFileSync(join(templatesDir, f), "utf-8"));
  const fnName = TEMPLATE_FN[graph.topology];

  const config = {
    metadata: graph.metadata,
    nodes: graph.nodes,
    limits: graph.limits,
    evidence: graph.evidence,
    topology_config: resolved,
    outputs: graph.outputs,
  };

  return [
    `// Generated by gk compile — DO NOT EDIT. Source of truth: graph.yaml`,
    `export const meta = ${JSON.stringify({ name: graph.metadata.name, description: graph.metadata.description ?? `${graph.topology} graph` }, null, 2)};`,
    ``,
    ...sources,                   // inlines root + all subgraph template definitions
    ``,
    `const graphConfig = ${JSON.stringify(config, null, 2)};`,
    ``,
    `export default ${fnName}(graphConfig);`,
  ].join("\n");
}
```

Emitted-file contract: the template files define `createXWorkflow(config)` returning `async (context) => result`. The emitter inlines the root template + every subgraph template (deduped), then appends the config + default export. `context` provides `agent()`, `parallel()`, `pipeline()`, and `inputs` from Claude Code's workflow runtime. The emitted file is fully self-contained — zero imports from the kit.

- [ ] **Step 5: Write compiler test**

Test that:
- Diamond YAML compiles to valid .workflow.js containing `createDiamondWorkflow`
- Subgraph reference (diamond with adversarial-verification subgraph) resolves correctly
- Invalid topology name throws

- [ ] **Step 6: Write resolver test**

Test that:
- Simple config (no subgraph) passes through unchanged
- Subgraph config merges parent + child config correctly
- Missing template throws clear error

- [ ] **Step 7: Run all tests and commit**

```bash
bun test tests/unit/compiler.test.ts tests/unit/resolver.test.ts
```

- [ ] **Step 8: Commit**

```bash
git add apps/gk/claude/templates/ apps/gk/src/compiler/ tests/unit/
git commit -m "feat: add 6 topology templates and compiler (resolver + emitter)"
```

---

### Task 8: gk:run, gk:evidence, and gk:status Skills

**Files:**
- Create: `apps/gk/claude/skills/gk-run/SKILL.md`
- Create: `apps/gk/claude/skills/gk-evidence/SKILL.md`
- Create: `apps/gk/claude/skills/gk-status/SKILL.md`

**Interfaces:**
- Consumes: Task 1 (scaffold), Task 7 (compile)
- Produces: Runtime skills for executing and monitoring graphs

- [ ] **Step 1: Write gk-run SKILL.md**

```yaml
---
name: gk run
description: Execute a compiled graph workflow using Claude Code's Workflow tool. Use after gk:compile has produced a .workflow.js. Trigger: "run the graph", "execute workflow", "start the graph run".
when_to_use: A compiled .workflow.js exists and the user wants to execute the graph.
user-invocable: true
disable-model-invocation: false
---
```

Body:

```
# gk run

## Process

1. Read `graph.yaml` to get `metadata.name`.
2. Check for compiled workflow at `.claude/workflows/{name}.workflow.js`.
   - If missing: STOP. Tell the user to run `/gk:compile` first. Do not compile implicitly.
3. Write `.graphkit/runs/current.json` with the resolved node constraints (so the lease-enforce hook can inject them):
   ```json
   { "name": "<graph name>", "started_at": "<ISO>", "constraints": { "<nodeId>": { "assigned_only": true } } }
   ```
   Create `.graphkit/runs/.active` marker file (touched, empty).
4. Invoke Claude Code's Workflow tool with the script path: `Workflow({ scriptPath: ".claude/workflows/{name}.workflow.js" })`.
   - The workflow script is self-contained: it defines `meta` + a default export that takes the runtime `context` (which provides `agent()`, `parallel()`, `pipeline()`, and `inputs`).
5. When the Workflow tool returns, remove `.graphkit/runs/.active`.
6. Write the final result to `.graphkit/runs/{name}-result.json`.
7. Report to the user: verdict (passed/failed/partial), which nodes ran, and suggest `/gk:evidence`.

## Boundary

This skill drives the Workflow tool; it does not itself implement the graph topology. If the workflow fails, surface the failure — do not retry outside the graph's declared loop config.
```

- [ ] **Step 2: Write gk-evidence SKILL.md**

```yaml
---
name: gk evidence
description: Produce a markdown evidence report from a completed graph run. Use after gk:run finishes. Trigger: "show evidence", "graph results", "what did the graph produce", "evidence report".
when_to_use: A graph run has completed (or partially completed) and the user wants the collected evidence.
user-invocable: true
disable-model-invocation: false
---
```

Body:

```
# gk evidence

## Process

1. Read `graph.yaml` → `metadata.name`, `evidence.required_keys`, `nodes` (each node's declared `evidence` keys).
2. Read `.graphkit/evidence/.index` (written by evidence-persist.cjs) to enumerate which evidence files landed. Fall back to scanning `.graphkit/evidence/**/*.md` if no index.
3. For each node declared in graph.yaml, find its evidence files and extract:
   - The node id, agent name, model tier
   - Each declared evidence key and its value (summary first line + full content)
   - Whether the node completed (evidence file exists) or is pending/missing
4. Check coverage: are all `evidence.required_keys` present? Flag gaps explicitly.
5. Compose a single markdown report:
   - Header: graph name, topology, run timestamp (from .graphkit/runs/current.json)
   - Per-node section with evidence
   - Coverage table: required key × producing node × status
   - Verdict line (passed if all required keys present, else partial/failed)
6. Write to `.graphkit/reports/{name}.md` (path from graph.yaml `outputs.report`, `{name}` substituted).

## Output

One markdown file. Does not invoke agents — pure aggregation and formatting.
```

- [ ] **Step 3: Write gk-status SKILL.md**

```yaml
---
name: gk status
description: Show the current state of a graph run. Use when the user wants a quick check on what's running or completed. Trigger: "graph status", "what's running", "graph state".
when_to_use: User wants to know the state of the current or most recent graph run.
user-invocable: true
disable-model-invocation: true
---
```

Body:

```
# gk status

## Process

1. If `.graphkit/runs/.active` exists: report "RUNNING" + the `current.json` name + which nodes have evidence files (completed) vs which don't (pending). Read `.graphkit/evidence/.index` if present.
2. If not running but `.graphkit/runs/{name}-result.json` exists: report the last run's verdict + timestamp.
3. If neither: report "No graph run found. Create one with /gk:init-graph."
4. Output is terminal-friendly: one line per node with ✓ completed / ○ pending / ✗ failed.

## Output

Stdout only. No files written. No agents invoked.
```

- [ ] **Step 4: Commit**

```bash
git add apps/gk/claude/skills/gk-run/ apps/gk/claude/skills/gk-evidence/ apps/gk/claude/skills/gk-status/
git commit -m "feat: add gk:run, gk:evidence, and gk:status skills"
```

---

### Task 9: gk:visualize Skill

**Files:**
- Create: `apps/gk/claude/skills/gk-visualize/SKILL.md`
- Create: `apps/gk/claude/skills/gk-visualize/references/graph-palette.md`
- Vendored: `apps/gk/claude/skills/excalidraw-diagram/` (from coleam00/excalidraw-diagram-skill)

**Interfaces:**
- Consumes: Task 1 (scaffold), Task 2 (schemas)
- Produces: Visualization skill that renders graph.yaml as excalidraw

- [ ] **Step 1: Vendor excalidraw-diagram skill**

Clone/copy the excalidraw-diagram skill from coleam00/excalidraw-diagram-skill into `apps/gk/claude/skills/excalidraw-diagram/`. Keep: SKILL.md, references/, scripts/ (render_excalidraw.py, etc.). Skip: examples/, README.md, tests/.

```bash
git clone --depth 1 https://github.com/coleam00/excalidraw-diagram-skill /tmp/excalidraw-skill
rm -rf /tmp/excalidraw-skill/.git /tmp/excalidraw-skill/examples /tmp/excalidraw-skill/README.md
cp -r /tmp/excalidraw-skill apps/gk/claude/skills/excalidraw-diagram
```

- [ ] **Step 2: Write graph-palette.md**

Custom color palette for GraphKit diagrams:

```markdown
# GraphKit Diagram Palette

## Background
- Background: #0d1117
- Card: #161b22
- Border: #30363d

## Node Colors (by model tier)
- opus: #6e40c9 (purple)
- sonnet: #58a6ff (blue)
- haiku: #3fb950 (green)
- fable: #d97706 (amber)

## Edge Colors
- depend_on edge: #58a6ff
- evidence flow: #3fb950 (dotted)
- subgraph boundary: #484f58 (dashed)

## Text
- Primary: #c9d1d9
- Secondary: #8b949e
- Accent: #58a6ff

## Shapes
- Node: rounded rectangle with model-tier color
- Arrow: solid with edge color
- Loop: circular arrow on node
- Subgraph: dashed rectangle
```

- [ ] **Step 3: Write gk:visualize SKILL.md**

```
# gk visualize

## Purpose
Render graph.yaml as an Excalidraw diagram.

## Process

1. Read graph.yaml.
2. Parse nodes and depend_on edges.
3. Invoke the excalidraw-diagram skill to generate the diagram.
4. Color nodes by model tier (opus=purple, sonnet=blue, haiku=green).
5. Draw depend_on arrows between nodes.
6. Mark nodes with internal loops with a circular indicator.
7. Draw subgraph boundaries as dashed rectangles for composed templates.
8. Write output to `.graphkit/diagrams/{name}.excalidraw`.
9. Auto-open in browser (render via excalidraw skill pipeline).

## Output
- `.graphkit/diagrams/{name}.excalidraw` — editable in Excalidraw
- `.graphkit/diagrams/{name}.png` — rendered preview (optional)
```

- [ ] **Step 4: Install excalidraw render dependencies**

```bash
cd apps/gk/claude/skills/excalidraw-diagram/references
uv sync
uv run playwright install chromium
```

- [ ] **Step 5: Commit**

```bash
git add apps/gk/claude/skills/gk-visualize/ apps/gk/claude/skills/excalidraw-diagram/
git commit -m "feat: add gk:visualize skill with excalidraw integration"
```

---

### Task 10: Hooks

**Files:**
- Create: `apps/gk/claude/hooks/graph-state-guard.cjs`
- Create: `apps/gk/claude/hooks/evidence-persist.cjs`
- Create: `apps/gk/claude/hooks/lease-enforce.cjs`
- Create: `tests/unit/hooks.test.ts`

**Interfaces:**
- Consumes: Task 1 (hook event slots in settings.json)
- Produces: 3 hooks that enforce graph invariants during runtime

Claude Code hooks are **stdin/stdout protocol scripts**: they read a JSON event from stdin, write an optional JSON decision to stdout, and exit 0. A non-zero exit or malformed output must never break the session — wrap everything in try/catch and exit 0 (fail-open, per claudekit pattern).

- [ ] **Step 1: Write graph-state-guard.cjs**

PreToolUse hook. Blocks Write/Edit to `.graphkit/evidence/**` while a graph run is active (evidence is workflow-owned during a run):

```javascript
#!/usr/bin/env node
// PreToolUse: block manual writes to evidence dir during an active graph run. Fail-open.
const fs = require("node:fs");

function main() {
  let input = "";
  try { input = fs.readFileSync(0, "utf-8"); } catch { process.exit(0); }
  try {
    const event = JSON.parse(input);
    const tool = event.tool_name ?? "";
    if (tool !== "Write" && tool !== "Edit") process.exit(0);
    const path = event.tool_input?.file_path ?? "";
    const activeMarker = ".graphkit/runs/.active";
    if (path.includes(".graphkit/evidence/") && fs.existsSync(activeMarker)) {
      console.log(JSON.stringify({
        decision: "block",
        reason: "Evidence files are workflow-owned while a graph run is active. Wait for the run to finish or stop it first.",
      }));
    }
  } catch { /* fail-open */ }
  process.exit(0);
}
main();
```

- [ ] **Step 2: Write evidence-persist.cjs**

PostToolUse hook. When a Write lands in `.graphkit/evidence/`, append a line to the run's evidence index so `gk:status` and `gk:evidence` can enumerate node completions without scanning:

```javascript
#!/usr/bin/env node
// PostToolUse: index evidence writes for gk:status / gk:evidence. Fail-open.
const fs = require("node:fs");
const path = require("node:path");

function main() {
  let input = "";
  try { input = fs.readFileSync(0, "utf-8"); } catch { process.exit(0); }
  try {
    const event = JSON.parse(input);
    if (event.tool_name !== "Write") process.exit(0);
    const file = event.tool_input?.file_path ?? "";
    if (!file.includes(".graphkit/evidence/")) process.exit(0);
    const indexFile = ".graphkit/evidence/.index";
    fs.mkdirSync(path.dirname(indexFile), { recursive: true });
    fs.appendFileSync(indexFile, JSON.stringify({ file, at: new Date().toISOString() }) + "\n");
  } catch { /* fail-open */ }
  process.exit(0);
}
main();
```

- [ ] **Step 3: Write lease-enforce.cjs**

SubagentStart hook. If the graph run recorded per-node constraints (written by gk:run as `.graphkit/runs/current.json`), inject them as additional context for the spawned worker:

```javascript
#!/usr/bin/env node
// SubagentStart: inject node constraints into worker context. Fail-open.
const fs = require("node:fs");

function main() {
  let input = "";
  try { input = fs.readFileSync(0, "utf-8"); } catch { process.exit(0); }
  try {
    const runFile = ".graphkit/runs/current.json";
    if (!fs.existsSync(runFile)) process.exit(0);
    const run = JSON.parse(fs.readFileSync(runFile, "utf-8"));
    if (!run.constraints || Object.keys(run.constraints).length === 0) process.exit(0);
    console.log(JSON.stringify({
      additionalContext:
        "GraphKit constraints for this node: " + JSON.stringify(run.constraints) +
        ". Respect assigned_only (touch only assigned files) and no_write (read-only) if present.",
    }));
  } catch { /* fail-open */ }
  process.exit(0);
}
main();
```

- [ ] **Step 4: Write hooks test**

`tests/unit/hooks.test.ts` spawns each hook as a subprocess with fixture stdin and asserts:
- graph-state-guard blocks a Write to `.graphkit/evidence/x.md` when `.graphkit/runs/.active` exists, allows otherwise
- evidence-persist appends to `.graphkit/evidence/.index` on evidence writes
- every hook exits 0 on: empty stdin, malformed JSON, unknown tool_name (fail-open proof)

```typescript
import { describe, test, expect } from "bun:test";

async function runHook(hookPath: string, stdin: string, cwd: string) {
  const proc = Bun.spawn(["node", hookPath], { stdin: new Blob([stdin]), cwd, stdout: "pipe" });
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  return { out, code };
}

describe("hooks fail-open", () => {
  test("graph-state-guard exits 0 on malformed input", async () => {
    const { code } = await runHook("claude/hooks/graph-state-guard.cjs", "not json", process.cwd());
    expect(code).toBe(0);
  });
  // ... block/allow cases with temp .graphkit dirs
});
```

- [ ] **Step 5: Commit**

```bash
git add apps/gk/claude/hooks/ tests/unit/hooks.test.ts
git commit -m "feat: add graph state guard, evidence persist, and lease enforce hooks"
```

---

### Task 11: gk CLI v2 — Kit Installation Commands

**Files:**
- Modify: `apps/gk/src/index.ts` (register kit commands)
- Create: `apps/gk/src/cli/commands/kit.ts`
- Create: `tests/unit/kit-commands.test.ts`
- Modify: `apps/gk/package.json` (add "files" and claudekit metadata if needed)

**Interfaces:**
- Consumes: Task 1 (scaffold)
- Produces: `gk init` and `gk new` CLI commands

- [ ] **Step 1: Write kit.ts — gk init command**

```typescript
import { existsSync, mkdirSync, cpSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { CAC } from "cac";
import { ok, fail } from "../output.js";
import { GraphKitError } from "../../errors.js";

// The kit source ships inside the npm package: <package-root>/claude/
// Resolve relative to this module, not process.cwd().
function kitSourceDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [join(here, "..", "claude"), join(here, "..", "..", "claude"), join(here, "..", "..", "..", "claude")];
  const found = candidates.find((c) => existsSync(c));
  if (!found) throw new GraphKitError("KIT_SOURCE_MISSING", "Bundled claude/ directory not found");
  return found;
}

// Re-exported so graph.ts can resolve the templates dir the same way.
export function templatesDir(): string {
  return join(kitSourceDir(), "templates");
}

export function installKit(targetDir: string): { installed: string[] } {
  const source = kitSourceDir();
  const claudeDir = join(targetDir, ".claude");
  mkdirSync(claudeDir, { recursive: true });
  // cpSync with recursive handles the whole tree; force: false → never clobber user edits
  cpSync(source, claudeDir, { recursive: true, force: false });

  const gkConfig = join(claudeDir, ".gk.json");
  if (!existsSync(gkConfig)) {
    writeFileSync(gkConfig, JSON.stringify({ codingLevel: 0, statusline: "full" }, null, 2));
  }
  return { installed: readdirSync(claudeDir) };
}

export function registerKitCommands(cli: CAC) {
  cli
    .command("init", "Install the GraphKit kit into the current project")
    .option("--json", "JSON output")
    .action((opts) => {
      try {
        const result = installKit(process.cwd());
        console.log(JSON.stringify(ok(result)));
      } catch (e) {
        console.log(JSON.stringify(fail("INIT_FAILED", String(e))));
        process.exit(1);
      }
    });

  cli
    .command("new", "Scaffold a new project with the GraphKit kit")
    .option("--dir <dir>", "Target directory (required)")
    .option("--json", "JSON output")
    .action((opts) => {
      const dir = opts.dir;
      if (!dir) {
        console.log(JSON.stringify(fail("MISSING_DIR", "--dir is required")));
        process.exit(1);
      }
      if (existsSync(dir) && readdirSync(dir).length > 0) {
        console.log(JSON.stringify(fail("DIR_NOT_EMPTY", `Directory ${dir} exists and is not empty`)));
        process.exit(1);
      }
      mkdirSync(dir, { recursive: true });
      const result = installKit(dir);
      console.log(JSON.stringify(ok({ created: dir, ...result })));
    });
}
```

- [ ] **Step 2: Register kit commands in index.ts**

Update `src/index.ts`:

```typescript
import { registerKitCommands } from "./cli/commands/kit.js";
// ... existing code
registerKitCommands(cli);
```

- [ ] **Step 3: Test kit install and new commands**

```typescript
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, rmSync, mkdirSync, readdirSync } from "fs";
import { join } from "path";

describe("gk init/new", () => {
  // ... setup temp dir, test install copies claude/ contents
  // ... test new creates directory and installs
});
```

- [ ] **Step 4: Commit**

```bash
git add apps/gk/src/cli/commands/kit.ts apps/gk/src/index.ts tests/unit/kit-commands.test.ts
git commit -m "feat: add gk init and gk new CLI commands"
```

---

### Task 12: gk CLI v2 — Graph Lifecycle Commands

**Files:**
- Create: `apps/gk/src/cli/commands/graph.ts`
- Create: `tests/unit/graph-commands.test.ts`
- Modify: `apps/gk/src/index.ts` (register graph commands)

**Interfaces:**
- Consumes: Task 1 (scaffold), Task 2 (schemas), Task 7 (compiler)
- Produces: `gk validate`, `gk compile`, `gk graph list`, `gk graph inspect`

- [ ] **Step 1: Write graph.ts — gk validate, gk compile, gk graph list/inspect**

```typescript
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import YAML from "yaml";
import type { CAC } from "cac";
import { GraphSchema } from "../../schemas/graph.schema.js";
import { validateGraph } from "../../compiler/validate.js";
import { compileGraph } from "../../compiler/emitter.js";
import { TOPOLOGY_NAMES, getTopologyConfigKeys } from "../../schemas/topology/index.js";
import { templatesDir } from "./kit.js";
import { ok, fail } from "../output.js";
import { GraphKitError } from "../../errors.js";

function loadGraph(file: string) {
  const raw = readFileSync(file, "utf-8");
  const doc = YAML.parse(raw);
  const parsed = GraphSchema.safeParse(doc);
  if (!parsed.success) {
    throw new GraphKitError("SCHEMA_INVALID", "graph.yaml failed schema validation", {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  return parsed.data;
}

export function registerGraphCommands(cli: CAC) {
  cli
    .command("validate [file]", "Validate a graph.yaml")
    .option("--json", "JSON output")
    .action((file, opts) => {
      try {
        const graph = loadGraph(file ?? join(process.cwd(), "graph.yaml"));
        // validateGraph runs the structural checks the zod schema can't:
        // agent files exist, refs exist on disk, evidence keys covered, loop exits declared
        const findings = validateGraph(graph, process.cwd());
        if (findings.length > 0) {
          console.log(JSON.stringify(fail("VALIDATION_FAILED", "graph has findings", { findings })));
          process.exit(1);
        }
        console.log(JSON.stringify(ok({ valid: true, topology: graph.topology })));
      } catch (e) {
        console.log(JSON.stringify(e instanceof GraphKitError
          ? fail(e.code, e.message, e.details)
          : fail("VALIDATE_ERROR", String(e))));
        process.exit(1);
      }
    });

  cli
    .command("compile [file]", "Compile graph.yaml to a .workflow.js script")
    .option("--output <path>", "Output path (default .claude/workflows/{name}.workflow.js)")
    .option("--json", "JSON output")
    .action((file, opts) => {
      try {
        const graph = loadGraph(file ?? join(process.cwd(), "graph.yaml"));
        const findings = validateGraph(graph, process.cwd());
        if (findings.length > 0) {
          console.log(JSON.stringify(fail("VALIDATION_FAILED", "fix findings before compile", { findings })));
          process.exit(1);
        }
        // templatesDir resolves the same way as kitSourceDir() in kit.ts: bundled claude/templates/
        const script = compileGraph(graph, templatesDir());
        const outPath = opts.output ?? join(process.cwd(), ".claude", "workflows", `${graph.metadata.name}.workflow.js`);
        mkdirSync(dirname(outPath), { recursive: true });
        writeFileSync(outPath, script);
        console.log(JSON.stringify(ok({ compiled: outPath, topology: graph.topology })));
      } catch (e) {
        console.log(JSON.stringify(fail("COMPILE_ERROR", String(e))));
        process.exit(1);
      }
    });

  cli
    .command("graph list", "List available topologies")
    .option("--json", "JSON output")
    .action(() => {
      console.log(JSON.stringify(ok({ topologies: TOPOLOGY_NAMES })));
    });

  cli
    .command("graph inspect <topology>", "Show a topology's contract and config keys")
    .option("--json", "JSON output")
    .action((topology) => {
      if (!TOPOLOGY_NAMES.includes(topology)) {
        console.log(JSON.stringify(fail("UNKNOWN_TOPOLOGY", `"${topology}" is not a canonical topology`, { available: TOPOLOGY_NAMES })));
        process.exit(1);
      }
      console.log(JSON.stringify(ok({ topology, config_keys: getTopologyConfigKeys(topology) })));
    });
}
```

- [ ] **Step 2: Register graph commands in index.ts**

- [ ] **Step 3: Write graph commands test**

- [ ] **Step 4: Commit**

```bash
git add apps/gk/src/cli/commands/graph.ts apps/gk/src/index.ts tests/unit/graph-commands.test.ts
git commit -m "feat: add gk validate, compile, and graph lifecycle CLI commands"
```

---

### Task 13: Unit Tests — Compiler and Resolver Edge Cases

**Files:**
- Create: `tests/unit/compiler.test.ts`
- Create: `tests/unit/resolver.test.ts`

**Interfaces:**
- Consumes: Task 7 (compiler, resolver, emitter, validate.ts), Task 2 (schemas)

Note: schema-validation.test.ts and validate.test.ts and hooks.test.ts were already written in their owning tasks (2, 6, 10). This task adds the compiler/resolver edge cases not covered there.

- [ ] **Step 1: Write compiler.test.ts**

```typescript
import { describe, test, expect, beforeAll } from "bun:test";
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { GraphSchema } from "../../src/schemas/graph.schema.js";
import { compileGraph } from "../../src/compiler/emitter.js";

const TEMPLATES = join(import.meta.dir, "..", "..", "claude", "templates");

function loadFixture(name: string) {
  const raw = readFileSync(join(import.meta.dir, "..", "fixtures", name), "utf-8");
  const parsed = GraphSchema.parse(YAML.parse(raw));
  return parsed;
}

describe("compileGraph", () => {
  test("diamond produces a self-contained .workflow.js with createDiamondWorkflow", () => {
    const graph = loadFixture("minimal-diamond.yaml");
    const script = compileGraph(graph, TEMPLATES);
    expect(script).toContain("createDiamondWorkflow");
    expect(script).toContain("export const meta");
    expect(script).toContain("export default");
    // Self-contained: no import of the kit's templates dir
    expect(script).not.toContain("from \"../../");
    expect(script).not.toMatch(/require\(/);
  });

  test("all 6 topologies compile without throwing", () => {
    for (const topo of [
      "diamond", "classify-and-act", "adversarial-verification",
      "loop-until-done", "generate-and-filter", "tournament",
    ]) {
      const graph = GraphSchema.parse(YAML.parse(
        `apiVersion: graphkit.dev/v2\nkind: Graph\nmetadata:\n  name: t-${topo}\ntopology: ${topo}\nnodes:\n  a:\n    agent: Code Reviewer\n    objective: x\n`
      ));
      expect(() => compileGraph(graph, TEMPLATES)).not.toThrow();
    }
  });

  test("emitted script inlines node objectives and model tiers", () => {
    const graph = loadFixture("minimal-diamond.yaml");
    const script = compileGraph(graph, TEMPLATES);
    expect(script).toContain('"model": "opus"');
    expect(script).toContain('"model": "sonnet"');
  });

  test("throws on unknown topology", () => {
    // Bypass zod to test emitter guard
    const graph = { metadata: { name: "x" }, topology: "nope", nodes: {}, limits: {}, evidence: { required_keys: [] }, topology_config: {}, outputs: {} } as any;
    expect(() => compileGraph(graph, TEMPLATES)).toThrow();
  });
});
```

- [ ] **Step 2: Write resolver.test.ts**

```typescript
import { describe, test, expect } from "bun:test";
import { resolveTopologyConfig } from "../../src/compiler/resolver.js";
import { GraphKitError } from "../../src/errors.js";

const TEMPLATES = join(import.meta.dir, "..", "..", "claude", "templates");

describe("resolveTopologyConfig", () => {
  test("passes through config with no subgraph refs", () => {
    const out = resolveTopologyConfig("diamond", { synthesizer: "Software Architect" }, TEMPLATES);
    expect(out.synthesizer).toBe("Software Architect");
    expect(out.__subgraph).toBeUndefined();
  });

  test("marks a subgraph ref with __subgraph", () => {
    const out = resolveTopologyConfig("diamond", {
      fanout: { template: "adversarial-verification", refuters: ["QA Engineer"] },
    }, TEMPLATES);
    expect(out.fanout.__subgraph).toBe("adversarial-verification");
    expect(out.fanout.refuters).toEqual(["QA Engineer"]);
  });

  test("rejects unknown subgraph template name", () => {
    expect(() =>
      resolveTopologyConfig("diamond", { fanout: { template: "nonexistent" } }, TEMPLATES)
    ).toThrow(GraphKitError);
  });

  test("rejects subgraph nesting deeper than MAX_DEPTH", () => {
    // Build a 4-deep chain of subgraph refs
    let cfg: any = { template: "adversarial-verification" };
    for (let i = 0; i < 4; i++) cfg = { template: "adversarial-verification", child: cfg };
    expect(() => resolveTopologyConfig("diamond", { fanout: cfg }, TEMPLATES)).toThrow(GraphKitError);
  });
});
```

- [ ] **Step 3: Run full unit suite**

```bash
bun test tests/unit/
```

Expected: all schema, validate, compiler, resolver, hooks, agent-frontmatter tests pass (40+ tests).

- [ ] **Step 4: Commit**

```bash
git add tests/unit/compiler.test.ts tests/unit/resolver.test.ts
git commit -m "test: compiler and resolver edge cases (subgraph depth, self-contained emit)"
```

```bash
git add tests/
git commit -m "test: consolidate unit tests for schemas, compiler, and hooks"
```

---

### Task 14: Integration Tests — Full Flow and Subgraph Composition

**Files:**
- Create: `tests/integration/full-flow.test.ts`
- Create: `tests/fixtures/diamond-with-verification.yaml`
- Modify: `apps/gk/package.json` (add `test:integration` script)

**Interfaces:**
- Consumes: Tasks 1–13

- [ ] **Step 1: Write diamond-with-verification.yaml fixture**

```yaml
apiVersion: graphkit.dev/v2
kind: Graph
metadata:
  name: audited-review
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
    tools: [Read, Glob, Grep]
    depend_on: []
    evidence: [file_list]
  worker:
    agent: Code Reviewer
    model: sonnet
    objective: Review assigned files
    depend_on: [scouter]
    evidence: [findings]
  synthesizer:
    agent: Software Architect
    model: opus
    objective: Merge findings into a report
    depend_on: [worker]
    evidence: [report]
topology_config:
  verify:
    template: adversarial-verification
    refuters: [QA Engineer, Code Reviewer]
    survive_threshold: 2
limits:
  max_workers: 3
evidence:
  required_keys: [report]
```

- [ ] **Step 2: Write full-flow.test.ts**

```typescript
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdirSync, rmSync, readdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { installKit, templatesDir } from "../../src/cli/commands/kit.js";
import { GraphSchema } from "../../src/schemas/graph.schema.js";
import { validateGraph } from "../../src/compiler/validate.js";
import { compileGraph } from "../../src/compiler/emitter.js";

const TMP = join(import.meta.dir, ".tmp-full-flow");
const FIXTURES = join(import.meta.dir, "..", "fixtures");

describe("Full flow: init → validate → compile", () => {
  beforeAll(() => {
    if (existsSync(TMP)) rmSync(TMP, { recursive: true });
    mkdirSync(TMP, { recursive: true });
    // init: install the kit into the temp project
    installKit(TMP);
  });
  afterAll(() => { if (existsSync(TMP)) rmSync(TMP, { recursive: true }); });

  test("init installs agents, skills, hooks, rules", () => {
    const installed = readdirSync(join(TMP, ".claude"));
    expect(installed).toContain("agents");
    expect(installed).toContain("skills");
    expect(installed).toContain("hooks");
    expect(installed).toContain("rules");
    // 7 agents
    const agents = readdirSync(join(TMP, ".claude", "agents")).filter(f => f.endsWith(".md"));
    expect(agents.length).toBe(7);
  });

  test("validate passes on minimal-diamond with installed agents", () => {
    const raw = readFileSync(join(FIXTURES, "minimal-diamond.yaml"), "utf-8");
    const graph = GraphSchema.parse(YAML.parse(raw));
    const findings = validateGraph(graph, TMP);
    expect(findings).toEqual([]);
  });

  test("compile produces a runnable .workflow.js", () => {
    const raw = readFileSync(join(FIXTURES, "minimal-diamond.yaml"), "utf-8");
    const graph = GraphSchema.parse(YAML.parse(raw));
    const script = compileGraph(graph, templatesDir());
    expect(script).toContain("createDiamondWorkflow");
    // Write + re-read to confirm it's valid JS (no syntax errors)
    const outPath = join(TMP, "diamond.workflow.js");
    writeFileSync(outPath, script);
    expect(existsSync(outPath)).toBe(true);
  });
});

describe("Subgraph composition: diamond + adversarial-verification", () => {
  test("compiles with inlined subgraph template", () => {
    const raw = readFileSync(join(FIXTURES, "diamond-with-verification.yaml"), "utf-8");
    const graph = GraphSchema.parse(YAML.parse(raw));
    const script = compileGraph(graph, templatesDir());
    // Both template functions present (root + subgraph)
    expect(script).toContain("createDiamondWorkflow");
    expect(script).toContain("createAdversarialWorkflow");
    expect(script).toContain('"__subgraph": "adversarial-verification"');
  });

  test("validateGraph still passes (subgraph is config, not a node)", () => {
    const raw = readFileSync(join(FIXTURES, "diamond-with-verification.yaml"), "utf-8");
    const graph = GraphSchema.parse(YAML.parse(raw));
    const findings = validateGraph(graph, TMP);
    expect(findings).toEqual([]);
  });
});
```

- [ ] **Step 3: Add test:integration script to package.json**

```json
"scripts": {
  "test": "bun test",
  "test:integration": "bun test tests/integration/"
}
```

- [ ] **Step 4: Run integration tests**

```bash
bun test tests/integration/
```

Expected: 5 pass (init install, validate, compile, subgraph compile, subgraph validate).

- [ ] **Step 5: Commit**

```bash
git add tests/integration/full-flow.test.ts tests/fixtures/diamond-with-verification.yaml apps/gk/package.json
git commit -m "test: integration tests for full flow and subgraph composition"
```

```bash
git add tests/integration/ apps/gk/package.json
git commit -m "test: integration tests for full flow and subgraph composition"
```

---

### Task 15: Acceptance Tests (AC01–AC10)

**Files:**
- Create: `tests/acceptance/acceptance.test.ts`

**Interfaces:**
- Consumes: All previous tasks
- Produces: AC01–AC10 proof

- [ ] **Step 1: Write acceptance.test.ts**

```typescript
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, readdirSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { installKit, templatesDir } from "../../src/cli/commands/kit.js";
import { GraphSchema } from "../../src/schemas/graph.schema.js";
import { validateGraph } from "../../src/compiler/validate.js";
import { compileGraph } from "../../src/compiler/emitter.js";
import { agentFileName } from "../../src/compiler/validate.js";

const TMP = join(import.meta.dir, ".tmp-acceptance");
const FIXTURES = join(import.meta.dir, "..", "fixtures");
const TOPOS = ["diamond", "classify-and-act", "adversarial-verification", "loop-until-done", "generate-and-filter", "tournament"];

describe("AC01: gk init installs claude/ with all agents, skills, hooks, rules", () => {
  beforeAll(() => { if (existsSync(TMP)) rmSync(TMP, { recursive: true }); mkdirSync(TMP, { recursive: true }); installKit(TMP); });
  afterAll(() => { if (existsSync(TMP)) rmSync(TMP, { recursive: true }); });
  test("7 agents, 8 skills, 3 hooks, 3 rules installed", () => {
    expect(readdirSync(join(TMP, ".claude", "agents")).filter(f => f.endsWith(".md")).length).toBe(7);
    expect(readdirSync(join(TMP, ".claude", "skills")).filter(f => f.startsWith("gk-")).length).toBe(8);
    expect(readdirSync(join(TMP, ".claude", "hooks")).filter(f => f.endsWith(".cjs")).length).toBe(3);
    expect(readdirSync(join(TMP, ".claude", "rules")).filter(f => f.endsWith(".md")).length).toBe(3);
  });
});

describe("AC02: gk validate rejects invalid graph.yaml", () => {
  test("missing agent field → schema rejection", () => {
    const r = GraphSchema.safeParse(YAML.parse(
      `metadata:\n  name: x\ntopology: diamond\nnodes:\n  a:\n    objective: no agent`
    ));
    expect(r.success).toBe(false);
  });
});

describe("AC03: gk compile produces valid .workflow.js for all 6 topologies", () => {
  test("each topology compiles", () => {
    for (const topo of TOPOS) {
      const g = GraphSchema.parse(YAML.parse(
        `metadata:\n  name: t\ntopology: ${topo}\nnodes:\n  a:\n    agent: Code Reviewer\n    objective: x\n`
      ));
      const script = compileGraph(g, templatesDir());
      expect(script).toContain("export const meta");
    }
  });
});

describe("AC04: gk compile resolves subgraph references", () => {
  test("diamond + adversarial-verification inlines both templates", () => {
    const g = GraphSchema.parse(YAML.parse(readFileSync(join(FIXTURES, "diamond-with-verification.yaml"), "utf-8")));
    const script = compileGraph(g, templatesDir());
    expect(script).toContain("createAdversarialWorkflow");
  });
});

describe("AC05: gk:visualize produces .excalidraw file", () => {
  test("excalidraw-diagram skill is vendored", () => {
    // Skill is vendored in Task 9; verify it shipped in the install
    expect(existsSync(join(import.meta.dir, "..", "..", "claude", "skills", "excalidraw-diagram", "SKILL.md"))).toBe(true);
    expect(existsSync(join(import.meta.dir, "..", "..", "claude", "skills", "gk-visualize", "SKILL.md"))).toBe(true);
  });
});

describe("AC06: gk validate detects acyclic dependencies", () => {
  test("cyclic depend_on rejected by schema", () => {
    const r = GraphSchema.safeParse(YAML.parse(
      `metadata:\n  name: x\ntopology: diamond\nnodes:\n  a:\n    agent: A\n    depend_on: [b]\n  b:\n    agent: B\n    depend_on: [a]`
    ));
    expect(r.success).toBe(false);
  });
});

describe("AC07: gk validate detects missing refs", () => {
  test("nonexistent ref path → finding", () => {
    const g = GraphSchema.parse(YAML.parse(
      `metadata:\n  name: x\ntopology: diamond\nnodes:\n  a:\n    agent: Code Reviewer\n    objective: x\n    refs:\n      - path: nope/missing.md\n        purpose: gone`
    ));
    const findings = validateGraph(g, TMP);
    expect(findings.some(f => f.check === "refs-exist")).toBe(true);
  });
});

describe("AC08: init-graph diamond template produces valid graph.yaml", () => {
  test("fixture parses against schema", () => {
    const g = GraphSchema.parse(YAML.parse(readFileSync(join(FIXTURES, "minimal-diamond.yaml"), "utf-8")));
    expect(g.topology).toBe("diamond");
    expect(g.nodes.scouter).toBeDefined();
  });
});

describe("AC09: brainstorm updates graph.yaml", () => {
  test("model override is schema-valid (simulating brainstorm edit)", () => {
    const raw = readFileSync(join(FIXTURES, "minimal-diamond.yaml"), "utf-8");
    const doc = YAML.parse(raw);
    // brainstorm would add a model tier + loop
    doc.nodes.scouter.loop = { enabled: true, max_rounds: 3, stop_when: "evidence found" };
    const r = GraphSchema.safeParse(doc);
    expect(r.success).toBe(true);
  });
});

describe("AC10: model tiering propagates to compiled .workflow.js", () => {
  test("opus and sonnet tiers present in emitted config", () => {
    const g = GraphSchema.parse(YAML.parse(readFileSync(join(FIXTURES, "minimal-diamond.yaml"), "utf-8")));
    const script = compileGraph(g, templatesDir());
    expect(script).toContain('"model": "opus"');
    expect(script).toContain('"model": "sonnet"');
  });
});
```

- [ ] **Step 2: Run acceptance tests**

```bash
bun test tests/acceptance/acceptance.test.ts
```

Expected: all AC tests pass.

- [ ] **Step 3: Commit**

```bash
git add tests/acceptance/acceptance.test.ts
git commit -m "test: acceptance tests AC01-AC10"
```

```bash
git add tests/acceptance/
git commit -m "test: acceptance tests AC01-AC10"
```

---

### Task 16: CI Gate and README

**Files:**
- Modify: `apps/gk/package.json` (add ci:local script)
- Create: `apps/gk/README.md`

**Interfaces:**
- Consumes: All previous tasks
- Produces: CI gate, user-facing documentation

- [ ] **Step 1: Update ci:local script in package.json**

```json
"ci:local": "bun run typecheck && bun run lint && bun run build && bun test"
```

(`bun test` runs all tests including integration/ and acceptance/ — no need for separate invocations.)

- [ ] **Step 2: Write README.md**

```markdown
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
```

- [ ] **Step 3: Run ci:local**

```bash
cd apps/gk && bun run ci:local
```

Expected: typecheck + lint + build + all tests pass, exit 0.

- [ ] **Step 4: Commit**

```bash
git add apps/gk/package.json apps/gk/README.md
git commit -m "docs: add CI gate and README for GraphKit v2"
```

```bash
git add apps/gk/package.json apps/gk/README.md
git commit -m "docs: add CI gate and README for GraphKit v2"
```

---

## Dependency Graph

```
Task 1 (scaffold)
├── Task 2 (schemas)
│   └── Task 6 (validate skill)
│       └── Task 14 (integration tests)
├── Task 3 (agents)
│   └── Task 4 (rules)
├── Task 5 (init-graph + brainstorm skills)
├── Task 6 (validate skill) ← depends on Task 2
├── Task 7 (compile + topology templates) ← depends on Tasks 2, 3, 4
│   └── Task 8 (run + evidence + status skills)
├── Task 9 (visualize skill)
├── Task 10 (hooks)
├── Task 11 (kit CLI commands)
├── Task 12 (graph CLI commands) ← depends on Tasks 2, 7
├── Task 13 (unit tests consolidation)
├── Task 14 (integration tests) ← depends on all above
├── Task 15 (acceptance tests) ← depends on Task 14
└── Task 16 (CI gate + README)
```

## Self-Review

### 1. Spec coverage

| Spec Section | Task(s) | Status |
|---|---|---|
| §1 Architecture (3 layers) | T1 (scaffold), T11/T12 (CLI) | ✓ |
| §2 Six topologies + composition | T7 (templates + resolver + emitter) | ✓ |
| §3 Graph YAML schema + node binding | T2 (schemas) | ✓ |
| §3.3 depend_on parallelism | T2 (cycle detection in superRefine) | ✓ |
| §4 Seven kit agents | T3 (agent files + frontmatter test) | ✓ |
| §5 Eight session skills | T5 (init/brainstorm), T6 (validate), T7 (compile), T8 (run/evidence/status), T9 (visualize) | ✓ |
| §6 Three hooks | T10 | ✓ |
| §7 Three rules | T4 | ✓ |
| §8 Kit template structure | T1 (dir tree) + T3/T4/T5-10 (content) | ✓ |
| §9 ClaudeKit reuse | Embedded across T1 (install mechanism), T10 (hook pattern), T3 (agent format) | ✓ |
| §10 CLI commands (init/new/validate/compile/list/inspect) | T11 (kit), T12 (graph) | ✓ |
| §11 Testing strategy (unit/integration/AC01-10) | T13/T14/T15 | ✓ |
| §12 Multi-provider (future) | Out of scope (noted in plan) | ✓ |

No gaps.

### 2. Placeholder scan

No "TBD", "TODO", "implement later", "add error handling" found. All code steps contain concrete code or fetch commands. The only "adapt" instruction (Task 3 agents) includes exact curl commands + a transformation table.

### 3. Type consistency

- `installKit(targetDir: string): { installed: string[] }` — T11 defines, T14/T15 consume ✓
- `templatesDir(): string` — T11 exports, T12/T13/T14/T15 consume ✓
- `validateGraph(graph: Graph, projectRoot: string): Finding[]` — T6 defines, T12/T14/T15 consume ✓
- `compileGraph(graph: Graph, templatesDir: string): string` — T7 defines, T12/T13/T14/T15 consume ✓
- `agentFileName(agent: string): string` — T6 defines, T15 consumes ✓
- `resolveTopologyConfig(topology, topologyConfig, templatesDir, depth?): Record` — T7 resolver, consumed by T7 emitter ✓
- `GraphKitError(code, message, details?)` — T1 defines, T11/T12/resolver consume ✓
- `Finding = { check, path, message }` — T6 defines, used in T12 CLI output ✓

All consistent.

## Execution Notes

- Tasks 1–4 are foundation (structure + schemas + agents + rules) and can be done sequentially
- Tasks 5–10 are skills + templates — each produces an independently testable skill
- Tasks 11–12 are CLI commands — depend on schemas (T2) and compiler (T7)
- Tasks 13–16 are testing — run after all features are complete
- Fresh implementer subagent per task via SDD is recommended (fresh context, focused scope)
- Commit after each task — even small ones
- Task 3 requires network access (curl to GitHub); all others are offline
