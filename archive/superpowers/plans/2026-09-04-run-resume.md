# gk run --resume Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `gk run resume <run-id>` reconciles a failed/interrupted run's ledger against its graph and produces a derived pending-only session graph plus a fresh run that references the parent.

**Architecture:** New pure module `src/memory/resume.ts` (reconcile → derive) on top of existing ledger primitives; `startRun` gains an optional `resumes` provenance param; CLI wires a `run resume` subcommand. No schema changes, no runtime changes — the host's execute-skill dispatches the derived graph like any other.

**Tech Stack:** TypeScript (Bun runtime), zod schemas, `bun:test`, YAML.

## Global Constraints

- Evidence key → file contract (ADR-002): key `k` maps to `<evidence_dir>/<k>.md`, satisfied iff exists and non-empty after trim. Evidence dir comes from `graph.outputs.evidence_dir` (default `.graphkit/evidence/`), joined to cwd.
- Output envelopes: `ok(data)` / `fail(code, message, extra?)` from `src/cli/output.ts`; errors thrown as `Error("CODE: message")` and parsed by `errCode` in `src/cli/commands/run.ts`.
- Test suite runs green: `bun test` (baseline 542 pass / 1 skip). No new dependencies. Never edit `.omp/` or `src/eval/**`.
- gk never invokes a model — resume is pure file reconciliation + derivation.
- Satisfied rule: last trace line for the node has `status === "ok"` AND every key in that line's `evidence[]` exists non-empty on disk.
- Pending closure: `pending = ¬satisfied ∪ dependents(pending)` — a node whose dep is pending is pending even if it previously passed.
- Drift: `meta.json` of the run records `graph_path` + `graph_sha256` (written by `startRun`). Mismatch or missing file → `RESUME_GRAPH_DRIFT`.

---

### Task 1: Reconciler — `reconcileRun`

**Files:**
- Create: `src/memory/resume.ts`
- Modify: `src/memory/ledger.ts` (export `readRunMeta`)
- Test: `tests/unit/run-resume.test.ts` (new)

**Interfaces:**
- Consumes: `readTrace(cwd, id): TraceLine[]`, `listRunIds(cwd): string[]` from `src/memory/ledger.js`; `GraphSchema` from `src/schemas/graph.schema.js`.
- Produces:
  - `readRunMeta(cwd: string, id: string): RunMeta` in ledger.ts where `RunMeta = { id: string; graph: string; graph_path: string; graph_sha256: string; started_at: string; ended_at?: string; resumes?: string }` (raw `JSON.parse` of `meta.json`, throws `RESUME_RUN_NOT_FOUND` if dir/meta missing).
  - `interface Reconciliation { runId: string; graphPath: string; graph: Graph; evidenceDir: string; satisfied: string[]; pending: string[]; skipped: Array<{ node: string; reason: string }> }`
  - `reconcileRun(cwd: string, runId: string, opts?: { fromNode?: string; force?: boolean }): Reconciliation` — throws `Error("RESUME_RUN_NOT_FOUND: …")`, `Error("RESUME_GRAPH_DRIFT: …")`, `Error("RESUME_BAD_FROM_NODE: …")`.

- [ ] **Step 1: Write failing tests**

```ts
// tests/unit/run-resume.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { endRun, startRun } from "../../src/memory/ledger.js";
import { reconcileRun } from "../../src/memory/resume.js";

const GRAPH = `apiVersion: graphkit.dev/v2
kind: Graph
metadata:
  name: demo
- [ ] **Step 1: Write failing tests**

```ts
// tests/unit/run-resume.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendNode, endRun, startRun } from "../../src/memory/ledger.js";
import { reconcileRun } from "../../src/memory/resume.js";

const GRAPH = `apiVersion: graphkit.dev/v2
kind: Graph
metadata:
  name: demo
topology: custom
nodes:
  a:
    agent: scout
    objective: Do A
    evidence: [a-out]
  b:
    agent: task
    objective: Do B
    depend_on: [a]
    evidence: [b-out]
  c:
    agent: reviewer
    objective: Do C
    depend_on: [b]
`;

let cwd: string;
beforeEach(() => {
  cwd = join(tmpdir(), `gk-resume-${process.pid}-${Date.now()}`);
  mkdirSync(join(cwd, ".graphkit", "runs"), { recursive: true });
  mkdirSync(join(cwd, ".graphkit", "evidence"), { recursive: true });
  writeFileSync(join(cwd, "graph.yaml"), GRAPH);
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

function writeEvidence(dir: string, key: string, text = "content\n") {
  writeFileSync(join(dir, ".graphkit", "evidence", `${key}.md`), text);
}
function traceOk(dir: string, node: string, evidence: string[]) {
  appendNode(dir, { node, wave: 0, agent: "x", model: null, status: "ok", evidence, duration_ms: 10, notes: null });
}
function traceFail(dir: string, node: string) {
  appendNode(dir, { node, wave: 0, agent: "x", model: null, status: "fail", evidence: [], duration_ms: 10, notes: null });
}

describe("reconcileRun", () => {
  test("unknown run id throws RESUME_RUN_NOT_FOUND", () => {
    expect(() => reconcileRun(cwd, "20990101-000000-demo")).toThrow(/RESUME_RUN_NOT_FOUND/);
  });

  test("ok + evidence on disk = satisfied; fail = pending; untraced = pending", () => {
    const { id } = startRun(cwd, join(cwd, "graph.yaml"), "2026-09-04T10:00:00.000Z");
    writeEvidence(cwd, "a-out");
    traceOk(cwd, "a", ["a-out"]);
    traceFail(cwd, "b");
    endRun(cwd, "failed", "2026-09-04T10:05:00.000Z");

    const rec = reconcileRun(cwd, id);
    expect(rec.satisfied).toEqual(["a"]);
    expect(rec.pending).toEqual(["b", "c"]); // c untraced → pending
  });

  test("ok status but evidence file missing → pending", () => {
    const { id } = startRun(cwd, join(cwd, "graph.yaml"), "2026-09-04T10:00:00.000Z");
    traceOk(cwd, "a", ["a-out"]); // no .graphkit/evidence/a-out.md
    endRun(cwd, "failed", "2026-09-04T10:05:00.000Z");
    const rec = reconcileRun(cwd, id);
    expect(rec.pending).toContain("a");
  });

  test("last trace line wins (loop rounds)", () => {
    const { id } = startRun(cwd, join(cwd, "graph.yaml"), "2026-09-04T10:00:00.000Z");
    traceFail(cwd, "a");
    writeEvidence(cwd, "a-out");
    traceOk(cwd, "a", ["a-out"]);
    endRun(cwd, "failed", "2026-09-04T10:05:00.000Z");
    expect(reconcileRun(cwd, id).satisfied).toEqual(["a"]);
  });

  test("pending closure: dependents of pending are pending even if they passed", () => {
    const { id } = startRun(cwd, join(cwd, "graph.yaml"), "2026-09-04T10:00:00.000Z");
    traceFail(cwd, "a");
    writeEvidence(cwd, "b-out");
    traceOk(cwd, "b", ["b-out"]); // b passed before a failed upstream
    endRun(cwd, "failed", "2026-09-04T10:05:00.000Z");
    const rec = reconcileRun(cwd, id);
    expect(rec.pending).toEqual(["a", "b", "c"]);
  });

  test("graph changed since run → RESUME_GRAPH_DRIFT", () => {
    const { id } = startRun(cwd, join(cwd, "graph.yaml"), "2026-09-04T10:00:00.000Z");
    endRun(cwd, "failed", "2026-09-04T10:05:00.000Z");
    writeFileSync(join(cwd, "graph.yaml"), GRAPH + "# drifted\n");
    expect(() => reconcileRun(cwd, id)).toThrow(/RESUME_GRAPH_DRIFT/);
    expect(() => reconcileRun(cwd, id, { force: true })).not.toThrow();
  });

  test("recorded graph file gone → RESUME_GRAPH_DRIFT", () => {
    const { id } = startRun(cwd, join(cwd, "graph.yaml"), "2026-09-04T10:00:00.000Z");
    endRun(cwd, "failed", "2026-09-04T10:05:00.000Z");
    rmSync(join(cwd, "graph.yaml"));
    expect(() => reconcileRun(cwd, id)).toThrow(/RESUME_GRAPH_DRIFT/);
  });

  test("--from-node selects node + transitive dependents regardless of satisfaction", () => {
    const { id } = startRun(cwd, join(cwd, "graph.yaml"), "2026-09-04T10:00:00.000Z");
    writeEvidence(cwd, "a-out");
    writeEvidence(cwd, "b-out");
    traceOk(cwd, "a", ["a-out"]);
    traceOk(cwd, "b", ["b-out"]);
    endRun(cwd, "merged", "2026-09-04T10:05:00.000Z");
    const rec = reconcileRun(cwd, id, { fromNode: "b" });
    expect(rec.pending).toEqual(["b", "c"]); // b re-runs by explicit request
    expect(rec.satisfied).toEqual(["a"]);
  });

  test("fromNode not in graph → RESUME_BAD_FROM_NODE", () => {
    const { id } = startRun(cwd, join(cwd, "graph.yaml"), "2026-09-04T10:00:00.000Z");
    endRun(cwd, "failed", "2026-09-04T10:05:00.000Z");
    expect(() => reconcileRun(cwd, id, { fromNode: "zzz" })).toThrow(/RESUME_BAD_FROM_NODE/);
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `bun test tests/unit/run-resume.test.ts`
Expected: FAIL — `Cannot find module '../../src/memory/resume.js'` / `readRunMeta` not exported.

- [ ] **Step 3: Implement**

`src/memory/ledger.ts` — add export (near `readTrace`):

```ts
export interface RunMeta {
  id: string;
  graph: string;
  graph_path: string;
  graph_sha256: string;
  started_at: string;
  ended_at?: string;
  resumes?: string;
}

/** meta.json of a recorded run; strict ids keep callers honest. */
export function readRunMeta(cwd: string, id: string): RunMeta {
  const dir = join(runsDir(cwd), id);
  const file = join(dir, "meta.json");
  if (!/^\d{8}-\d{6}-[\w.-]+$/.test(id) || !existsSync(file)) {
    throw new Error(`RESUME_RUN_NOT_FOUND: no run "${id}" under ${runsDir(cwd)}`);
  }
  return JSON.parse(readFileSync(file, "utf-8")) as RunMeta;
}
```

Create `src/memory/resume.ts`:

```ts
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { readRunMeta, readTrace, type TraceLine } from "./ledger.js";
import { GraphSchema } from "../schemas/graph.schema.js";
import type { Graph } from "../compiler/validate.js";

export interface Reconciliation {
  cwd: string;
  runId: string;
  graphPath: string;
  graph: Graph;
  evidenceDir: string;
  satisfied: string[];
  pending: string[];
  skipped: Array<{ node: string; reason: string }>;
}
```

```ts
function parseGraph(path: string): Graph {
  const parsed = GraphSchema.safeParse(YAML.parse(readFileSync(path, "utf-8")));
  if (!parsed.success) {
    throw new Error(`RESUME_GRAPH_INVALID: recorded graph ${path} no longer parses: ${parsed.error.issues[0]?.message}`);
  }
  return parsed.data;
}

/** ADR-002: key k → <evidenceDir>/<k>.md, satisfied iff exists and non-empty after trim. */
function evidenceOnDisk(cwd: string, evidenceDir: string, keys: string[]): boolean {
  return keys.every((k) => {
    const p = join(cwd, evidenceDir, `${k}.md`);
    if (!existsSync(p)) return false;
    return readFileSync(p, "utf-8").trim().length > 0;
  });
}

export function reconcileRun(
  cwd: string,
  runId: string,
  opts: { fromNode?: string; force?: boolean } = {},
): Reconciliation {
  const meta = readRunMeta(cwd, runId);

  if (!opts.force) {
    if (!existsSync(meta.graph_path)) {
      throw new Error(`RESUME_GRAPH_DRIFT: recorded graph ${meta.graph_path} no longer exists (re-run gk init/graph, or --force)`);
    }
    const sha = createHash("sha256").update(readFileSync(meta.graph_path, "utf-8")).digest("hex");
    if (sha !== meta.graph_sha256) {
      throw new Error(`RESUME_GRAPH_DRIFT: ${meta.graph_path} changed since run ${runId} started (expected sha ${meta.graph_sha256.slice(0, 12)}…) — use --force to override`);
    }
  }

  const graph = parseGraph(meta.graph_path);
  const names = Object.keys(graph.nodes);
  if (opts.fromNode != null && !names.includes(opts.fromNode)) {
    throw new Error(`RESUME_BAD_FROM_NODE: --from-node "${opts.fromNode}" is not a node of ${meta.graph_path}`);
  }

  const trace = readTrace(cwd, runId);
  const last = new Map<string, TraceLine>();
  for (const line of trace) last.set(line.node, line); // last wins

  const evidenceDir = graph.outputs?.evidence_dir ?? ".graphkit/evidence/";
  const satisfied = new Set<string>();
  for (const name of names) {
    const line = last.get(name);
    if (line && line.status === "ok" && evidenceOnDisk(cwd, evidenceDir, line.evidence)) {
      satisfied.add(name);
    }
  }

  let pending: string[];
  if (opts.fromNode != null) {
    // Explicit redo: fromNode + transitive dependents, regardless of satisfaction.
    pending = [opts.fromNode];
    for (let grew = true; grew; ) {
      grew = false;
      for (const [name, node] of Object.entries(graph.nodes)) {
        if (pending.includes(name)) continue;
        if (node.depend_on.some((d) => pending.includes(d))) {
          pending.push(name);
          grew = true;
        }
      }
    }
  } else {
    // pending = not satisfied ∪ dependents(pending)
    pending = names.filter((n) => !satisfied.has(n));
    for (let grew = true; grew; ) {
      grew = false;
      for (const [name, node] of Object.entries(graph.nodes)) {
        if (pending.includes(name)) continue;
        if (node.depend_on.some((d) => pending.includes(d))) {
          pending.push(name);
          grew = true;
        }
      }
    }
  }

  const skipped = names
    .filter((n) => satisfied.has(n) && !pending.includes(n))
    .map((node) => ({ node, reason: "passed with evidence on disk" }));

  return { cwd, runId, graphPath: meta.graph_path, graph, evidenceDir, satisfied: [...satisfied].sort(), pending: pending.sort(), skipped };
}
```

Notes:
- `Graph` type — import from `../compiler/validate.js` (`import type { Graph } from "../compiler/validate.js"`), which is the canonical typed Graph used by `src/store/index.ts`. Do not re-export from the schema module.
- Closure loops: the fixed-point `grew` loop is intentional (dependents may be discovered in any order).

- [ ] **Step 4: Run tests — verify pass**

Run: `bun test tests/unit/run-resume.test.ts`
Expected: 9 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/memory/resume.ts src/memory/ledger.ts tests/unit/run-resume.test.ts
git commit -m "feat(resume): ledger reconciliation — satisfied/pending closure + drift guard"
```

---

### Task 2: Derivation — `deriveResumeGraph`

**Files:**
- Modify: `src/memory/resume.ts`
- Test: `tests/unit/run-resume.test.ts` (extend)

**Interfaces:**
- Consumes: `Reconciliation` from Task 1; `Graph` from `../compiler/validate.js`; `RefSchema` shape `{ path: string; purpose: string }`.
- Produces: `deriveResumeGraph(rec: Reconciliation, parentRunId: string): Graph` — pending-only graph; metadata.name = `<parent name>-resume`; satisfied deps become refs.

- [ ] **Step 1: Write failing tests** (append to `describe("reconcileRun")` sibling)

```ts
// extend the import from "../../src/memory/resume.js" to include deriveResumeGraph;
// the file-level cwd/beforeEach/afterEach/writeEvidence/traceOk/traceFail fixtures
// from Task 1 Step 1 already cover setup for this describe block
import { deriveResumeGraph, reconcileRun } from "../../src/memory/resume.js";
import { GraphSchema } from "../../src/schemas/graph.schema.js";

describe("deriveResumeGraph", () => {

  test("pending-only nodes, depend_on stripped to pending set, satisfied dep evidence becomes refs", () => {
    const { id } = startRun(cwd, join(cwd, "graph.yaml"), "2026-09-04T10:00:00.000Z");
    writeEvidence(cwd, "a-out");
    traceOk(cwd, "a", ["a-out"]);
    traceFail(cwd, "b");
    endRun(cwd, "failed", "2026-09-04T10:05:00.000Z");
    const rec = reconcileRun(cwd, id);

    const derived = deriveResumeGraph(rec, id);
    expect(Object.keys(derived.nodes).sort()).toEqual(["b", "c"]);
    expect(derived.metadata.name).toBe("demo-resume");
    // b depended on a (satisfied, not carried over) → depend_on empty, a-out becomes a ref
    expect(derived.nodes.b!.depend_on).toEqual([]);
    expect(derived.nodes.b!.refs).toEqual([
      { path: ".graphkit/evidence/a-out.md", purpose: "resumed evidence from node a (run " + id + ")" },
    ]);
    // c still depends on b (both pending)
    expect(derived.nodes.c!.depend_on).toEqual(["b"]);
    // advisor/loop config carried verbatim
    expect(derived.topology).toBe("custom");
  });

  test("preserves node config verbatim (loop, advisor, fan_out, model, constraints)", () => {
    const graph = GRAPH.replace(
      "  b:\n    agent: task\n    objective: Do B\n",
      "  b:\n    agent: task\n    model: sonnet\n    objective: Do B\n    loop: { enabled: true, max_rounds: 4 }\n    advisor: { model: fable, after_failed_rounds: 2 }\n",
    );
    writeFileSync(join(cwd, "graph.yaml"), graph);
    const { id } = startRun(cwd, join(cwd, "graph.yaml"), "2026-09-04T10:00:00.000Z");
    traceFail(cwd, "a");
    endRun(cwd, "failed", "2026-09-04T10:05:00.000Z");
    const derived = deriveResumeGraph(reconcileRun(cwd, id), id);
    expect(derived.nodes.b!.loop).toEqual({ enabled: true, stop_when: undefined, max_rounds: 4, exit_condition: undefined });
    expect(derived.nodes.b!.advisor).toEqual({ model: "fable", after_failed_rounds: 2, max_calls: 1 });
  });

  test("derived graph passes GraphSchema", () => {
    const { id } = startRun(cwd, join(cwd, "graph.yaml"), "2026-09-04T10:00:00.000Z");
    traceFail(cwd, "a");
    endRun(cwd, "failed", "2026-09-04T10:05:00.000Z");
    const derived = deriveResumeGraph(reconcileRun(cwd, id), id);
    expect(GraphSchema.safeParse(derived).success).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests — verify fail**

Run: `bun test tests/unit/run-resume.test.ts`
Expected: FAIL — `deriveResumeGraph` is not exported.

- [ ] **Step 3: Implement** (append to `src/memory/resume.ts`)

```ts
/** Evidence replay: satisfied upstream deps become refs (paths, ADR-002 layout). */
export function deriveResumeGraph(rec: Reconciliation, parentRunId: string): Graph {
  const pending = new Set(rec.pending);
  const satisfied = new Set(rec.satisfied);
  // Last ok trace line per satisfied node supplies the evidence keys to reference.
  const trace = readTrace(rec.cwd, rec.runId);
  const lastOk = new Map<string, TraceLine>();
  for (const line of trace) if (line.status === "ok") lastOk.set(line.node, line);

  const nodes: Graph["nodes"] = {};
  for (const [name, node] of Object.entries(rec.graph.nodes)) {
    if (!pending.has(name)) continue;
    const carriedDeps = node.depend_on.filter((d) => pending.has(d));
    const upstreamRefs = node.depend_on
      .filter((d) => satisfied.has(d))
      .flatMap((d) =>
        (lastOk.get(d)?.evidence ?? []).map((k) => ({
          path: join(rec.evidenceDir, `${k}.md`),
          purpose: `resumed evidence from node ${d} (run ${parentRunId})`,
        })),
      );
    nodes[name] = { ...node, depend_on: carriedDeps, refs: [...node.refs, ...upstreamRefs] };
  }

  return {
    ...rec.graph,
    metadata: { ...rec.graph.metadata, name: `${rec.graph.metadata.name}-resume` },
    nodes,
  };
}
```

- [ ] **Step 4: Run tests — verify pass**

Run: `bun test tests/unit/run-resume.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/memory/resume.ts tests/unit/run-resume.test.ts
git commit -m "feat(resume): derive pending-only graph with evidence refs"
```

---

### Task 3: Provenance — `startRun` resumes param + `run status` chain

**Files:**
- Modify: `src/memory/ledger.ts` (`startRun` signature, run.md line)
- Modify: `src/cli/commands/run.ts` (status subcommand prints chain)
- Test: `tests/unit/run-ledger.test.ts` (extend), `tests/unit/run-cli.test.ts` (extend)

**Interfaces:**
- Consumes: existing `startRun(cwd, graphPath, now?)`.
- Produces: `startRun(cwd: string, graphPath: string, now?: string, resumes?: string)` — meta.json gains `resumes` field and run.md gains `- resumes: <id>` when provided. `run status` output gains `resumes_chain: string[]` (e.g. `["20260904-100002-demo-resume", "20260904-100000-demo"]`, oldest last).

- [ ] **Step 1: Write failing tests**

`tests/unit/run-ledger.test.ts` — append inside `describe("run ledger")`:

```ts
test("startRun with resumes records provenance in meta.json and run.md", () => {
  const first = startRun(cwd, join(cwd, "graph.yaml"), "2026-09-04T10:00:00.000Z");
  endRun(cwd, "failed", "2026-09-04T10:05:00.000Z");
  const second = startRun(cwd, join(cwd, "graph.yaml"), "2026-09-04T11:00:00.000Z", first.id);
  const meta = JSON.parse(readFileSync(join(second.dir, "meta.json"), "utf-8"));
  expect(meta.resumes).toBe(first.id);
  expect(readFileSync(join(second.dir, "run.md"), "utf-8")).toContain(`- resumes: ${first.id}`);
});
```

`tests/unit/run-cli.test.ts` — append (follow that file's existing CLI-spawn helper; if none, use the `runCli` pattern from `tests/acceptance/advisor-fanout.e2e.test.ts`):

```ts
test("run status reports the resumes chain", async () => {
  // start r1 → end failed → start r2 with resumes=r1 → status
  const r1 = startRun(cwd, join(cwd, "graph.yaml"), "2026-09-04T10:00:00.000Z");
  endRun(cwd, "failed", "2026-09-04T10:05:00.000Z");
  startRun(cwd, join(cwd, "graph.yaml"), "2026-09-04T11:00:00.000Z", r1.id);
  const { stdout } = await runCli(["run", "status", "--json"], cwd);
  const parsed = JSON.parse(stdout);
  expect(parsed.status).toBe("ok");
  expect(parsed.data.resumes_chain).toHaveLength(2);
});
```

- [ ] **Step 2: Run — verify fail**

Run: `bun test tests/unit/run-ledger.test.ts tests/unit/run-cli.test.ts`
Expected: FAIL — meta has no `resumes`; status output lacks `resumes_chain`.

- [ ] **Step 3: Implement**

`startRun` in `src/memory/ledger.ts`:

```ts
export function startRun(
  cwd: string,
  graphPath: string,
  now = new Date().toISOString(),
  resumes?: string,
): { id: string; dir: string } {
```

meta write gains the field conditionally:

```ts
  const meta: Record<string, unknown> = {
    id,
    graph: name,
    graph_path: resolved,
    graph_sha256: createHash("sha256").update(raw).digest("hex"),
    started_at: now,
  };
  if (resumes) meta.resumes = resumes;
  writeFileSync(join(dir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
```

run.md header array — insert after the `- started_at: ${now}` line:

```ts
  ...(resumes ? [`- resumes: ${resumes}`] : []),
```

`run status` in `src/cli/commands/run.ts` (replace the current status block):

```ts
if (subcommand === "status") {
  const dir = activeRun(cwd);
  const advisor_events = dir ? readAdvisorEvents(cwd, basename(dir)).length : 0;
  const chain: string[] = [];
  let cursor: string | null = dir ? basename(dir) : null;
  const guard = new Set<string>();
  while (cursor && !guard.has(cursor)) {
    guard.add(cursor);
    chain.push(cursor);
    try {
      cursor = readRunMeta(cwd, cursor).resumes ?? null;
    } catch {
      cursor = null; // corrupt/legacy meta: chain ends, status still reports
    }
  }
  console.log(JSON.stringify(ok({ active: dir, advisor_events, resumes_chain: chain })));
  return;
}
```

(Import `readRunMeta` in run.ts's ledger import block.)

- [ ] **Step 4: Run — verify pass**

Run: `bun test tests/unit/run-ledger.test.ts tests/unit/run-cli.test.ts`
Expected: PASS (existing + new).

- [ ] **Step 5: Commit**

```bash
git add src/memory/ledger.ts src/cli/commands/run.ts tests/unit/run-ledger.test.ts tests/unit/run-cli.test.ts
git commit -m "feat(resume): run provenance — meta/resume link + status chain"
```

---

### Task 4: Orchestrator + CLI — `resumeRun`, `gk run resume`

**Files:**
- Modify: `src/memory/resume.ts` (add `resumeRun`)
- Modify: `src/cli/commands/run.ts` (resume subcommand)
- Modify: `src/cli/command-registry.ts` (help entry)
- Test: `tests/unit/run-cli.test.ts` (extend)

**Interfaces:**
- Consumes: `reconcileRun`, `deriveResumeGraph` (Tasks 1-2); `saveSessionGraph`, `setActiveGraphId` from `../../store/index.js`; `startRun` (Task 3).
- Produces:
  - `resumeRun(cwd: string, runId: string, opts?: { fromNode?: string; dryRun?: boolean; force?: boolean }): { resumed: boolean; reason?: string; session?: { id: string; path: string }; run?: { id: string; dir: string }; pending: string[]; satisfied: string[]; skipped: Array<{ node: string; reason: string }> }`
  - CLI: `gk run resume <run-id> [--from-node <id>] [--dry-run] [--force] [--json]`

- [ ] **Step 1: Write failing tests** (append to `tests/unit/run-cli.test.ts`, CLI-level)

`tests/unit/run-cli.test.ts` may not have a CLI-spawn helper or these fixtures — add this preamble at the top of the new `describe("run resume CLI")` block (self-contained; do not import from other test files):

```ts
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { appendNode, endRun, startRun } from "../../src/memory/ledger.js";

const CLI_ENTRY = join(import.meta.dir, "..", "..", "src", "index.ts");

async function runCli(args: string[], dir: string) {
  const proc = Bun.spawn(["bun", "run", CLI_ENTRY, ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  return { stdout, exitCode };
}

const GRAPH = `apiVersion: graphkit.dev/v2
kind: Graph
metadata:
  name: demo
topology: custom
nodes:
  a:
    agent: scout
    objective: Do A
    evidence: [a-out]
  b:
    agent: task
    objective: Do B
    depend_on: [a]
    evidence: [b-out]
  c:
    agent: reviewer
    objective: Do C
    depend_on: [b]
`;

function writeEvidence(dir: string, key: string, text = "content\n") {
  writeFileSync(join(dir, ".graphkit", "evidence", `${key}.md`), text);
}
function traceOk(dir: string, node: string, evidence: string[]) {
  appendNode(dir, { node, wave: 0, agent: "x", model: null, status: "ok", evidence, duration_ms: 10, notes: null });
}
function traceFail(dir: string, node: string) {
  appendNode(dir, { node, wave: 0, agent: "x", model: null, status: "fail", evidence: [], duration_ms: 10, notes: null });
}
```

The `beforeEach` for that describe block:

```ts
let cwd: string;
beforeEach(() => {
  cwd = join(tmpdir(), `gk-resume-cli-${process.pid}-${Date.now()}`);
  mkdirSync(join(cwd, ".graphkit", "runs"), { recursive: true });
  mkdirSync(join(cwd, ".graphkit", "evidence"), { recursive: true });
  mkdirSync(join(cwd, ".graphkit", "graphs"), { recursive: true });
  writeFileSync(join(cwd, "graph.yaml"), GRAPH);
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));
```

```ts
test("run resume: failed run derives session graph, activates it, starts child run", async () => {
  writeEvidence(cwd, "a-out");
  // r1: a ok+evidence, b fail → end failed
  const r1 = startRun(cwd, join(cwd, "graph.yaml"), "2026-09-04T10:00:00.000Z");
  traceOk(cwd, "a", ["a-out"]);
  traceFail(cwd, "b");
  endRun(cwd, "failed", "2026-09-04T10:05:00.000Z");

  const { stdout, exitCode } = await runCli(["run", "resume", r1.id, "--json"], cwd);
  const parsed = JSON.parse(stdout);
  expect(exitCode).toBe(0);
  expect(parsed.status).toBe("ok");
  expect(parsed.data.resumed).toBe(true);
  expect(parsed.data.pending).toEqual(["b", "c"]);
  expect(parsed.data.session.path).toContain("-demo-resume.yaml");
  // derived graph on disk: pending-only + refs
  const derived = YAML.parse(readFileSync(parsed.data.session.path, "utf-8"));
  expect(Object.keys(derived.nodes).sort()).toEqual(["b", "c"]);
  expect(derived.nodes.b.refs[0].path).toBe(".graphkit/evidence/a-out.md");
  // session store activated + child run active with provenance
  expect(readFileSync(join(cwd, ".graphkit", "active"), "utf-8").trim()).toBe(parsed.data.session.id);
  expect(readFileSync(join(cwd, ".graphkit", "runs", parsed.data.run.id, "meta.json"), "utf-8")).toContain(r1.id);
});

test("run resume --dry-run writes nothing", async () => {
  const r1 = startRun(cwd, join(cwd, "graph.yaml"), "2026-09-04T10:00:00.000Z");
  traceFail(cwd, "a");
  endRun(cwd, "failed", "2026-09-04T10:05:00.000Z");
  const before = readdirSync(join(cwd, ".graphkit", "graphs"));
  const { stdout } = await runCli(["run", "resume", r1.id, "--dry-run", "--json"], cwd);
  const parsed = JSON.parse(stdout);
  expect(parsed.data.resumed).toBe(false);
  expect(parsed.data.reason).toBe("DRY_RUN");
  expect(readdirSync(join(cwd, ".graphkit", "graphs"))).toEqual(before);
});

test("run resume: nothing pending → exit 0 informational", async () => {
  writeEvidence(cwd, "a-out");
  writeEvidence(cwd, "b-out");
  const r1 = startRun(cwd, join(cwd, "graph.yaml"), "2026-09-04T10:00:00.000Z");
  traceOk(cwd, "a", ["a-out"]);
  traceOk(cwd, "b", ["b-out"]);
  traceOk(cwd, "c", []);
  endRun(cwd, "merged", "2026-09-04T10:05:00.000Z");
  const { stdout, exitCode } = await runCli(["run", "resume", r1.id, "--json"], cwd);
  const parsed = JSON.parse(stdout);
  expect(exitCode).toBe(0);
  expect(parsed.data.resumed).toBe(false);
  expect(parsed.data.reason).toBe("NOTHING_TO_RESUME");
});

test("run resume: drift → exit 1 fail envelope", async () => {
  const r1 = startRun(cwd, join(cwd, "graph.yaml"), "2026-09-04T10:00:00.000Z");
  endRun(cwd, "failed", "2026-09-04T10:05:00.000Z");
  writeFileSync(join(cwd, "graph.yaml"), GRAPH + "# drift\n");
  const { stdout, exitCode } = await runCli(["run", "resume", r1.id, "--json"], cwd);
  expect(exitCode).toBe(1);
  expect(JSON.parse(stdout).error.code).toBe("RESUME_GRAPH_DRIFT");
});
```

- [ ] **Step 2: Run — verify fail**

Run: `bun test tests/unit/run-cli.test.ts`
Expected: FAIL — `UNKNOWN_RUN_SUBCOMMAND: resume`.

- [ ] **Step 3: Implement**

`src/memory/resume.ts` — append:

```ts
import { saveSessionGraph, setActiveGraphId } from "../store/index.js";
import { startRun } from "./ledger.js";

export interface ResumeResult {
  resumed: boolean;
  reason?: string;
  session?: { id: string; path: string };
  run?: { id: string; dir: string };
  pending: string[];
  satisfied: string[];
  skipped: Array<{ node: string; reason: string }>;
}

export function resumeRun(
  cwd: string,
  runId: string,
  opts: { fromNode?: string; dryRun?: boolean; force?: boolean } = {},
): ResumeResult {
  const rec = reconcileRun(cwd, runId, opts);

  if (rec.pending.length === 0) {
    return { resumed: false, reason: "NOTHING_TO_RESUME", pending: [], satisfied: rec.satisfied, skipped: rec.skipped };
  }
  if (opts.dryRun) {
    return { resumed: false, reason: "DRY_RUN", pending: rec.pending, satisfied: rec.satisfied, skipped: rec.skipped };
  }

  const derived = deriveResumeGraph(rec, runId);
  const session = saveSessionGraph(derived, `${derived.metadata.name}`, cwd);
  setActiveGraphId(session.id, cwd);
  const run = startRun(cwd, session.path, new Date().toISOString(), runId);

  return { resumed: true, session, run, pending: rec.pending, satisfied: rec.satisfied, skipped: rec.skipped };
}
```

`src/cli/commands/run.ts` — add before the `end` subcommand block:

```ts
if (subcommand === "resume") {
  const target = Array.isArray(args) ? args[0] : args;
  if (!target) {
    console.log(JSON.stringify(fail("MISSING_ARG", "resume requires a run id (see `gk run list` or .graphkit/runs/)")));
    return;
  }
  console.log(
    JSON.stringify(
      ok(resumeRun(cwd, String(target), { fromNode: opts.fromNode, dryRun: opts.dryRun, force: opts.force })),
    ),
  );
  return;
}
```

Options to register on the `run` command chain (next to existing `.option` calls): `.option("--from-node <id>", "resume: redo this node + dependents")`, `.option("--dry-run", "resume: preview without writing")`, `.option("--force", "resume: override graph drift guard")`.

Exit-1 semantics: `resumeRun` throws `Error("RESUME_GRAPH_DRIFT: …")` etc.; the existing `catch` in the action prints `fail(code, message)` via `errCode`. Add `process.exit(1)` inside the catch? Check repo convention: `gate.ts` calls `process.exit(1)` on BLOCK; run.ts catch does not. Match gate.ts: in the catch, after printing, `process.exitCode = 1` — but only if existing behavior permits. Existing run.ts catch prints envelope without exit code change; keep that for node/end/start errors but resume drift should exit 1 per spec. Simplest consistent: set `process.exitCode = 1` in the shared catch — this changes behavior of existing error paths (BAD_STATUS etc.) from exit 0 to exit 1. That is a behavior change; safer: wrap resume call in its own try/catch that sets `process.exitCode = 1`:

```ts
if (subcommand === "resume") {
  const target = Array.isArray(args) ? args[0] : args;
  if (!target) {
    process.exitCode = 1;
    console.log(JSON.stringify(fail("MISSING_ARG", "resume requires a run id")));
    return;
  }
  try {
    console.log(JSON.stringify(ok(resumeRun(cwd, String(target), { fromNode: opts.fromNode, dryRun: opts.dryRun, force: opts.force }))));
  } catch (e) {
    process.exitCode = 1;
    const { code, message } = errCode(e);
    console.log(JSON.stringify(fail(code, message)));
  }
  return;
}
```

`src/cli/command-registry.ts` — after the `run end` entry:

```ts
{
  path: "run resume",
  description: "Derive a pending-only session graph from a failed/interrupted run and start a child run",
  options: ["--from-node <id>", "--dry-run", "--force", "--json"],
},
```

- [ ] **Step 4: Run — verify pass**

Run: `bun test tests/unit/run-cli.test.ts && bun test tests/unit/run-resume.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/memory/resume.ts src/cli/commands/run.ts src/cli/command-registry.ts tests/unit/run-cli.test.ts
git commit -m "feat(resume): gk run resume — derive, activate, and continue"
```

---

### Task 5: Acceptance e2e + docs

**Files:**
- Create: `tests/acceptance/run-resume.e2e.test.ts`
- Modify: `CHANGELOG.md` (`[Unreleased]` → `### Added`)
- Modify: `kits/claude/skills/gk-run/SKILL.md` (document resume)

**Interfaces:**
- Consumes: full CLI surface from Tasks 1-4; e2e scaffolding pattern from `tests/acceptance/advisor-fanout.e2e.test.ts` (seed `.omp/agents` with the agent ids the graph binds, real CLI via `Bun.spawn`).

- [ ] **Step 1: Write the e2e test**

```ts
// tests/acceptance/run-resume.e2e.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";

const CLI_ENTRY = join(import.meta.dir, "..", "..", "src", "index.ts");

async function runCli(args: string[], cwd: string) {
  const proc = Bun.spawn(["bun", "run", CLI_ENTRY, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  return { stdout, exitCode };
}

const GRAPH = `apiVersion: graphkit.dev/v2
kind: Graph
metadata:
  name: resume-e2e
topology: custom
nodes:
  scan:
    agent: scout
    objective: Scan.
    evidence: [scan-done]
  build:
    agent: implementer
    objective: Build.
    depend_on: [scan]
    evidence: [build-done]
`;

describe("run resume e2e", () => {
  let cwd: string;
  beforeAll(() => {
    cwd = join(tmpdir(), `gk-resume-e2e-${process.pid}-${Date.now()}`);
    mkdirSync(join(cwd, ".graphkit", "runs"), { recursive: true });
    mkdirSync(join(cwd, ".graphkit", "evidence"), { recursive: true });
    mkdirSync(join(cwd, ".graphkit", "graphs"), { recursive: true });
    const agents = join(cwd, ".omp", "agents");
    mkdirSync(agents, { recursive: true });
    for (const a of ["scout.md", "implementer.md"]) writeFileSync(join(agents, a), "---\ndescription: test\n---\n");
    writeFileSync(join(cwd, "graph.yaml"), GRAPH);
  });
  afterAll(() => rmSync(cwd, { recursive: true, force: true }));

  test("full cycle: fail → resume → derived graph → provenance chain", async () => {
    // 1. start + scan passes with evidence, build fails → end failed
    const start = JSON.parse((await runCli(["run", "start", "--json"], cwd)).stdout);
    writeFileSync(join(cwd, ".graphkit", "evidence", "scan-done.md"), "scan output\n");
    await runCli(["run", "node", "scan", "--status", "ok", "--evidence", "scan-done", "--wave", "0", "--agent", "scout", "--json"], cwd);
    await runCli(["run", "node", "build", "--status", "fail", "--wave", "1", "--agent", "implementer", "--json"], cwd);
    await runCli(["run", "end", "--status", "failed", "--json"], cwd);

    // 2. resume
    const resume = JSON.parse((await runCli(["run", "resume", start.data.id, "--json"], cwd)).stdout);
    expect(resume.data.resumed).toBe(true);
    expect(resume.data.pending).toEqual(["build"]);

    // 3. derived graph content
    const derived = YAML.parse(readFileSync(resume.data.session.path, "utf-8"));
    expect(Object.keys(derived.nodes)).toEqual(["build"]);
    expect(derived.nodes.build.refs).toEqual([
      { path: ".graphkit/evidence/scan-done.md", purpose: `resumed evidence from node scan (run ${start.data.id})` },
    ]);

    // 4. child run is active with provenance; status shows the chain
    const status = JSON.parse((await runCli(["run", "status", "--json"], cwd)).stdout);
    expect(status.data.resumes_chain).toEqual([resume.data.run.id, start.data.id]);

    // 5. child passes → end merged
    writeFileSync(join(cwd, ".graphkit", "evidence", "build-done.md"), "build output\n");
    await runCli(["run", "node", "build", "--status", "ok", "--evidence", "build-done", "--wave", "0", "--agent", "implementer", "--json"], cwd);
    const end = JSON.parse((await runCli(["run", "end", "--status", "merged", "--json"], cwd)).stdout);
    expect(end.data.status).toBe("merged");
    expect(end.data.evidence_keys).toEqual(["build-done"]);
  });
});
```

- [ ] **Step 2: Run — verify pass** (e2e covers already-implemented surface; if it fails, fix the implementation, not the test)

Run: `bun test tests/acceptance/run-resume.e2e.test.ts`
Expected: PASS.

- [ ] **Step 3: Docs**

`CHANGELOG.md` — under `## [Unreleased]`, add before the existing `### Changed`:

```markdown
### Added
- **`gk run resume <run-id>`** — checkpoint replay: reconciles the run ledger against the recorded graph (`passed` + evidence-on-disk rule, dependent closure), derives a pending-only session graph where satisfied upstream evidence becomes `refs`, activates it, and starts a child run carrying `resumes:` provenance. `gk run status` now prints the `resumes_chain`. Guards: `RESUME_GRAPH_DRIFT` (sha256 of the recorded graph), `--force` override, `--from-node` redo, `--dry-run` preview.
```

`kits/claude/skills/gk-run/SKILL.md` — add a `## gk run resume` section after the existing run docs:

Caution: repo has kit-parity tests (e.g. `tests/unit/kit-skill-parity.test.ts`). If the full suite in Step 4 fails parity after this edit, find the generated-skills source the parity test compares against and mirror the same section there — do not weaken the test.

```markdown
## gk run resume

Resume a failed or interrupted run:

```bash
gk run resume <run-id>              # derive pending-only graph + start child run
gk run resume <run-id> --dry-run    # preview reconciliation, write nothing
gk run resume <run-id> --from-node <id>  # redo one node + its dependents
gk run resume <run-id> --force      # override the graph-drift guard
```

A node is **satisfied** only if its last trace line is `ok` and every recorded evidence key maps to a non-empty `<evidence_dir>/<key>.md`. Satisfied upstreams are skipped; their evidence is attached to pending nodes as `refs`. The derived graph is saved as `<date>-<name>-resume.yaml` and activated; the new run records `resumes: <parent>` (visible in `gk run status` as `resumes_chain`). Graph edits since the run started are refused with `RESUME_GRAPH_DRIFT` — commit the graph change and start a fresh run instead, or pass `--force` consciously.
```

- [ ] **Step 4: Full suite + commit**

Run: `bun test`
Expected: all pass (baseline 542 + new tests).

```bash
git add tests/acceptance/run-resume.e2e.test.ts CHANGELOG.md kits/claude/skills/gk-run/SKILL.md
git commit -m "feat(resume): e2e acceptance + docs"
```

---

## Verification (whole plan)

After Task 5, run from repo root:

```bash
bun test            # full suite green
bunx tsc --noEmit   # type check green (repo has no separate lint step for src)
gk run resume 2>&1  # MISSING_ARG envelope, exit 1
```

Manual smoke (optional, real repo): fail any run mid-flight, `gk run resume <id> --dry-run`, inspect the table.
