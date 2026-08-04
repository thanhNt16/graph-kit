# GraphKit Orchestration MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a deterministic TypeScript/Bun `gk` CLI that installs Claude Code graph templates, drives checkpointed workflows, leases parallel agent work, validates submissions, and emits durable evidence without invoking a model.

**Architecture:** Templates are harness-neutral YAML plus JSON Schema. The CLI owns graph validation, edge selection, run state, locks, checkpoints, leases, merge policies, deterministic nodes, and evidence. A rendered Claude Code skill repeatedly asks `gk workflow next` for a contract, performs only harness work, then submits structured results.

**Tech Stack:** TypeScript, Bun, `cac`, `zod`, `yaml`, `ajv`, `ajv-formats`, `proper-lockfile`, Biome, Bun test.

## Global Constraints

- gk never invokes a model, spawns an agent, or reads an API key.
- gk alone selects edges and enforces limits; harnesses never infer transitions.
- Template-supplied agent output schemas are real JSON Schema validated with AJV; Zod validates GraphKit-owned structures.
- Run state is project-local JSON under `.graphkit/runs/<run-id>/`; every state write uses a run lock plus temp-file rename.
- Every accepted mutation carries `{ run_id, node, lease, actor, timestamp, checkpoint }` provenance and creates a checkpoint.
- Parallel work uses one expiring, single-use lease per work item and explicit state merge policies.
- Commands run without a shell, only from template-declared executable/argument arrays; state values are never shell-interpolated.
- MVP adapters: Claude Code only. No KG database, MCP, daemon, subgraphs, remote workers, model routing, or token accounting.
- Project and global template/skill installation are both required; project scope wins collisions.
- Keep dependencies to the listed stack. Use Bun/Node standard libraries elsewhere.

---

## File Map

```text
apps/gk/
├── package.json                         # scripts and dependencies
├── tsconfig.json                        # strict TS configuration
├── biome.json                           # formatter/linter
├── src/
│   ├── index.ts                         # process entry and error boundary
│   ├── cli/
│   │   ├── command-registry.ts          # all cac command declarations
│   │   └── output.ts                    # stable result envelope rendering
│   ├── errors.ts                        # GraphKitError and stable error codes
│   ├── schemas.ts                       # Zod schemas for GraphKit-owned data
│   ├── shared/
│   │   ├── files.ts                     # atomic JSON/text writes
│   │   ├── lock.ts                      # proper-lockfile wrapper
│   │   └── paths.ts                     # traversal and symlink containment
│   ├── runtime/
│   │   ├── expression.ts                # bounded predicate parser/evaluator
│   │   ├── merges.ts                    # eight state merge policies
│   │   ├── leases.ts                    # issue/validate/settle leases
│   │   ├── validation.ts                # AJV submission + static graph checks
│   │   ├── state-machine.ts             # deterministic graph transition logic
│   │   ├── store.ts                     # run files/events/checkpoints/provenance
│   │   └── contracts.ts                 # agent/dispatch/deterministic/human/terminal
│   ├── templates/
│   │   ├── loader.ts                    # YAML loading and reference resolution
│   │   ├── manifest.ts                  # owned paths and SHA-256 checksums
│   │   ├── registry.ts                  # atomic ~/.graphkit/registry.json
│   │   └── installer.ts                 # install/update/diff/remove rollback
│   ├── adapters/claude.ts               # Claude Code SKILL.md renderer
│   └── commands/
│       ├── template.ts                  # template lifecycle handlers
│       └── workflow.ts                  # workflow lifecycle handlers
├── templates/
│   ├── task-execute-verify/**           # evaluator-optimizer package
│   └── orchestrator-worker/**           # leased fan-out package
└── tests/
    ├── fixtures/**                       # minimal valid/invalid templates
    ├── unit/**                           # pure runtime behavior
    ├── integration/**                    # CLI/storage/install behavior
    └── replay/**                         # bundled template paths
```

---

### Task 1: CLI Foundation and Canonical Types

**Files:**
- Create: `apps/gk/package.json`
- Create: `apps/gk/tsconfig.json`
- Create: `apps/gk/biome.json`
- Create: `apps/gk/src/errors.ts`
- Create: `apps/gk/src/schemas.ts`
- Create: `apps/gk/src/cli/output.ts`
- Create: `apps/gk/src/cli/command-registry.ts`
- Create: `apps/gk/src/index.ts`
- Test: `apps/gk/tests/unit/schemas.test.ts`
- Test: `apps/gk/tests/unit/output.test.ts`

**Interfaces:**
- Produces: `GraphKitError`, `ResultEnvelope<T>`, `ok<T>()`, `fail()`, `TemplateSchema`, `WorkflowSchema`, `RunSchema`, `LeaseSchema`, and `createCli()`.
- Consumes: nothing.

- [ ] **Step 1: Add package configuration**

```json
{
  "name": "@graphkit/gk",
  "version": "0.1.0",
  "type": "module",
  "bin": { "gk": "dist/index.js" },
  "scripts": {
    "build": "bun build src/index.ts --target=node --outdir=dist",
    "typecheck": "tsc --noEmit",
    "lint": "biome check .",
    "test": "bun test",
    "ci:local": "bun run typecheck && bun run lint && bun run build && bun test"
  },
  "dependencies": {
    "ajv": "^8.17.1",
    "ajv-formats": "^3.0.1",
    "cac": "^6.7.14",
    "proper-lockfile": "^4.1.2",
    "yaml": "^2.8.1",
    "zod": "^4.0.17"
  },
  "devDependencies": {
    "@biomejs/biome": "^2.1.3",
    "@types/bun": "latest",
    "@types/proper-lockfile": "^4.1.4",
    "typescript": "^5.9.2"
  }
}
```

Run: `cd apps/gk && bun install`
Expected: `bun.lock` created; exit 0.

- [ ] **Step 2: Write failing schema and envelope tests**

```ts
import { describe, expect, test } from "bun:test";
import { AgentNodeSchema, RunSchema } from "../../src/schemas";

describe("canonical schemas", () => {
  test("agent nodes require an output JSON Schema path", () => {
    expect(() => AgentNodeSchema.parse({ id: "plan", type: "agent", skill: "planner", objective: "Plan" })).toThrow();
  });
  test("run verdict is closed", () => {
    expect(() => RunSchema.parse({ run_id: "r1", status: "done", current_nodes: [], pending_items: [], in_flight: {}, iteration: 1, failures: 0, verdict: "maybe" })).toThrow();
  });
});
```

```ts
import { expect, test } from "bun:test";
import { fail, ok } from "../../src/cli/output";

test("uses one stable machine envelope", () => {
  expect(ok({ id: "r1" })).toEqual({ ok: true, data: { id: "r1" } });
  expect(fail("LEASE_INVALID", "unknown lease", true)).toEqual({
    ok: false,
    error: { code: "LEASE_INVALID", message: "unknown lease", recoverable: true },
  });
});
```

- [ ] **Step 3: Run tests and confirm failure**

Run: `cd apps/gk && bun test tests/unit/schemas.test.ts tests/unit/output.test.ts`
Expected: FAIL with unresolved `src/schemas` and `src/cli/output`.

- [ ] **Step 4: Implement the minimum canonical types and envelope**

```ts
// src/errors.ts
export type ErrorCode =
  | "SCHEMA_VIOLATION" | "UNBOUNDED_CYCLE" | "UNREACHABLE_TERMINAL"
  | "MISSING_MERGE_POLICY" | "ERR_UNDECLARED_MERGE" | "ERR_MERGE_CONFLICT"
  | "ERR_EXPRESSION" | "LEASE_EXPIRED" | "LEASE_INVALID" | "UNSAFE_PATH"
  | "COMMAND_NOT_ALLOWED" | "INVALID_TRANSITION" | "MODIFIED_TARGET";

export class GraphKitError extends Error {
  constructor(public code: ErrorCode, message: string, public recoverable = false, public details?: unknown) {
    super(message);
  }
}
```

```ts
// src/cli/output.ts
import type { ErrorCode } from "../errors";
export type ResultEnvelope<T> = { ok: true; data: T } | { ok: false; error: { code: ErrorCode; message: string; recoverable: boolean; details?: unknown } };
export const ok = <T>(data: T): ResultEnvelope<T> => ({ ok: true, data });
export const fail = (code: ErrorCode, message: string, recoverable = false, details?: unknown): ResultEnvelope<never> => ({ ok: false, error: { code, message, recoverable, ...(details === undefined ? {} : { details }) } });
```

Implement Zod discriminated node schemas for `agent`, `command`, `validator`, `router`, `graph`, `human`, `fanout`, and `join`; edge, limits, state-field merge declarations, workflow, template manifest, run, lease, and event schemas. Export inferred TypeScript types.

- [ ] **Step 5: Register a minimal CLI and verify**

`createCli()` registers `--json` and `--version`; `index.ts` catches `GraphKitError`, prints the envelope, and sets exit code 1. No workflow commands yet.

Run: `cd apps/gk && bun test && bun run typecheck && bun run src/index.ts --version`
Expected: tests PASS; typecheck exit 0; version prints `0.1.0`.

- [ ] **Step 6: Commit**

```bash
git add apps/gk
git commit -m "feat: establish GraphKit CLI contracts

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Safe Persistent Files

**Files:**
- Create: `apps/gk/src/shared/paths.ts`
- Create: `apps/gk/src/shared/files.ts`
- Create: `apps/gk/src/shared/lock.ts`
- Test: `apps/gk/tests/unit/paths.test.ts`
- Test: `apps/gk/tests/unit/files.test.ts`

**Interfaces:**
- Produces: `safeResolve(base, relative)`, `writeJsonAtomic(path, value, immutable?)`, `appendEvent(path, event)`, `withDirectoryLock(dir, fn)`.
- Consumes: `GraphKitError` from Task 1.

- [ ] **Step 1: Write path-boundary tests**

```ts
import { expect, test } from "bun:test";
import { safeResolve } from "../../src/shared/paths";

test.each(["../x", "/tmp/x", "%2e%2e/x", "a/%2E%2E/x"])("rejects unsafe path %s", async path => {
  await expect(safeResolve("/tmp/project", path)).rejects.toMatchObject({ code: "UNSAFE_PATH" });
});

test("keeps a normal relative path inside base", async () => {
  expect(await safeResolve("/tmp/project", "templates/a")).toBe("/tmp/project/templates/a");
});
```

- [ ] **Step 2: Write atomic-write and lock tests**

Create a temp directory. Assert JSON round-trip, absence of `.tmp-*`, immutable checkpoint refusal, then launch two `withDirectoryLock` callbacks and assert their recorded order never overlaps.

- [ ] **Step 3: Run tests and confirm failure**

Run: `cd apps/gk && bun test tests/unit/paths.test.ts tests/unit/files.test.ts`
Expected: FAIL with missing modules.

- [ ] **Step 4: Implement containment, atomic rename, append, and locking**

`safeResolve` repeatedly decodes the relative input, rejects absolute paths and `..`, resolves existing parent realpaths, then verifies `relative(realBase, target)` does not start with `..`. `writeJsonAtomic` creates a sibling `.<basename>.tmp-<pid>`, writes and fsyncs, then renames. If `immutable` and target exists, throw. `withDirectoryLock` calls `proper-lockfile.lock(dir, { realpath: false })` and releases in `finally`.

- [ ] **Step 5: Verify**

Run: `cd apps/gk && bun test tests/unit/paths.test.ts tests/unit/files.test.ts && bun run typecheck`
Expected: PASS; exit 0.

- [ ] **Step 6: Commit**

```bash
git add apps/gk/src/shared apps/gk/tests/unit
git commit -m "feat: persist GraphKit files safely

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: Expressions, Merge Policies, and Leases

**Files:**
- Create: `apps/gk/src/runtime/expression.ts`
- Create: `apps/gk/src/runtime/merges.ts`
- Create: `apps/gk/src/runtime/leases.ts`
- Test: `apps/gk/tests/unit/expression.test.ts`
- Test: `apps/gk/tests/unit/merges.test.ts`
- Test: `apps/gk/tests/unit/leases.test.ts`

**Interfaces:**
- Produces: `resolveTemplate(value, scope)`, `evaluateCondition(expression, scope)`, `mergeStateField(declaration, previous, incoming)`, `issueLeases()`, `validateLease()`, `settleLease()`.
- Consumes: schemas/errors from Task 1.

- [ ] **Step 1: Write expression tests**

Assert `${{ inputs.task }}` resolution, nested property access, comparisons, `&&`, `||`, `!`, and null. Assert calls, assignment, arithmetic, brackets, and unknown roots throw `ERR_EXPRESSION`.

- [ ] **Step 2: Write all merge-policy tests**

```ts
expect(mergeStateField({ merge: "append_unique", identity: "id" }, [{ id: "a", n: 1 }], [{ id: "a", n: 2 }, { id: "b", n: 3 }])).toEqual([{ id: "a", n: 1 }, { id: "b", n: 3 }]);
expect(() => mergeStateField(undefined, 1, 2)).toThrowErrorMatchingObject({ code: "ERR_UNDECLARED_MERGE" });
expect(() => mergeStateField({ merge: "reject_conflict" }, "a", "b")).toThrowErrorMatchingObject({ code: "ERR_MERGE_CONFLICT" });
```

Cover `replace`, `append`, `append_unique`, `first`, `maximum`, `minimum`, `merge_object`, `reject_conflict`.

- [ ] **Step 3: Write lease lifecycle tests**

Use injected timestamps. Assert distinct IDs, active lease acceptance, wrong item rejection, expiry, single settlement, and duplicate settlement rejection.

- [ ] **Step 4: Run tests and confirm failure**

Run: `cd apps/gk && bun test tests/unit/expression.test.ts tests/unit/merges.test.ts tests/unit/leases.test.ts`
Expected: FAIL with missing modules.

- [ ] **Step 5: Implement minimal pure functions**

Use a tokenizer plus recursive-descent parser for the fixed expression grammar; do not use `eval` or `Function`. Use `crypto.randomUUID()` for lease IDs and injected `now` for tests. Keep each merge policy as one switch branch; `append_unique` keeps the first accepted identity.

- [ ] **Step 6: Verify and commit**

Run: `cd apps/gk && bun test tests/unit/expression.test.ts tests/unit/merges.test.ts tests/unit/leases.test.ts && bun run typecheck`
Expected: PASS.

```bash
git add apps/gk/src/runtime apps/gk/tests/unit
git commit -m "feat: add expressions merges and leases

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: Template Loading and Static Validation

**Files:**
- Create: `apps/gk/src/templates/loader.ts`
- Create: `apps/gk/src/runtime/validation.ts`
- Create: `apps/gk/tests/fixtures/valid-chain/{template.yaml,workflow.yaml,schemas/result.schema.json,skills/worker/SKILL.md}`
- Test: `apps/gk/tests/unit/template-validation.test.ts`

**Interfaces:**
- Produces: `loadTemplate(directory): Promise<LoadedTemplate>` and `validateTemplate(loaded): ValidationIssue[]`; `validateOutput(schemaPath, value): void` via AJV.
- Consumes: safe paths, Zod schemas, expression parser.

- [ ] **Step 1: Create a minimal valid fixture**

```yaml
# workflow.yaml
apiVersion: graphkit.dev/v1alpha1
kind: Workflow
metadata: { name: valid-chain }
inputs: { task: { type: string, required: true } }
limits: { max_iterations: 2, max_workers: 1, max_failures: 1 }
state: { result: { merge: replace } }
nodes:
  work:
    type: agent
    skill: worker
    objective: Complete the task.
    output: { schema: schemas/result.schema.json, save_as: result }
  complete: { type: graph, operation: complete-task }
edges:
  - { from: start, to: work }
  - { from: work, to: complete }
terminal:
  - { node: complete, verdict: passed }
```

- [ ] **Step 2: Write table-driven invalid-template tests**

Mutate the valid fixture in memory. Cover: duplicate/missing node, invalid start, missing edge target, unreachable terminal/state, terminal outgoing edge, unsupported node type, bad condition reference/syntax, unbounded cycle, loop without maximum, fanout without `max_workers`, join without merge policy, agent without output schema, human without actions, unsupported graph operation, missing skill, and missing referenced file. Assert stable codes including `UNBOUNDED_CYCLE`, `MISSING_MERGE_POLICY`, `UNREACHABLE_TERMINAL`, `SCHEMA_VIOLATION`.

- [ ] **Step 3: Write AJV boundary test**

```ts
const schema = resolve(fixture, "schemas/result.schema.json");
expect(() => validateOutput(schema, { summary: "done" })).not.toThrow();
expect(() => validateOutput(schema, { summary: 4 })).toThrowErrorMatchingObject({ code: "SCHEMA_VIOLATION" });
```

- [ ] **Step 4: Run tests and confirm failure**

Run: `cd apps/gk && bun test tests/unit/template-validation.test.ts`
Expected: FAIL with missing loader/validator.

- [ ] **Step 5: Implement loader and validator**

Parse YAML, validate owned structures with Zod, resolve every path through `safeResolve`, compile referenced output schemas with AJV 2020 plus formats, build adjacency/reverse-adjacency maps, run reachability and DFS cycle checks, and return all validation issues in deterministic node/code order.

- [ ] **Step 6: Verify and commit**

Run: `cd apps/gk && bun test tests/unit/template-validation.test.ts && bun run typecheck`
Expected: PASS.

```bash
git add apps/gk/src/templates apps/gk/src/runtime/validation.ts apps/gk/tests
git commit -m "feat: load and validate graph templates

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: Run Store and Deterministic State Machine

**Files:**
- Create: `apps/gk/src/runtime/store.ts`
- Create: `apps/gk/src/runtime/state-machine.ts`
- Test: `apps/gk/tests/unit/store.test.ts`
- Test: `apps/gk/tests/unit/state-machine.test.ts`

**Interfaces:**
- Produces: `createRun()`, `readRun()`, `mutateRun()`, `appendRunEvent()`, `resumeRun()`, `selectTransition(workflow, run, scope)`.
- Consumes: atomic files, locks, expressions, schemas.

- [ ] **Step 1: Write run-layout and mutation tests**

Create a run in a temp project. Assert `run.json`, `state.json`, `leases.json`, `events.jsonl`, and `checkpoints/0000-start.json`. Mutate once and assert immutable `0001-<node>.json`, event ordering, provenance fields, and no temp files.

- [ ] **Step 2: Write transition tests**

Cover sequential edge, conditional edge, `on_error` fallback, bounded retry counter increment before routing, terminal verdict, and refusal to advance past terminal. Assert only `selectTransition` chooses destinations.

- [ ] **Step 3: Write crash-resume test**

Corrupt `state.json` after checkpoint 2, call `resumeRun`, and assert state restored from checkpoint 2 without repeating a settled deterministic node.

- [ ] **Step 4: Run tests and confirm failure**

Run: `cd apps/gk && bun test tests/unit/store.test.ts tests/unit/state-machine.test.ts`
Expected: FAIL with missing modules.

- [ ] **Step 5: Implement the store and state machine**

`mutateRun` acquires one directory lock, reads all run documents, executes a pure mutator, appends one event, atomically writes current documents, then writes the immutable checkpoint. Store `last_completed_deterministic_nodes` for idempotency. State machine receives event/result context and returns a transition decision; it performs no I/O.

- [ ] **Step 6: Verify and commit**

Run: `cd apps/gk && bun test tests/unit/store.test.ts tests/unit/state-machine.test.ts && bun run typecheck`
Expected: PASS.

```bash
git add apps/gk/src/runtime apps/gk/tests/unit
git commit -m "feat: checkpoint workflow runs and transitions

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: Workflow Contracts, Submission, Parallel Fan-In, and Human Resume

**Files:**
- Create: `apps/gk/src/runtime/contracts.ts`
- Create: `apps/gk/src/commands/workflow.ts`
- Test: `apps/gk/tests/integration/workflow.test.ts`

**Interfaces:**
- Produces: `startWorkflow`, `nextWorkflow`, `submitWorkflow`, `executeWorkflow`; four `next` contracts: `agent`, `dispatch`, `deterministic`, `paused|terminal`.
- Consumes: loader, AJV validation, leases, merges, store, state machine.

- [ ] **Step 1: Write agent and deterministic contract tests**

Start the valid chain. Assert `nextWorkflow` returns node/objective/context/tools/output schema/limits/evidence and exact submit argv. For a command node, assert exact execute argv and no shell string.

- [ ] **Step 2: Write submission gate tests**

Assert valid JSON Schema output merges and checkpoints. Assert malformed output does not mutate. Assert stale, wrong-item, and consumed leases return stable errors and append rejection events.

- [ ] **Step 3: Write parallel dispatch and fan-in tests**

Use three work items, `max_workers: 2`, and `all-settled`. First `next` returns two distinct leases. Settle one success and one failure, then dispatch the third. After all settle, assert join opens, successful results remain, failed branch remains, and explicit merge policy applies. Add a simultaneous `Promise.all` submit to verify lock serialization.

- [ ] **Step 4: Write bounded retry and human-gate tests**

Drive evaluator verdict `retry` until `max_iterations`, assert terminal `limit-exceeded` without extension. Drive human node to `paused`, reconstruct the service, submit `approve`, and assert resume by run ID.

- [ ] **Step 5: Run tests and confirm failure**

Run: `cd apps/gk && bun test tests/integration/workflow.test.ts`
Expected: FAIL with missing contracts/handlers.

- [ ] **Step 6: Implement the four contracts and handlers**

Keep `nextWorkflow` side-effect-free except lease issuance/checkpoint required for dispatch. `submitWorkflow` validates before acquiring mutation lock, revalidates lease under lock, merges, consumes lease, stamps provenance, then asks the state machine for the next edge. `executeWorkflow` permits declared `graph`, `validator`, and command nodes only; use `Bun.spawn([executable, ...args], { shell: false })` and record stdout/stderr/exit code.

- [ ] **Step 7: Verify and commit**

Run: `cd apps/gk && bun test tests/integration/workflow.test.ts && bun run typecheck`
Expected: PASS.

```bash
git add apps/gk/src/runtime/contracts.ts apps/gk/src/commands/workflow.ts apps/gk/tests/integration
git commit -m "feat: execute leased workflow contracts

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 7: Template Registry, Claude Rendering, and Safe Lifecycle

**Files:**
- Create: `apps/gk/src/templates/manifest.ts`
- Create: `apps/gk/src/templates/registry.ts`
- Create: `apps/gk/src/templates/installer.ts`
- Create: `apps/gk/src/adapters/claude.ts`
- Create: `apps/gk/src/commands/template.ts`
- Test: `apps/gk/tests/integration/template-lifecycle.test.ts`

**Interfaces:**
- Produces: `listTemplates`, `inspectTemplate`, `newTemplate`, `renderClaudeSkills`, `installTemplate`, `diffTemplate`, `updateTemplate`, `removeTemplate`.
- Consumes: safe files/paths, loader/validator.

- [ ] **Step 1: Write renderer test**

Assert rendered `SKILL.md` has `name`, `description`, `when_to_use`, `user-invocable: true`; contains the `start/next/submit/execute` authority protocol; forbids inferred edges/limit increases; instructs bounded parallel subagent or Agent Team dispatch from leases.

- [ ] **Step 2: Write project/global installation tests**

Use temp `cwd` and `HOME`. Assert project files under `.graphkit/templates/<name>@<version>/` and `.claude/skills/`; global equivalents under `~/.graphkit/templates/` and `~/.claude/skills/`; registry records scope, source checksum, target checksums, install source, exact owned paths. Assert project lookup wins collision.

- [ ] **Step 3: Write lifecycle safety tests**

Assert `diff` detects a user edit, `update` rejects with `MODIFIED_TARGET`, `--dry-run` changes nothing, `--force` updates, and `remove` deletes only owned files. Inject a copy failure midway and assert snapshot restoration in reverse order. Re-run encoded traversal and symlink escape cases through installer entry points.

- [ ] **Step 4: Run tests and confirm failure**

Run: `cd apps/gk && bun test tests/integration/template-lifecycle.test.ts`
Expected: FAIL with missing modules.

- [ ] **Step 5: Implement registry, manifests, renderer, installer**

Registry writes atomically under a lock. Manifest paths are relative and validated. Installer stages all output in a temp directory, validates it, snapshots occupied targets, promotes files, then updates registry last; rollback reverses promoted paths and restores snapshots. `newTemplate` creates only the smallest valid chain fixture shape.

- [ ] **Step 6: Verify and commit**

Run: `cd apps/gk && bun test tests/integration/template-lifecycle.test.ts && bun run typecheck`
Expected: PASS.

```bash
git add apps/gk/src/templates apps/gk/src/adapters apps/gk/src/commands/template.ts apps/gk/tests/integration
git commit -m "feat: install and render Claude graph templates

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 8: Observability and CLI Wiring

**Files:**
- Modify: `apps/gk/src/cli/command-registry.ts`
- Modify: `apps/gk/src/index.ts`
- Modify: `apps/gk/src/commands/workflow.ts`
- Test: `apps/gk/tests/integration/cli.test.ts`

**Interfaces:**
- Produces CLI commands: `template list|inspect|install|new|validate|render|diff|update|remove`; `workflow start|next|execute|submit|status|trace|graph`; `evidence report`.
- Consumes: Tasks 6–7 services and output envelope.

- [ ] **Step 1: Write JSON CLI contract tests**

Spawn CLI for `template validate`, `workflow start`, `workflow next`, invalid lease, and status. Parse stdout and assert exactly one envelope; assert stable nonzero exit on errors.

- [ ] **Step 2: Write evidence/trace/Mermaid tests**

Drive a run containing one failed branch, command result, artifact, and human action. Assert evidence contains all of them permanently; trace is event order; graph begins `flowchart TD` and includes visited node classes and edge labels.

- [ ] **Step 3: Run tests and confirm failure**

Run: `cd apps/gk && bun test tests/integration/cli.test.ts`
Expected: FAIL because commands are unregistered.

- [ ] **Step 4: Register commands and implement read models**

Each cac handler calls one service, then one renderer. `status` reads run/counters/branches; `trace` reads JSONL; `evidence report` folds events without hiding failed attempts; `graph --format mermaid` renders template topology and run status. Generate `cli-manifest.json` from the command registry and add a parity test comparing command names/options.

- [ ] **Step 5: Verify and commit**

Run: `cd apps/gk && bun test tests/integration/cli.test.ts && bun run src/index.ts --help && bun run typecheck`
Expected: PASS; help lists every specified command.

```bash
git add apps/gk/src apps/gk/tests/integration apps/gk/cli-manifest.json
git commit -m "feat: expose workflow evidence and CLI commands

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 9: Bundled MVP Templates and Headless Replay

**Files:**
- Create: `apps/gk/templates/task-execute-verify/**`
- Create: `apps/gk/templates/orchestrator-worker/**`
- Create: `apps/gk/tests/replay/replay.test.ts`
- Create: `apps/gk/tests/integration/full-run.test.ts`

**Interfaces:**
- Produces two valid, installable templates with replay YAML for valid, retry, limit, lease-expiry, and parallel-conflict paths.
- Consumes: all runtime and lifecycle commands.

- [ ] **Step 1: Author `task-execute-verify` package**

Use nodes `load-context → plan → implement → verify → evaluate`; pass routes to optional human approval then complete; retry routes to implement while within limits; blocked/limit routes to fail. Include state merge declarations and JSON schemas for every agent output.

- [ ] **Step 2: Author `orchestrator-worker` package**

Use `load-context → plan → route → execute-workers → join → aggregate → verify → evaluate`; fanout uses leases and `all-settled`, explicit `append`/`append_unique` merge policies, bounded retry, optional human gate, complete/fail terminals. Rendered skills must tell Claude to spawn only leased items up to `max_workers`.

- [ ] **Step 3: Write replay cases before replay runner**

```yaml
name: retry-limit
inputs: { task: task-1, objective: fail safely }
steps:
  - expect: agent
    submit: { plan: [{ id: work-1 }] }
  - expect: agent
    submit: { artifacts: [], summary: attempted }
  - expect: deterministic
    execute: { exit_code: 1 }
  - expect: agent
    submit: { verdict: retry, failed_criteria: [tests] }
repeat: 2
expect_terminal: limit-exceeded
```

Add valid path, lease expiry, and parallel conflict cases for both templates.

- [ ] **Step 4: Run tests and confirm failure**

Run: `cd apps/gk && bun test tests/replay/replay.test.ts tests/integration/full-run.test.ts`
Expected: FAIL because replay driver/templates are incomplete.

- [ ] **Step 5: Implement the smallest replay driver in the test helper**

The helper starts a run, consumes expected contracts, calls submit/execute using fixture values, and checks terminal verdict. It is test-only; do not add a public `workflow replay` command.

- [ ] **Step 6: Add crash-resume and template-fork integration tests**

Run each template through terminal. Interrupt after checkpoint, recreate services, continue, and compare final evidence. Copy a bundled template, rename metadata, validate/install/run it without touching gk source.

- [ ] **Step 7: Verify and commit**

Run: `cd apps/gk && bun run src/index.ts template validate templates/task-execute-verify && bun run src/index.ts template validate templates/orchestrator-worker && bun test tests/replay tests/integration/full-run.test.ts`
Expected: both templates valid; all tests PASS.

```bash
git add apps/gk/templates apps/gk/tests
git commit -m "feat: ship GraphKit orchestration templates

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 10: Release Gate and Acceptance Proof

**Files:**
- Modify: `apps/gk/package.json`
- Create: `apps/gk/scripts/check-cli-parity.ts`
- Create: `apps/gk/tests/acceptance.test.ts`
- Create: `README.md`

**Interfaces:**
- Produces: one local gate proving every acceptance criterion and minimal install/run documentation.
- Consumes: all previous tasks.

- [ ] **Step 1: Write acceptance test mapping all 14 criteria**

Name tests `AC01` through `AC14`. Reuse public services/CLI only. Include harness-independent parsing, validation rejection, both install scopes, no-model agent contract, CLI-owned transitions, conditional branch, bounded retry, human resume, distinct leases/declared merge, duplicate lease rejection event, checkpoint/provenance, failed branch evidence, Mermaid, and forked template execution.

- [ ] **Step 2: Add CLI parity and bundled validation to `ci:local`**

```json
"ci:local": "bun run typecheck && bun run lint && bun run build && bun test && bun run scripts/check-cli-parity.ts && bun run src/index.ts template validate templates/task-execute-verify --json && bun run src/index.ts template validate templates/orchestrator-worker --json"
```

- [ ] **Step 3: Write minimal README**

Document install/build, project/global template install, `workflow start/next/submit/execute`, parallel lease behavior, resume, evidence, and the explicit no-model boundary. Do not document deferred harnesses or KG features as available.

- [ ] **Step 4: Run the complete gate**

Run: `cd apps/gk && bun run ci:local`
Expected: typecheck, Biome, build, all tests, parity, and both template validations PASS; exit 0.

- [ ] **Step 5: Run one real CLI smoke flow**

Run:

```bash
cd apps/gk
RUN_ID=$(bun run src/index.ts workflow start task-execute-verify --input task=smoke --input objective=verify --json | jq -r '.data.run_id')
bun run src/index.ts workflow next "$RUN_ID" --json
bun run src/index.ts workflow status "$RUN_ID" --json
bun run src/index.ts workflow graph "$RUN_ID" --format mermaid
```

Expected: valid agent contract, running status, and Mermaid output. Do not claim terminal success without submitting each returned contract.

- [ ] **Step 6: Commit**

```bash
git add apps/gk README.md
git commit -m "test: prove GraphKit orchestration MVP

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Acceptance Coverage

| Criterion | Task |
|---|---|
| Harness-independent nodes and edges | 1, 4 |
| Bundled validation; unreachable/unbounded rejection | 4, 9 |
| Claude skills at project/global scope | 7 |
| Agent execution protocol; gk never invokes model | 6, 7 |
| gk controls transitions | 5, 6 |
| Structured-result branching | 5, 6 |
| Bounded retry and terminal limit | 5, 6, 9 |
| Human pause/resume | 6 |
| Distinct leases and explicit merge | 3, 6 |
| Stale/duplicate lease rejection and logging | 3, 6 |
| Checkpoint and provenance per transition | 5, 6 |
| Failed branch retained in evidence | 6, 8 |
| Mermaid visualization | 8 |
| Forked template without source changes | 9 |

## Self-Review

- Spec coverage: all 14 acceptance criteria map to implementation tasks; project/global install, AJV submission validation, locks, atomic writes, rollback, observability, replay, and crash resume are explicit.
- Scope: KG storage, MCP, additional adapters, subgraphs, dashboard, remote workers, model routing, and token accounting remain excluded.
- Placeholder scan: no TBD/TODO, “implement later,” unspecified error handling, or “similar to” steps.
- Type consistency: workflow files use node maps keyed by ID; loaded nodes receive their key as `id`; run fields retain spec snake_case; lease functions use `work_item`; all machine failures use `GraphKitError` and `ResultEnvelope`.
- Correction from initial draft: AJV validates arbitrary template JSON Schema; Zod validates only GraphKit-owned manifests, workflows, runs, leases, and events.
