# Session Graph Store, Loop Groups, Template Materialization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship three interlocking graph-kit runtime features: active-pointer session graph store (`.graphkit/graphs/`), multi-node loop groups with hybrid stop conditions, and `gk template materialize` with a built-in gallery.

**Architecture:**
- **Store:** `.graphkit/graphs/<id>.yaml` + `.graphkit/active` pointer file. All create/switch/list ops flow through a dedicated `src/store/` module; `gk execute` / `gk validate` default to active graph.
- **Loops:** Top-level `loops:` array added to `GraphSchema`; validated in `src/compiler/validate.ts` for wave-contiguity, disallowing overlap, and checking `gate_evidence` key binding; execution semantics documented for `gk-execute`.
- **Materialization:** `src/cli/commands/template.ts` extended with `materialize` subcommand, resolving project → global → bundled gallery in `templates/gallery/*.gk.yaml`, substituting `{{param}}` placeholders via `GraphTemplate` schema.

**Tech Stack:** TypeScript, Bun test runner, YAML parser (`yaml`), Zod schema validation, CAC CLI framework, Biome linter.

**Spec:** `docs/superpowers/specs/2026-08-26-graph-runtime-design.md`

## Global Constraints

- Never break existing `graph.yaml` execution via explicit path argument (`gk execute ./graph.yaml`).
- Zero dependencies added; use built-in node/bun stdlib and existing `yaml`/`zod` packages.
- All new CLI commands must implement `--json` structured output.
- All tests must pass: `bun test`, `bun run lint`, `bun run typecheck`, `bun run check-changelog`.
- Follow `ponytail:` comment convention on deliberate simplifications.

---

### Task 1: Schema Updates — Loop Groups & Loops Array

**Files:**
- Modify: `src/schemas/graph.schema.ts`
- Test: `tests/unit/loop-schema.test.ts`

**Interfaces:**
- Produces: `LoopGroupSchema`, `LoopGroup` type, `loops` optional array on `GraphSchema`.
- Consumes: Zod primitives from `zod`.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/loop-schema.test.ts
import { describe, expect, it } from "bun:test";
import { GraphSchema } from "../../src/schemas/graph.schema.js";

describe("LoopGroupSchema", () => {
  it("parses valid loop group with stop_when", () => {
    const doc = {
      apiVersion: "graphkit.dev/v2",
      kind: "Graph",
      metadata: { name: "test" },
      topology: "custom",
      nodes: {
        a: { agent: "coder", objective: "code" },
        b: { agent: "tester", objective: "test", depend_on: ["a"] },
      },
      loops: [
        {
          nodes: ["a", "b"],
          max_rounds: 3,
          stop_when: "tests pass",
        },
      ],
    };
    const parsed = GraphSchema.safeParse(doc);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.loops?.[0].nodes).toEqual(["a", "b"]);
      expect(parsed.data.loops?.[0].max_rounds).toBe(3);
    }
  });

  it("parses loop group with gate_evidence", () => {
    const doc = {
      apiVersion: "graphkit.dev/v2",
      kind: "Graph",
      metadata: { name: "test" },
      topology: "custom",
      nodes: {
        a: { agent: "coder", objective: "code" },
      },
      loops: [
        {
          nodes: ["a"],
          max_rounds: 5,
          gate_evidence: ["test-report"],
        },
      ],
    };
    const parsed = GraphSchema.safeParse(doc);
    expect(parsed.success).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/loop-schema.test.ts`
Expected: FAIL (loops field stripped or schema reject)

- [ ] **Step 3: Modify `src/schemas/graph.schema.ts`**

Add `LoopGroupSchema` and wire into `GraphSchema`:

```typescript
export const LoopGroupSchema = z.object({
  nodes: z.array(z.string().min(1)).min(1),
  max_rounds: z.number().int().min(1),
  stop_when: z.string().min(1).optional(),
  gate_evidence: z.array(z.string().min(1)).min(1).optional(),
}).refine(
  (data) => Boolean(data.stop_when || data.gate_evidence),
  { message: "At least one of stop_when or gate_evidence must be provided" }
);

export type LoopGroup = z.infer<typeof LoopGroupSchema>;

// Add to GraphSchema object definition:
// loops: z.array(LoopGroupSchema).optional(),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/loop-schema.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/schemas/graph.schema.ts tests/unit/loop-schema.test.ts
git commit -m "feat(schema): add LoopGroupSchema and top-level loops array to GraphSchema"
```

---

### Task 2: Compiler Validation — Loop Group Rules

**Files:**
- Modify: `src/compiler/validate.ts`
- Test: `tests/unit/loop-validation.test.ts`

**Interfaces:**
- Consumes: `GraphSchema`, `Graph` type, `LoopGroup` from `src/schemas/graph.schema.ts`.
- Produces: Validation findings with codes `LOOP_NODE_NOT_FOUND`, `LOOP_NON_CONTIGUOUS`, `LOOP_OVERLAP`, `LOOP_GATE_KEY_NOT_FOUND`.

- [ ] **Step 1: Write failing validation tests**

```typescript
// tests/unit/loop-validation.test.ts
import { describe, expect, it } from "bun:test";
import { validateGraph } from "../../src/compiler/validate.js";
import type { Graph } from "../../src/schemas/graph.schema.js";

describe("Loop Group Validation", () => {
  it("rejects non-existent node in loop", () => {
    const graph: Graph = {
      apiVersion: "graphkit.dev/v2",
      kind: "Graph",
      metadata: { name: "test" },
      topology: "custom",
      nodes: { a: { agent: "coder", objective: "code" } },
      loops: [{ nodes: ["a", "missing"], max_rounds: 3, stop_when: "ok" }],
    };
    const findings = validateGraph(graph, ".");
    expect(findings.some((f) => f.rule === "loop_node_exists")).toBe(true);
  });

  it("rejects overlapping loop groups", () => {
    const graph: Graph = {
      apiVersion: "graphkit.dev/v2",
      kind: "Graph",
      metadata: { name: "test" },
      topology: "custom",
      nodes: {
        a: { agent: "coder", objective: "code" },
        b: { agent: "tester", objective: "test" },
      },
      loops: [
        { nodes: ["a", "b"], max_rounds: 3, stop_when: "ok" },
        { nodes: ["b"], max_rounds: 2, stop_when: "ok" },
      ],
    };
    const findings = validateGraph(graph, ".");
    expect(findings.some((f) => f.rule === "loop_no_overlap")).toBe(true);
  });

  it("rejects gate_evidence key missing from loop nodes", () => {
    const graph: Graph = {
      apiVersion: "graphkit.dev/v2",
      kind: "Graph",
      metadata: { name: "test" },
      topology: "custom",
      nodes: { a: { agent: "coder", objective: "code" } },
      loops: [{ nodes: ["a"], max_rounds: 3, gate_evidence: ["non-existent-key"] }],
    };
    const findings = validateGraph(graph, ".");
    expect(findings.some((f) => f.rule === "loop_gate_evidence_declared")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/loop-validation.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement validation rules in `src/compiler/validate.ts`**

Add loop group checks:
1. `loop_node_exists`: verify all `loop.nodes` exist in `graph.nodes`.
2. `loop_no_overlap`: ensure intersection of all `loop.nodes` sets is empty.
3. `loop_gate_evidence_declared`: ensure each key in `gate_evidence` appears in at least one loop node's `evidence.required_keys` or `output.evidence_key`.
4. `loop_contiguous`: topological wave check ensuring loop nodes form a closed dependency set against intermediate waves.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/loop-validation.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/compiler/validate.ts tests/unit/loop-validation.test.ts
git commit -m "feat(validate): add loop group validation rules (existence, overlap, gate evidence, contiguity)"
```

---

### Task 3: Session Graph Store Module

**Files:**
- Create: `src/store/index.ts`
- Test: `tests/unit/graph-store.test.ts`

**Interfaces:**
- Produces:
  - `saveSessionGraph(graph: Graph, slug: string, baseDir?: string): { id: string, path: string }`
  - `getActiveGraphId(baseDir?: string): string | null`
  - `setActiveGraphId(id: string, baseDir?: string): void`
  - `listSessionGraphs(baseDir?: string): Array<{ id: string, path: string, name: string, task?: string, createdAt: Date }>`
  - `loadActiveGraph(baseDir?: string): { id: string, graph: Graph, path: string }`

- [ ] **Step 1: Write failing store tests**

```typescript
// tests/unit/graph-store.test.ts
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  getActiveGraphId,
  listSessionGraphs,
  loadActiveGraph,
  saveSessionGraph,
  setActiveGraphId,
} from "../../src/store/index.js";
import type { Graph } from "../../src/schemas/graph.schema.js";

const TEST_DIR = join(import.meta.dir, ".tmp-store-test");

beforeEach(() => {
  mkdirSync(join(TEST_DIR, ".graphkit", "graphs"), { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("Session Graph Store", () => {
  const sampleGraph: Graph = {
    apiVersion: "graphkit.dev/v2",
    kind: "Graph",
    metadata: { name: "my-task", description: "Audit auth" },
    topology: "custom",
    nodes: { a: { agent: "coder", objective: "fix" } },
  };

  it("saves graph and sets active", () => {
    const { id, path } = saveSessionGraph(sampleGraph, "my-task", TEST_DIR);
    expect(id).toMatch(/^\d{4}-\d{2}-\d{2}-my-task/);
    setActiveGraphId(id, TEST_DIR);
    expect(getActiveGraphId(TEST_DIR)).toBe(id);

    const loaded = loadActiveGraph(TEST_DIR);
    expect(loaded.id).toBe(id);
    expect(loaded.graph.metadata.name).toBe("my-task");
  });

  it("lists saved session graphs", () => {
    saveSessionGraph(sampleGraph, "task-1", TEST_DIR);
    saveSessionGraph(sampleGraph, "task-2", TEST_DIR);
    const list = listSessionGraphs(TEST_DIR);
    expect(list.length).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/graph-store.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement `src/store/index.ts`**

Write the store implementation with ISO-date timestamping, slug formatting, YAML serialization, and active pointer file management (`.graphkit/active`).

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/graph-store.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/store/index.ts tests/unit/graph-store.test.ts
git commit -m "feat(store): add session graph storage engine and active pointer manager"
```

---

### Task 4: CLI Commands — `gk graph list / switch / show`

**Files:**
- Modify: `src/cli/commands/graph.ts`
- Modify: `src/cli/command-registry.ts`
- Test: `tests/unit/graph-store-cli.test.ts`

**Interfaces:**
- Produces: CLI commands `gk graph list`, `gk graph switch <id>`, `gk graph show [id]`.
- Consumes: `src/store/index.ts`.

- [ ] **Step 1: Write failing CLI tests**

```typescript
// tests/unit/graph-store-cli.test.ts
import { describe, expect, it } from "bun:test";
import { execSync } from "node:child_process";

describe("gk graph session commands", () => {
  it("registers list and switch commands in CLI registry", async () => {
    const { subcommandsFor } = await import("../../src/cli/command-registry.js");
    const subcommands = subcommandsFor("graph");
    expect(subcommands).toContain("list");
    expect(subcommands).toContain("switch");
    expect(subcommands).toContain("show");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/graph-store-cli.test.ts`
Expected: FAIL

- [ ] **Step 3: Wire subcommands in `src/cli/commands/graph.ts` and `src/cli/command-registry.ts`**

Implement `list`, `switch`, `show` subcommands with table output and `--json` support.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/graph-store-cli.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/graph.ts src/cli/command-registry.ts tests/unit/graph-store-cli.test.ts
git commit -m "feat(cli): add gk graph list, switch, and show subcommands"
```

---

### Task 5: Template Materialize & Gallery

**Files:**
- Create: `templates/gallery/audit-pr.gk.yaml`
- Create: `templates/gallery/refactor-module.gk.yaml`
- Create: `templates/gallery/bench-eval.gk.yaml`
- Create: `templates/gallery/doc-sweep.gk.yaml`
- Modify: `src/cli/commands/template.ts`
- Test: `tests/unit/template-materialize.test.ts`

**Interfaces:**
- Produces: `gk template materialize <name> [--params '<json>'] [--use]` command.
- Consumes: `GraphTemplateSchema`, `saveSessionGraph`, `setActiveGraphId`.

- [ ] **Step 1: Write failing materialize test**

```typescript
// tests/unit/template-materialize.test.ts
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { materializeTemplate } from "../../src/cli/commands/template.js";

const TEST_DIR = join(import.meta.dir, ".tmp-mat-test");

beforeEach(() => {
  mkdirSync(join(TEST_DIR, ".graphkit", "graphs"), { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("Template Materialize", () => {
  it("substitutes parameters and writes session graph", () => {
    const result = materializeTemplate("audit-pr", { task: "audit auth module" }, {
      cwd: TEST_DIR,
      use: true,
    });
    expect(result.id).toBeDefined();
    expect(result.graph.metadata.description).toContain("audit auth module");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/template-materialize.test.ts`
Expected: FAIL

- [ ] **Step 3: Create gallery templates and implement `materializeTemplate` in `src/cli/commands/template.ts`**

1. Create 4 gallery files in `templates/gallery/`.
2. Add gallery directory resolution to `resolveTemplate()`.
3. Implement placeholder substitution (`{{param}}`).
4. Validate the resulting graph against `validateGraph()`.
5. Call `saveSessionGraph()` and conditionally `setActiveGraphId()`.
6. Add `materialize` subcommand to CAC CLI parser.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/template-materialize.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add templates/gallery/ src/cli/commands/template.ts tests/unit/template-materialize.test.ts
git commit -m "feat(template): add template gallery and gk template materialize command"
```

---

### Task 6: Skill Updates, Documentation & Changelog

**Files:**
- Modify: `.omp/skills/gk-init-graph/SKILL.md`
- Modify: `.omp/skills/gk-execute/SKILL.md`
- Modify: `README.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Update skill documents**
  - Add loop group execution and hybrid stop ladder instructions to `gk-execute/SKILL.md`.
  - Add template gallery routing to `gk-init-graph/SKILL.md`.

- [ ] **Step 2: Update README.md and CHANGELOG.md**
  - Document `gk graph list/switch/show` and `gk template materialize` in README CLI table.
  - Document loop group syntax in README.
  - Add `[Unreleased]` entries in `CHANGELOG.md`.

- [ ] **Step 3: Run full verification suite**

Run: `bun run ci:local`
Expected: PASS (typecheck, lint, build, viewer, tests, changelog check)

- [ ] **Step 4: Commit**

```bash
git add .omp/skills/ README.md CHANGELOG.md
git commit -m "docs: document session graph store, loop groups, and template gallery; update changelog"
```

---

## Plan Review & Verification Checklist
1. **Coverage**: Covers all 3 design spec features (Store, Loops, Materialize).
2. **Safety**: No breaking changes to existing `graph.yaml` direct executions.
3. **Quality**: TDD on every task with explicit failing/passing assertions.
4. **CI Compliance**: Passes `bun run ci:local`.
