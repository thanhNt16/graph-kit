# P0 Contract Extraction — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the audit-proven duplication at the contract layer — one graph resolver, one diagnostic envelope, validate-at-start, one target table — so every command resolves graphs, reports errors, and binds agents identically.

**Architecture:** Extract shared contract modules (`src/cli/graph-resolve.ts`, `src/cli/diagnostics.ts`, one `src/targets/` table) and migrate the six divergent call sites. No behavior is invented: precedence rules are chosen once and applied everywhere.

**Tech Stack:** TypeScript + bun, zod schemas, cac CLI, existing `tests/unit/*` conventions (`bun test`).

**Spec:** `docs/superpowers/specs/2026-10-06-rearchitecture-design.md` §5 P0. **Audit evidence:** `.tmp-audit-rearch/CONSOLIDATED.md` — findings cited per task.

## Global Constraints

- Repo: `/Users/harry/Desktop/personal/graph-kit`, TS + bun. Test: `bun test tests/unit/<file>`; converge with `bun run typecheck`. NEVER run full suite/lint/formatters per-task.
- Envelope: `ok(data)` / `fail(code, msg, details)` from `src/cli/output.ts`; errors are `GraphKitError` from `src/errors.ts` (SCREAMING_SNAKE codes). Text-prefix `Error("CODE: …")` is banned after Task 2.
- Per commit: focused message per task. Do NOT commit `docs/superpowers/` or `.tmp-audit-rearch/`.
- Regression net: `tests/unit/` exists for run-ledger, run-cli, cli-trust, gate, gate-freshness, evidence-cli, validate, compiler, template-*. New tests match those conventions.

## File map

- Create `src/cli/graph-resolve.ts` — the ONE resolver (path | session-id | active-run | active-pointer | ./graph.yaml).
- Create `src/cli/diagnostics.ts` — `formatZodIssues` + `toGraphKitError` helpers.
- Modify `src/targets/types.ts`, `src/targets/registry.ts` — pi+claude target table (agent dir, file ext, skills dir, tier map).
- Modify `src/compiler/validate.ts` — consume target table for agent binding; schema issues → findings shape.
- Modify `src/cli/commands/graph.ts`, `run.ts`, `evidence.ts`, `status.ts`, `gate.ts`, `memory.ts`, `src/cli/node-agents.ts`, `src/evidence/store.ts`.
- Tests: `tests/unit/graph-resolve.test.ts` (new), `run-cli.test.ts`, `cli-trust.test.ts`, `validate.test.ts`, `evidence-cli.test.ts`, `status` assertions inside existing files.

---

### Task 1: One graph resolver

**Files:**
- Create: `src/cli/graph-resolve.ts`
- Modify: `src/cli/commands/graph.ts:95-109` (resolveBareValidateGraph), `src/cli/commands/run.ts:91-101` (resolveStartGraph) + `:85-89` (runGraphNodeIds) + `:211` (evidence-ish graph pick), `src/cli/commands/evidence.ts:18-21` (resolveGraph), `src/cli/commands/graph.ts` wave/agent/compile/gate/ascii/svg `loadGraph(file ?? join(cwd,"graph.yaml"))` sites (`:663,:791,:805,:973` and `gate.ts` loader if separate), `src/cli/commands/memory.ts` graph consumers, `src/cli/commands/status.ts`.
- Test: `tests/unit/graph-resolve.test.ts` (new)

**Interfaces:**
- Consumes: `getActiveGraphId`, `loadActiveGraph`, `listSessionGraphs` from `src/store/index.js`; `activeRunGraph` from `src/memory/ledger.js`.
- Produces:
  ```ts
  // Resolution precedence (the contract):
  //   explicit flag → file path that exists | session-graph id | GRAPH_NOT_FOUND{hint}
  //   omitted flag  → active run's recorded graph | session active pointer | ./graph.yaml | NO_ACTIVE_GRAPH
  export interface ResolvedGraph { path: string; source: "flag" | "run" | "active" | "root" }
  export function resolveGraphPath(cwd: string, flag?: string): ResolvedGraph
  export function resolveGraph(cwd: string, flag?: string): Graph // resolveGraphPath + loadGraph
  ```

- [ ] **Step 1: Write the failing test**

`tests/unit/graph-resolve.test.ts`:
```ts
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { resolveGraphPath } from "../../src/cli/graph-resolve.js";

const GRAPH = `kind: Graph\nmetadata: {name: t}\ntopology: diamond\nnodes: {a: {agent: x, objective: o}}\n`;

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "gres-"));
  writeFileSync(join(dir, "graph.yaml"), GRAPH);
  return dir;
}

describe("resolveGraphPath", () => {
  test("explicit flag: existing file path wins", () => {
    const cwd = scratch();
    expect(resolveGraphPath(cwd, join(cwd, "graph.yaml")).source).toBe("flag");
  });
  test("explicit flag: session-graph id resolves (UX F1)", () => {
    const cwd = scratch();
    mkdirSync(join(cwd, ".graphkit", "graphs"), { recursive: true });
    writeFileSync(join(cwd, ".graphkit", "graphs", "2026-01-01-x.yaml"), GRAPH);
    expect(resolveGraphPath(cwd, "2026-01-01-x").path).toContain("2026-01-01-x.yaml");
  });
  test("explicit flag: nonexistent path AND non-id → GRAPH_NOT_FOUND with hint", () => {
    const cwd = scratch();
    expect(() => resolveGraphPath(cwd, "nope")).toThrow(/GRAPH_NOT_FOUND/);
  });
  test("omitted: session active pointer beats root graph.yaml (SB F2)", () => {
    const cwd = scratch();
    mkdirSync(join(cwd, ".graphkit", "graphs"), { recursive: true });
    writeFileSync(join(cwd, ".graphkit", "graphs", "s.yaml"), GRAPH);
    writeFileSync(join(cwd, ".graphkit", "graphs", ".active"), "s");
    expect(resolveGraphPath(cwd).source).toBe("active");
  });
  test("omitted: no pointer → root fallback", () => {
    const cwd = scratch();
    expect(resolveGraphPath(cwd).source).toBe("root");
  });
  test("omitted: nothing → NO_ACTIVE_GRAPH", () => {
    const cwd = mkdtempSync(join(tmpdir(), "gres-"));
    expect(() => resolveGraphPath(cwd)).toThrow(/NO_ACTIVE_GRAPH/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/graph-resolve.test.ts`
Expected: FAIL (module does not exist)

- [ ] **Step 3: Implement `src/cli/graph-resolve.ts`**

```ts
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { GraphKitError } from "../errors.js";
import type { Graph } from "../schemas/graph.schema.js";
import { getActiveGraphId, listSessionGraphs, loadActiveGraph } from "../store/index.js";
import { activeRunGraph } from "../memory/ledger.js";
import { loadGraph } from "./commands/graph.js";

export interface ResolvedGraph { path: string; source: "flag" | "run" | "active" | "root" }

/** THE graph resolver. Explicit flag: file path or session-graph id.
 *  Omitted: active run's recorded graph → session active pointer → ./graph.yaml.
 *  Every command resolves through this — precedence is defined once, here. */
export function resolveGraphPath(cwd: string, flag?: string): ResolvedGraph {
  if (flag) {
    if (existsSync(flag)) return { path: flag, source: "flag" };
    const sessions = listSessionGraphs(cwd);
    const hit = sessions.find((g) => g.id === flag || basename(g.path, ".yaml") === flag);
    if (hit) return { path: hit.path, source: "flag" };
    throw new GraphKitError("GRAPH_NOT_FOUND", `GRAPH_NOT_FOUND: ${flag} — not a file and not a session graph id (${sessions.map((g) => g.id).join(", ") || "none"})`);
  }
  const runGraph = activeRunGraph(cwd);
  if (runGraph && existsSync(runGraph)) return { path: runGraph, source: "run" };
  if (existsSync(join(cwd, ".graphkit")) && getActiveGraphId(cwd) !== null) {
    return { path: loadActiveGraph(cwd).path, source: "active" };
  }
  const root = join(cwd, "graph.yaml");
  if (existsSync(root)) return { path: root, source: "root" };
  throw new GraphKitError("NO_ACTIVE_GRAPH", "No graph resolvable — pass --graph <file|id>, `gk template materialize --use`, or create ./graph.yaml");
}
export function resolveGraph(cwd: string, flag?: string): Graph {
  return loadGraph(resolveGraphPath(cwd, flag).path);
}
```

- [ ] **Step 4: Migrate every call site**

Delete `resolveStartGraph` (run.ts:91-101), `resolveBareValidateGraph` (graph.ts:95-109), `resolveGraph` in evidence.ts:18-21, `runGraphNodeIds`'s ad-hoc `flag ?? activeRunGraph` (keep the ids extraction, feed path from `resolveGraphPath`). Replace every `file ?? join(cwd, "graph.yaml")` + `loadGraph` pattern in graph.ts/gate.ts/memory.ts/status.ts with `resolveGraph(cwd, file)` or `resolveGraphPath(cwd, file).path`. `activeRunGraph` stays internal to the resolver for the run-recorded leg.

- [ ] **Step 5: Verify tests + typecheck**

Run: `bun test tests/unit/graph-resolve.test.ts tests/unit/run-cli.test.ts tests/unit/cli-trust.test.ts tests/unit/evidence-cli.test.ts && bun run typecheck`
Expected: PASS (resolver tests green; migrated suites unchanged behavior)

- [ ] **Step 6: Commit**

```bash
git add src/cli/graph-resolve.ts src/cli/commands/ tests/unit/graph-resolve.test.ts
git commit -m "feat(cli): one graph resolver — path|session-id|active-run|active-pointer|root precedence everywhere"
```

---

### Task 2: One diagnostic envelope

**Files:**
- Create: `src/cli/diagnostics.ts`
- Modify: `src/errors.ts`, `src/cli/commands/run.ts` (errCode:55-59 + text-prefix throws :66,:76), `src/compiler/validate.ts` (findings shape), `src/cli/commands/graph.ts` (SCHEMA_INVALID details.issues :70,:85)
- Test: `tests/unit/cli-trust.test.ts`, `tests/unit/validate.test.ts`

**Interfaces:**
- Consumes: `GraphKitError` (errors.ts), `z.ZodError`.
- Produces:
  ```ts
  export interface Issue { path: string; message: string; hint?: string }
  export function formatZodIssues(e: ZodError): Issue[]          // THE zod→issue formatter
  export function toGraphKitError(e: unknown, fallback: string): GraphKitError // wraps non-GKE as fallback code
  ```
  Envelope rule after this task: `SCHEMA_INVALID` and `VALIDATION_FAILED` BOTH carry `details.issues: Issue[]` — the `details.findings` alias is removed; semantic findings serialize into the same `{path,message,hint}` shape with `check`+`severity` kept as extra fields (additive, not a second envelope).

- [ ] **Step 1: Write the failing test** — in `tests/unit/validate.test.ts` add: schema-invalid graph through `gk validate` yields `details.issues` (not `findings`); a semantic failure also yields `details.issues` entries with `check`+`severity`. In `cli-trust.test.ts`: `run` command errors are SCREAMING_SNAKE GraphKitError codes (no `RUN_ERROR` fallback on a coded throw).

- [ ] **Step 2: Run to verify fail** — `bun test tests/unit/validate.test.ts tests/unit/cli-trust.test.ts` → FAIL on the new assertions.

- [ ] **Step 3: Implement** `src/cli/diagnostics.ts` (formatZodIssues with optional did-you-mean hint via `closeMatches` where a candidate list exists); migrate run.ts throws to `GraphKitError`; delete `errCode` regex; validate.ts emits issues-shaped findings.

- [ ] **Step 4: Verify** — `bun test tests/unit/validate.test.ts tests/unit/cli-trust.test.ts tests/unit/run-cli.test.ts tests/unit/compiler.test.ts && bun run typecheck` → PASS.

- [ ] **Step 5: Commit** — `git add src/cli/diagnostics.ts src/errors.ts src/cli/commands/run.ts src/compiler/validate.ts src/cli/commands/graph.ts tests/` → `fix(cli): one diagnostic envelope — formatZodIssues + GraphKitError everywhere, issues shape unified`

---

### Task 3: `run start` validates before state creation

**Files:**
- Modify: `src/cli/commands/run.ts` (start action ~:155-170), `src/memory/ledger.ts` (startRun if validation lands inside), `src/compiler/validate.ts` (export a pure `validateGraph` usable without env probes if needed — use `validateDerivedGraph` pattern already present in resume.ts)
- Test: `tests/unit/run-cli.test.ts`

**Interfaces:**
- Consumes: `validateGraph` (compiler), `resolveGraph` (Task 1).
- Produces: `run start` fails `VALIDATION_FAILED`/`SCHEMA_INVALID` BEFORE `.graphkit/runs/<id>/` or `.active` is written (audit CS#1). Input enforcement (MISSING_INPUTS) order: schema+semantic validation first, then inputs.

- [ ] **Step 1: Write the failing test** — in `run-cli.test.ts`: invalid graph (bad node shape / unknown agent in a project WITH agents dir) → `gk run start` exits 1 with `VALIDATION_FAILED` and `ls .graphkit/runs` is EMPTY and `.active` absent.

- [ ] **Step 2: Run to verify fail.**

- [ ] **Step 3: Implement** — in the start action: `resolveGraph` → `validateGraph(graph, { cwd })` → blocking findings ⇒ `fail("VALIDATION_FAILED", …, { issues })` return early; only then `startRun`. Environment-probe findings (agent dir, refs) are included — a start on an invalid graph must die before ledger state exists.

- [ ] **Step 4: Verify** — `bun test tests/unit/run-cli.test.ts tests/unit/run-ledger.test.ts && bun run typecheck` → PASS.

- [ ] **Step 5: Commit** — `fix(run): validate graph before creating run state — no ledger write on invalid graph`

---

### Task 4: Target table (pi+claude) + validate↔agents agreement

**Files:**
- Modify: `src/targets/types.ts`, `src/targets/registry.ts` (restrict to pi+claude), `src/compiler/validate.ts:18-48` (agent-file-name + dir probe), `src/cli/node-agents.ts` (dir resolution), `src/cli/commands/graph.ts` agent-binding error text, `scripts/gen-kits.ts` HOSTS if it re-derives targets
- Test: `tests/unit/validate.test.ts`, `tests/unit/cli-trust.test.ts`

**Interfaces:**
- Consumes: target registry entries `{ id, agentsDir, agentFileExt, skillsDir, modelTiers }`.
- Produces: `export function agentDirsFor(cwd): string[]` (target-table-derived, e.g. `[".omp/agents",".claude/agents"]`); `agentFileName(name)` as the SINGLE binding rule (kebab-case; both validate.ts and node-agents.ts import it — deletes CS#6 divergence). Codex/opencode/cursor entries and their special-cases removed.

- [ ] **Step 1: Write the failing test** — `validate.test.ts`: graph binding `agent: "Software Architect"` validates on a project with `.omp/agents/software-architect.md` (kebab rule both sides); unknown agent fails `AGENT_NOT_FOUND`-style finding naming the file it looked for; `node-agents` materialization and validate agree on the same dir list.

- [ ] **Step 2: Run to verify fail.**

- [ ] **Step 3: Implement** — target table reduced to pi+claude; `agentFileName` exported from one module (`src/targets/registry.ts` or `src/cli/node-agents.ts` re-exported); validate's hardcoded 6-dir ladder replaced by `agentDirsFor`; KitTarget type aligned (pi|claude — dead entries removed; gen-kits HOSTS reduced accordingly if it maps targets).

- [ ] **Step 4: Verify** — `bun test tests/unit/validate.test.ts tests/unit/cli-trust.test.ts && bun run typecheck && bun run scripts/gen-kits.ts --check` → PASS (gen drift caught if HOSTS changed).

- [ ] **Step 5: Commit** — `feat(targets): pi+claude target table — one agent-dir list and one agentFileName rule for validate+materialize`

---

### Task 5: `evidence add --node` wired

**Files:**
- Modify: `src/cli/commands/evidence.ts:51-57`, `src/evidence/store.ts` (`addEvidence` opts + marker field), `src/evidence/marker.ts` if `node` isn't already a marker field
- Test: `tests/unit/evidence-cli.test.ts`

**Interfaces:**
- Consumes: `addEvidence(cwd, graph, { file, key, note, maxBytes, node? })`.
- Produces: marker frontmatter gains/stamps `node: <id>`; `--node` flag declared at evidence.ts:27 is forwarded (audit ES E2 — currently dropped).

- [ ] **Step 1: Write the failing test** — `evidence-cli.test.ts`: `evidence add f.md --key k --node w` → marker file frontmatter `node: w` (the existing test passes the flag but asserts nothing — make it assert).

- [ ] **Step 2: Run to verify fail.**

- [ ] **Step 3: Implement** — forward `opts.node` into `addEvidence` opts → `renderMarker` writes `node:`; `parseMarker` already tolerates/needs the field for report lineage.

- [ ] **Step 4: Verify** — `bun test tests/unit/evidence-cli.test.ts tests/unit/gate-freshness.test.ts && bun run typecheck` → PASS.

- [ ] **Step 5: Commit** — `fix(evidence): wire --node into marker — producing-node provenance no longer dropped`

---

### Task 6: `gk status` — kill the `current.json` ghost

**Files:**
- Modify: `src/cli/commands/status.ts` (:26 reads `.graphkit/runs/current.json`)
- Test: `tests/unit/cli-trust.test.ts` or a `status` block in run-cli tests

**Interfaces:**
- Consumes: `activeRun`, `readTrace`, `readRunIndex` from `src/memory/ledger.js`; `resolveGraphPath` (Task 1) for gate context.
- Produces: `gk status` reports the SAME run `gk run status` sees (audit CLI F1 / ES E4): run id, node tallies, evidence coverage — derived from `.active` + trace, never `current.json`.

- [ ] **Step 1: Write the failing test** — start a run in scratch, record one node ok, then `gk status` reports that run id (previously `run:null`).

- [ ] **Step 2: Run to verify fail.**

- [ ] **Step 3: Implement** — replace `current.json` read with `activeRun(cwd)`; render `{run: id|null, nodes, evidence}`; delete the phantom file reference. (A fuller merge of status+analyze is P2/P3; this task only makes status honest.)

- [ ] **Step 4: Verify** — `bun test tests/unit/run-cli.test.ts tests/unit/cli-trust.test.ts && bun run typecheck` → PASS.

- [ ] **Step 5: Commit** — `fix(status): derive run state from .active+ledger — remove current.json ghost read`

---

## Self-review

- **Spec §5 P0 coverage:** resolver ✓(T1) · error path ✓(T2) · validate-at-start ✓(T3) · target table + binding ✓(T4) · `--node` ✓(T5) · ghost status ✓(T6, folded — contract bug).
- **Placeholder scan:** all steps carry file:line, code, and commands.
- **Type consistency:** `resolveGraphPath`/`resolveGraph`, `Issue`/`formatZodIssues`, `agentDirsFor`, `agentFileName`, `addEvidence{node}` used consistently across tasks.
- **Order:** T1+T2 are independent; T3 needs T1; T4 independent; T5+T6 need T1. Dispatch T1/T2/T4 in parallel, then T3/T5/T6.
