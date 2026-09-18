# Advisor Mode & Fable-Orchestration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship node-level `advisor` (mechanical failure-streak escalation to a frontier-tier read-only advisor) and `fan_out` (planner-written briefs executed as parallel in-node host subagents) as graph primitives, with run-ledger audit and a memory `advisor-repeat` pattern.

**Architecture:** gk never invokes a model. Schema accepts + validates the two node objects; the waves compiler passes them through verbatim; host execute-skills (5 kit mirrors) implement dispatch semantics prompt-advisorily (mechanically constrained on pi); the run ledger records advisor events to a per-run `advisor.jsonl`; `memory consolidate` learns `advisor-repeat` patterns and emits suggestions.

**Tech Stack:** TypeScript, zod (schema), bun:test, YAML. No new deps.

**Spec:** `docs/superpowers/specs/2026-09-04-fable-advisor-orchestration-design.md`

## Global Constraints

- Model tier enum is exactly `opus|sonnet|haiku|fable` (`NodeRef` in `src/schemas/graph.schema.ts:5`). `advisor.model` reuses it.
- gk CLI never invokes a model — hosts dispatch subagents.
- No runtime topology mutation; briefs are data, not edges.
- No new npm deps. `src/eval/**` is import-allowed, edit-forbidden.
- Skills live ONLY in the 5 tracked mirrors `kits/{claude,codex,cursor,pi,opencode}/skills/gk-execute/SKILL.md` — NEVER `.omp/skills/` (untracked user copies). Mirrors must stay byte-identical (`tests/unit/kit-skill-parity.test.ts` enforces).
- Test runner is `bun:test`; tests use `tmpdir()` + `rmSync` cleanup per existing style.
- NEVER run `gk init`/`gk new` inside the graph-kit repo itself.
- Commit after every green test run. Conventional commits (`feat:`, `test:`, `docs:`).

## File Structure

- `src/schemas/graph.schema.ts` — add `AdvisorConfig`, `FanOutConfig`, wire into `NodeDefSchema`; graph-level `superRefine` for `fan_out.briefs_from` upstream check.
- `src/cli/commands/graph.ts` — `nodeObj()` in the `waves` subcommand emits `advisor`/`fan_out` (~line 949).
- `src/memory/ledger.ts` — `AdvisorEvent`, `appendAdvisor`, `readAdvisorEvents` (per-run `advisor.jsonl`).
- `src/cli/commands/run.ts` — `run node --advisor-fired <round> [--streak <n>]`; `run status` gains `advisor_events` count.
- `src/memory/patterns.ts` — kind `"advisor-repeat"`, extraction over advisor events.
- `src/schemas/memory.schema.ts` — extend `PATTERN_KINDS`.
- `src/memory/consolidate.ts` — load advisor events per run, pass to `extractPatterns`, suggestion for `advisor-repeat`.
- `kits/{claude,codex,cursor,pi,opencode}/skills/gk-execute/SKILL.md` — advisor + fan-out dispatch mechanics.
- `tests/unit/advisor-schema.test.ts` (new), plus edits to `run-ledger.test.ts`, `patterns.test.ts`, `waves-hooks.test.ts`, `run-cli.test.ts`, `tests/integration/ledger-consolidate.test.ts`.
- `README.md`, `CHANGELOG.md`.

---

### Task 1: Schema — `advisor` and `fan_out` on nodes

**Files:**
- Modify: `src/schemas/graph.schema.ts`
- Test: `tests/unit/advisor-schema.test.ts` (create)

**Interfaces:**
- Produces: `NodeDefSchema` fields `advisor?: { model: "opus"|"sonnet"|"haiku"|"fable"; after_failed_rounds: number; max_calls: number }` (zod-defaulted: `fable`, `1`, `1`) and `fan_out?: { briefs_from: string; template: string }` (template default `"{brief.body}"`). Downstream tasks read these from parsed `Graph` nodes and the waves payload.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/unit/advisor-schema.test.ts
import { describe, expect, test } from "bun:test";
import { GraphSchema } from "../../src/schemas/graph.schema.js";

const base = {
  metadata: { name: "demo" },
  topology: "custom",
};

describe("advisor schema", () => {
  test("accepts advisor on a looping node and applies defaults", () => {
    const r = GraphSchema.safeParse({
      ...base,
      nodes: { work: { agent: "builder", objective: "build", loop: { enabled: true, max_rounds: 6 }, advisor: {} } },
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.nodes.work.advisor).toEqual({ model: "fable", after_failed_rounds: 1, max_calls: 1 });
    }
  });

  test("rejects advisor without loop.enabled", () => {
    const r = GraphSchema.safeParse({
      ...base,
      nodes: { work: { agent: "builder", objective: "build", advisor: {} } },
    });
    expect(r.success).toBe(false);
    expect(r.error!.issues.some((i) => i.message.includes("advisor requires loop.enabled")));
  });

  test("rejects bad tier and zero thresholds", () => {
    const bad1 = GraphSchema.safeParse({
      ...base,
      nodes: { w: { agent: "b", objective: "o", loop: { enabled: true }, advisor: { model: "gpt5" } } },
    });
    const bad2 = GraphSchema.safeParse({
      ...base,
      nodes: { w: { agent: "b", objective: "o", loop: { enabled: true }, advisor: { max_calls: 0 } } },
    });
    const bad3 = GraphSchema.safeParse({
      ...base,
      nodes: { w: { agent: "b", objective: "o", loop: { enabled: true }, advisor: { after_failed_rounds: 0 } } },
    });
    expect(bad1.success && bad2.success && bad3.success).toBe(false);
  });
});

describe("fan_out schema", () => {
  test("accepts fan_out with upstream briefs_from and defaults template", () => {
    const r = GraphSchema.safeParse({
      ...base,
      nodes: {
        plan: { agent: "planner", objective: "plan" },
        exec: { agent: "builder", objective: "exec", depend_on: ["plan"], fan_out: { briefs_from: "plan" } },
      },
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.nodes.exec.fan_out).toEqual({ briefs_from: "plan", template: "{brief.body}" });
  });

  test("rejects dangling briefs_from", () => {
    const r = GraphSchema.safeParse({
      ...base,
      nodes: { exec: { agent: "b", objective: "o", fan_out: { briefs_from: "ghost" } } },
    });
    expect(r.success).toBe(false);
  });

  test("rejects non-upstream briefs_from (sibling, not predecessor)", () => {
    const r = GraphSchema.safeParse({
      ...base,
      nodes: {
        a: { agent: "b", objective: "o" },
        b: { agent: "b", objective: "o" },
        exec: { agent: "b", objective: "o", fan_out: { briefs_from: "b" } },
      },
    });
    expect(r.success).toBe(false);
    expect(r.error!.issues.some((i) => i.message.includes("upstream")));
  });

  test("rejects empty template", () => {
    const r = GraphSchema.safeParse({
      ...base,
      nodes: {
        plan: { agent: "p", objective: "o" },
        exec: { agent: "b", objective: "o", depend_on: ["plan"], fan_out: { briefs_from: "plan", template: "" } },
      },
    });
    expect(r.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/unit/advisor-schema.test.ts`
Expected: FAIL — unknown-key errors / missing refinements (zod strips or rejects `advisor`/`fan_out` today).

- [ ] **Step 3: Implement schema**

In `src/schemas/graph.schema.ts`, after `LoopConfig` (line ~23):

```ts
const AdvisorConfig = z.object({
  model: NodeRef.default("fable"),
  after_failed_rounds: z.number().int().min(1).default(1),
  max_calls: z.number().int().min(1).default(1),
});

const FanOutConfig = z.object({
  briefs_from: z.string().min(1),
  template: z.string().min(1).default("{brief.body}"),
});
```

In `NodeDefSchema` (line ~38), add after `eval: EvalConfig.optional(),`:

```ts
  advisor: AdvisorConfig.optional(),
  fan_out: FanOutConfig.optional(),
```

Chain a `.superRefine` onto `NodeDefSchema` for the same-node rule (place after the closing `});` of the object literal — convert `const NodeDefSchema = z.object({...});` to `const NodeDefSchema = z.object({...}).superRefine((n, ctx) => {...});`):

```ts
.superRefine((n, ctx) => {
  if (n.advisor && !(n.loop?.enabled)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["advisor"], message: "advisor requires loop.enabled: true on the same node" });
  }
})
```

In the existing graph-level `.superRefine((graph, ctx) => {...})` (line ~137), after the `depend_on` loop, add:

```ts
    // fan_out.briefs_from must be a reachable predecessor (transitive depend_on closure)
    const upstreamOf = (id: string, seen = new Set<string>()): Set<string> => {
      for (const dep of nodes[id]?.depend_on ?? []) {
        if (names.has(dep) && !seen.has(dep)) {
          seen.add(dep);
          for (const t of upstreamOf(dep, seen)) seen.add(t);
        }
      }
      return seen;
    };
    for (const [id, node] of Object.entries(nodes)) {
      if (!node.fan_out) continue;
      const upstream = upstreamOf(id);
      const target = node.fan_out.briefs_from;
      if (!names.has(target)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["nodes", id, "fan_out", "briefs_from"], message: `fan_out.briefs_from references unknown node "${target}"` });
      } else if (!upstream.has(target)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["nodes", id, "fan_out", "briefs_from"], message: `fan_out.briefs_from "${target}" is not an upstream node of "${id}" — add it to depend_on` });
      }
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/unit/advisor-schema.test.ts && bun test tests/unit/schema-validation.test.ts tests/unit/loop-schema.test.ts tests/unit/loop-validation.test.ts`
Expected: all PASS (existing suites unaffected).

- [ ] **Step 5: Commit**

```bash
git add src/schemas/graph.schema.ts tests/unit/advisor-schema.test.ts
git commit -m "feat: advisor + fan_out node schema with cross-node validation"
```

---

### Task 2: Waves payload passthrough

**Files:**
- Modify: `src/cli/commands/graph.ts` (nodeObj, ~line 949)
- Test: `tests/unit/waves-hooks.test.ts` (extend)

**Interfaces:**
- Consumes: parsed node fields from Task 1 (`nodes[id].advisor`, `nodes[id].fan_out`, zod-defaulted).
- Produces: waves payload node objects gain `"advisor": {...}|null` and `"fan_out": {...}|null` — the shape `/gk:execute` host skills read.

- [ ] **Step 1: Write the failing test** (append inside the existing waves describe in `tests/unit/waves-hooks.test.ts`; copy the graph-loading helper style used there — read the file first and mirror its fixtures)

```ts
test("waves payload carries advisor and fan_out verbatim", () => {
  const yaml = [
    "metadata:",
    "  name: orch",
    "topology: custom",
    "nodes:",
    "  plan:",
    "    agent: planner",
    "    objective: write briefs",
    "    model: fable",
    "  exec:",
    "    agent: builder",
    "    objective: execute briefs",
    "    depend_on: [plan]",
    "    model: sonnet",
    "    loop: { enabled: true, max_rounds: 6 }",
    "    advisor: { model: opus, after_failed_rounds: 2, max_calls: 2 }",
    "    fan_out: { briefs_from: plan, template: \"Implement {brief.title}: {brief.body}\" }",
  ].join("\n");
  // ...write yaml to tmp graph.yaml, invoke the waves command the same way
  // existing tests in this file do, parse the JSON envelope...
  const exec = payload.waves.flatMap((w: { nodes: unknown[] }) => w.nodes).find((n: { id: string }) => n.id === "exec");
  expect(exec.advisor).toEqual({ model: "opus", after_failed_rounds: 2, max_calls: 2 });
  expect(exec.fan_out).toEqual({ briefs_from: "plan", template: "Implement {brief.title}: {brief.body}" });
  const plan = payload.waves.flatMap((w: { nodes: unknown[] }) => w.nodes).find((n: { id: string }) => n.id === "plan");
  expect(plan.advisor).toBeNull();
  expect(plan.fan_out).toBeNull();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/unit/waves-hooks.test.ts`
Expected: FAIL — `advisor`/`fan_out` absent from node objects.

- [ ] **Step 3: Implement**

In `src/cli/commands/graph.ts` `nodeObj` (line ~949), add after `evidence: nodes[id]?.evidence || [],`:

```ts
            advisor: nodes[id]?.advisor ?? null,
            fan_out: nodes[id]?.fan_out ?? null,
```

- [ ] **Step 4: Run to verify pass**

Run: `bun test tests/unit/waves-hooks.test.ts tests/unit/waves-memory.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/graph.ts tests/unit/waves-hooks.test.ts
git commit -m "feat: waves payload carries advisor and fan_out"
```

---

### Task 3: Ledger advisor events + run CLI

**Files:**
- Modify: `src/memory/ledger.ts`, `src/cli/commands/run.ts`
- Test: `tests/unit/run-ledger.test.ts` (extend), `tests/unit/run-cli.test.ts` (extend)

**Interfaces:**
- Produces:
  - `interface AdvisorEvent { at: string; node: string; round: number; tier: string; streak: number | null }`
  - `appendAdvisor(cwd: string, ev: Omit<AdvisorEvent, "at">, now?): { event: AdvisorEvent; run: string }` — throws `NO_ACTIVE_RUN` like `appendNode`; appends JSON line to `<runDir>/advisor.jsonl`.
  - `readAdvisorEvents(cwd: string, id: string): AdvisorEvent[]` — `[]` when file missing.
  - CLI: `gk run node <id> --advisor-fired <round> [--streak <n>]` — node status flags NOT required for this mode; `tier` derived from `advisor.model` in `--graph` (default `./graph.yaml`); exits with `BAD_ADVISOR` JSON fail if node lacks `advisor`.
  - `gk run status` payload gains `advisor_events: number` (count for active run).

- [ ] **Step 1: Write failing tests**

In `tests/unit/run-ledger.test.ts` (after existing tests):

```ts
test("appendAdvisor writes advisor.jsonl; readAdvisorEvents round-trips", () => {
  const { id } = startRun(cwd, join(cwd, "graph.yaml"), "2026-09-03T10:00:00.000Z");
  const r1 = appendAdvisor(cwd, { node: "exec", round: 2, tier: "fable", streak: 2 }, "2026-09-03T10:05:00.000Z");
  expect(r1.run).toBe(id);
  const events = readAdvisorEvents(cwd, id);
  expect(events).toEqual([{ at: "2026-09-03T10:05:00.000Z", node: "exec", round: 2, tier: "fable", streak: 2 }]);
});

test("appendAdvisor without active run fails", () => {
  expect(() => appendAdvisor(cwd, { node: "x", round: 1, tier: "fable", streak: 1 })).toThrow(/NO_ACTIVE_RUN/);
});

test("readAdvisorEvents returns [] when no file", () => {
  expect(readAdvisorEvents(cwd, "nonexistent")).toEqual([]);
});
```

In `tests/unit/run-cli.test.ts`, follow that file's existing CLI invocation pattern (read it first) and add:

```ts
test("run node --advisor-fired records event with tier from graph", () => {
  // graph.yaml contains: nodes: exec: { agent: b, objective: o, loop: {enabled: true}, advisor: { model: opus } }
  // run start → run node exec --advisor-fired 2 --streak 2 --graph <path>
  // expect ok envelope; readAdvisorEvents → tier "opus", round 2, streak 2
});

test("run node --advisor-fired on node without advisor fails BAD_ADVISOR", () => {
  // expect fail envelope code BAD_ADVISOR
});

test("run status includes advisor_events count", () => {
  // after one advisor event: status payload advisor_events === 1
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test tests/unit/run-ledger.test.ts tests/unit/run-cli.test.ts`
Expected: FAIL — exports don't exist.

- [ ] **Step 3: Implement**

`src/memory/ledger.ts` — after `appendNode`:

```ts
export interface AdvisorEvent {
  at: string;
  node: string;
  round: number;
  tier: string;
  streak: number | null;
}

export function appendAdvisor(
  cwd: string,
  ev: Omit<AdvisorEvent, "at">,
  now = new Date().toISOString(),
): { event: AdvisorEvent; run: string } {
  const dir = mustActiveRun(cwd); // reuse the same internal guard appendNode uses; if appendNode inlines it, extract or replicate the activeRun check that throws NO_ACTIVE_RUN
  const event: AdvisorEvent = { at: now, ...ev };
  appendFileSync(join(dir, "advisor.jsonl"), `${JSON.stringify(event)}\n`);
  return { event, run: basename(dir) };
}

export function readAdvisorEvents(cwd: string, id: string): AdvisorEvent[] {
  const f = join(runsDir(cwd), id, "advisor.jsonl");
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as AdvisorEvent);
}
```

`src/cli/commands/run.ts` — add options `--advisor-fired <round>` and `--streak <n>` to the `run` command; inside the `node` subcommand branch, BEFORE the `--status` validation:

```ts
        if (subcommand === "node") {
          const node = Array.isArray(args) ? args[0] : args;
          if (!node) { /* existing MISSING_ARG */ }
          if (opts.advisorFired != null) {
            const round = Number(opts.advisorFired);
            if (!Number.isInteger(round) || round < 1) {
              console.log(JSON.stringify(fail("BAD_ADVISOR", "--advisor-fired requires an integer round >= 1")));
              return;
            }
            // tier from the graph's node.advisor.model (spec §5)
            const graphPath = opts.graph ?? join(cwd, "graph.yaml");
            const parsed = GraphSchema.safeParse(YAML.parse(readFileSync(graphPath, "utf-8")));
            const advisor = parsed.success ? parsed.data.nodes[String(node)]?.advisor : undefined;
            if (!advisor) {
              console.log(JSON.stringify(fail("BAD_ADVISOR", `node "${node}" has no advisor config in ${graphPath}`)));
              return;
            }
            console.log(JSON.stringify(ok(appendAdvisor(cwd, {
              node: String(node),
              round,
              tier: advisor.model,
              streak: opts.streak == null ? null : Number(opts.streak),
            }))));
            return;
          }
          // ...existing --status path unchanged
```

Add imports: `readFileSync` from `node:fs`, `YAML`, `GraphSchema`, `appendAdvisor` (extend the existing ledger import). In `status`: change the payload to

```ts
          const dir = activeRun(cwd);
          const advisor_events = dir ? readAdvisorEvents(cwd, basename(dir)).length : 0;
          console.log(JSON.stringify(ok({ active: dir, advisor_events })));
```

(`basename` from `node:path` — extend existing import.)

- [ ] **Step 4: Run to verify pass**

Run: `bun test tests/unit/run-ledger.test.ts tests/unit/run-cli.test.ts tests/unit/cli-status-commands.test.ts`
Expected: PASS (if `cli-status-commands.test.ts` asserts the exact old status shape, update it to include `advisor_events`).

- [ ] **Step 5: Commit**

```bash
git add src/memory/ledger.ts src/cli/commands/run.ts tests/unit/run-ledger.test.ts tests/unit/run-cli.test.ts tests/unit/cli-status-commands.test.ts
git commit -m "feat: advisor events in run ledger + --advisor-fired CLI + status count"
```

---

### Task 4: `advisor-repeat` pattern + consolidate wiring

**Files:**
- Modify: `src/memory/patterns.ts`, `src/schemas/memory.schema.ts`, `src/memory/consolidate.ts`
- Test: `tests/unit/patterns.test.ts` (extend), `tests/integration/ledger-consolidate.test.ts` (extend)

**Interfaces:**
- Consumes: `readAdvisorEvents` + `AdvisorEvent` from Task 3; `RunIndexLine[]` from ledger.
- Produces:
  - `PatternKind` gains `"advisor-repeat"`; `PATTERN_KINDS` in `src/schemas/memory.schema.ts` gains `"advisor-repeat"`.
  - `extractPatterns(runs, traces, advisors: Map<string, AdvisorEvent[]> = new Map(), now?)` — third param defaulted so existing callers compile.
  - Pattern: signature `advisor-repeat:<node>`, members `[node]`, label `<node> needed advisor help`, min 2 distinct runs (constant `ADVISOR_MIN = 2`).
  - Suggestion (action `"review-failure"` — reuses existing enum, zero schema churn; rationale carries the advisor framing): `"raise {node} model tier or loosen its stop_when — it needed advisor help in {count} runs"`.

- [ ] **Step 1: Write failing tests**

In `tests/unit/patterns.test.ts` (mirror its existing fixture style):

```ts
test("advisor-repeat: node with advisor events in 2 runs becomes a pattern", () => {
  const runs = [
    { id: "r1", graph: "demo", graph_sha256: "a", started_at: "2026-09-01T00:00:00.000Z", ended_at: "2026-09-01T01:00:00.000Z", status: "merged", evidence_keys: [] },
    { id: "r2", graph: "demo", graph_sha256: "a", started_at: "2026-09-02T00:00:00.000Z", ended_at: "2026-09-02T01:00:00.000Z", status: "merged", evidence_keys: [] },
  ] as Parameters<typeof extractPatterns>[0];
  const advisors = new Map([
    ["r1", [{ at: "2026-09-01T00:30:00.000Z", node: "exec", round: 2, tier: "fable", streak: 2 }]],
    ["r2", [{ at: "2026-09-02T00:30:00.000Z", node: "exec", round: 3, tier: "fable", streak: 3 }]],
  ]);
  const pats = extractPatterns(runs, new Map(), advisors, "2026-09-02T02:00:00.000Z");
  const p = pats.find((p) => p.kind === "advisor-repeat");
  expect(p?.members).toEqual(["exec"]);
  expect(p?.runs).toEqual(["r1", "r2"]);
});

test("single-run advisor event does not pattern", () => {
  // one run, one event → no advisor-repeat in output
});
```

In `tests/integration/ledger-consolidate.test.ts`, add a case: two runs each with one advisor event on node `exec` via `appendAdvisor` (needs `run start` → events → `run end` twice), then `consolidate(cwd)`; assert a pattern file with `kind: advisor-repeat` exists under `.graphkit/memory/patterns/` and a suggestion file whose rationale contains "raise exec model tier or loosen its stop_when".

- [ ] **Step 2: Run to verify failure**

Run: `bun test tests/unit/patterns.test.ts tests/integration/ledger-consolidate.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`src/memory/patterns.ts`:
- `export type PatternKind = ... | "advisor-repeat";`
- `const ADVISOR_MIN = 2;`
- New import: `import type { AdvisorEvent } from "./ledger.js";`
- Signature: `export function extractPatterns(runs: RunIndexLine[], traces: Map<string, TraceLine[]>, advisors: Map<string, AdvisorEvent[]> = new Map(), now = new Date().toISOString()): Pattern[]`
- In the run loop (after failure-recurrence):

```ts
    // advisor-repeat: a node consumed advisor help
    for (const ev of advisors.get(run.id) ?? []) bump(advisors, `${ev.node}`, run.id, ev.at || at);
```

(name the map `advisorAcc` to avoid clashing with the param — adjust: `const advisorAcc = new Map<string, Acc>();` … `bump(advisorAcc, ev.node, run.id, ev.at || at);`)

- In the output section:

```ts
  for (const [key, acc] of advisorAcc) {
    if (acc.runs.size < ADVISOR_MIN) continue;
    out.push(toPattern("advisor-repeat", [key], `${key} needed advisor help`, acc, now));
  }
```

(`signatureOf` already namespaces by kind — verify it does; if it formats `kind:members.join()`, `advisor-repeat:exec` falls out.)

`src/schemas/memory.schema.ts`: `PATTERN_KINDS = [..., "advisor-repeat"] as const;`

`src/memory/consolidate.ts`:
- Import `readAdvisorEvents` from `./ledger.js`.
- Where traces map is built (inside `consolidate`, find the `listRunIds`/`readTrace` loop), also build `advisors` map; pass to `extractPatterns(runs, traces, advisors)`.
- In `suggestionsFor`, add:

```ts
  if (p.kind === "advisor-repeat") {
    out.push({
      id: `sugg-${p.signature}`,
      action: "review-failure",
      rationale: `raise ${p.members[0]} model tier or loosen its stop_when — it needed advisor help in ${p.count} runs`,
      based_on: [p.signature],
      salience: p.salience,
    });
  }
```

- [ ] **Step 4: Run to verify pass**

Run: `bun test tests/unit/patterns.test.ts tests/unit/pattern-schema.test.ts tests/integration/ledger-consolidate.test.ts tests/unit/suggest.test.ts tests/integration/memory-pipeline.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/memory/patterns.ts src/schemas/memory.schema.ts src/memory/consolidate.ts tests/unit/patterns.test.ts tests/integration/ledger-consolidate.test.ts
git commit -m "feat: advisor-repeat pattern + consolidate suggestion"
```

---

### Task 5: Execute-skill mechanics (5 kit mirrors)

**Files:**
- Modify: `kits/claude/skills/gk-execute/SKILL.md`, `kits/codex/skills/gk-execute/SKILL.md`, `kits/cursor/skills/gk-execute/SKILL.md`, `kits/pi/skills/gk-execute/SKILL.md`, `kits/opencode/skills/gk-execute/SKILL.md` — identical content in each.

**Interfaces:**
- Consumes: waves payload `node.advisor` / `node.fan_out` (Task 2), `gk run node --advisor-fired` (Task 3).
- Produces: host-side dispatch contract. No code — skill text.

- [ ] **Step 1: Read one mirror** (`kits/claude/skills/gk-execute/SKILL.md`) to find the node-dispatch section and existing loop/stopping language; insert the two blocks below adapted to that file's heading style and dispatch-phrasing conventions (same relative position in all 5).

- [ ] **Step 2: Add advisor block** (after the existing loop-handling guidance):

```markdown
## Advisor escalation

When a node's payload carries `advisor`:

1. Track the failed-round streak while looping the node (a round fails when `stop_when` is unmet, the agent exits non-zero, or required evidence is missing).
2. When streak ≥ `advisor.after_failed_rounds` AND advisor calls this run < `advisor.max_calls`: dispatch a read-only advisor subagent BEFORE the next node round:
   - model tier = `advisor.model`; tools: none beyond read; MUST NOT edit files.
   - input: the node's objective, the last round's output, and the failure evidence.
   - ask for: a diagnosis and the single next action.
3. Record the escalation: `gk run node <id> --advisor-fired <round> --streak <n>`.
4. Append the advice to the node's objective under an `## Advisor guidance` heading and re-dispatch the NODE at its original model tier.
5. If `max_calls` is reached or `max_rounds` is exhausted, take the existing failure path.
```

- [ ] **Step 3: Add fan-out block**:

```markdown
## Fan-out execution

When a node's payload carries `fan_out`:

1. Read `briefs.json` (a JSON array of `{id, title, body}`) from the evidence of node `fan_out.briefs_from`. Missing/malformed file = a failed round for this node (normal loop semantics; advisor may then fire).
2. Dispatch one parallel subagent per brief, objective = `fan_out.template` rendered with the brief (default template `{brief.body}`). Subagents run at the NODE's model tier.
3. Barrier on all briefs; consolidate their outputs into this node's evidence and final output. Any failed brief marks the round failed.
4. Empty briefs array: node output is "no briefs" — ok status.
```

- [ ] **Step 4: Copy identical blocks to the other 4 mirrors** — byte-identical insertion relative to each mirror's structure (mirrors share structure; `kits/pi` may phrase dispatch as `gk_dispatch_agent` with `constraints: { no_write: true }` for the advisor subagent — keep the pi-specific dispatch phrasing that mirror already uses for read-only subagents).

- [ ] **Step 5: Run parity + kit tests**

Run: `bun test tests/unit/kit-skill-parity.test.ts tests/unit/pi-kit.test.ts tests/unit/codex-kit.test.ts tests/unit/cursor-kit.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add kits/claude/skills/gk-execute/SKILL.md kits/codex/skills/gk-execute/SKILL.md kits/cursor/skills/gk-execute/SKILL.md kits/pi/skills/gk-execute/SKILL.md kits/opencode/skills/gk-execute/SKILL.md
git commit -m "feat: advisor + fan-out dispatch mechanics in gk-execute skills"
```

---

### Task 6: E2E smoke (temp dir)

**Files:**
- Create: `tests/acceptance/advisor-fanout.e2e.test.ts`

**Interfaces:**
- Consumes: everything above, via the built CLI (`bun run src/index.ts` — check how `tests/acceptance/acceptance.test.ts` invokes the CLI and mirror it).

- [ ] **Step 1: Write the E2E**

Temp dir. Write `graph.yaml`:

```yaml
apiVersion: graphkit.dev/v2
kind: Graph
metadata:
  name: orch-smoke
topology: custom
nodes:
  plan:
    agent: planner
    model: fable
    objective: Write .graphkit/evidence/plan/briefs.json as a JSON array of briefs.
  exec:
    agent: builder
    model: sonnet
    objective: Execute all briefs from the plan.
    depend_on: [plan]
    loop: { enabled: true, max_rounds: 4 }
    advisor: { model: fable, after_failed_rounds: 2, max_calls: 1 }
    fan_out: { briefs_from: plan, template: "Implement {brief.title}: {brief.body}" }
```

(Also create `.graphkit/evidence/` layout if the CLI demands it — mirror `tests/acceptance/acceptance.test.ts` fixtures.)

Assertions:
1. `gk validate` → ok envelope (needs `.omp/agents/planner.md`, `builder.md` in the temp dir — copy from acceptance fixtures).
2. `gk graph waves` → `exec` node object has `advisor.model === "fable"` and `fan_out.briefs_from === "plan"`.
3. `gk run start` → ok.
4. `gk run node exec --status fail --wave 1` → ok.
5. `gk run node exec --advisor-fired 2 --streak 2` → ok; `advisor.jsonl` in run dir contains one line with `tier: "fable"`.
6. `gk run status` → `advisor_events === 1`.
7. `gk run end --status failed` → ok.
8. `gk memory consolidate` → patterns dir contains an `advisor-repeat` file for `exec` (may need a second scripted run for the ≥2-runs threshold — run steps 3–7 twice with different node statuses if consolidate requires 2 runs; assert pattern then).

- [ ] **Step 2: Run**

Run: `bun test tests/acceptance/advisor-fanout.e2e.test.ts`
Expected: PASS end-to-end.

- [ ] **Step 3: Full suite**

Run: `bun test`
Expected: 518+ tests, 0 failures (1 pre-existing skip).

- [ ] **Step 4: Commit**

```bash
git add tests/acceptance/advisor-fanout.e2e.test.ts
git commit -m "test: advisor + fan-out e2e smoke"
```

---

### Task 7: Docs

**Files:**
- Modify: `README.md` (§Execution contracts), `CHANGELOG.md`

- [ ] **Step 1: README** — in §Execution contracts, after the loop-semantics paragraphs (~line 314), add:

```markdown
### Advisor escalation

A looping node may declare `advisor: {model, after_failed_rounds, max_calls}`. When a node's
failed-round streak reaches `after_failed_rounds` and `max_calls` hasn't been exhausted, the
host's execute-skill dispatches a read-only advisor subagent at `advisor.model` (default
`fable`), appends its guidance to the node's objective (`## Advisor guidance`), and re-dispatches
the node at its original tier. Escalations are recorded via `gk run node <id> --advisor-fired
<round>` into the run's `advisor.jsonl`; `gk run status` reports the count; `gk memory
consolidate` surfaces `advisor-repeat` patterns ("raise tier or loosen stop_when").

### Fan-out execution

A node may declare `fan_out: {briefs_from, template}`. The referenced upstream node writes
`briefs.json` (array of `{id, title, body}`) into its evidence; the fan-out node dispatches one
parallel host subagent per brief (`template` rendered per brief, default `{brief.body}`) and
consolidates their outputs. Briefs are data, never edges — the wave topology stays static.
`briefs_from` must be a reachable predecessor (`depend_on` closure).
```

Update the CLI reference table row for `run` to mention `--advisor-fired`, `--streak`.

- [ ] **Step 2: CHANGELOG** — add under a new `## Unreleased` heading:

```markdown
## Unreleased

### Added

- `advisor` node config: mechanical failure-streak escalation to a read-only frontier-tier
  advisor subagent; advice appended to the node objective; capped by `max_calls` and
  `loop.max_rounds`.
- `fan_out` node config: planner-written `briefs.json` executed as parallel in-node host
  subagents (`briefs_from`, `template`).
- `gk run node --advisor-fired <round> [--streak <n>]` ledger events (`advisor.jsonl`);
  `gk run status` reports `advisor_events`.
- `advisor-repeat` memory pattern + "raise model tier / loosen stop_when" suggestion.
```

- [ ] **Step 3: Verify**

Run: `bun test tests/unit/package-pack.test.ts && bun run build` (or repo's build script from package.json)
Expected: PASS + clean build.

- [ ] **Step 4: Commit**

```bash
git add README.md CHANGELOG.md
git commit -m "docs: advisor mode + fan-out execution contracts"
```

---

## Self-Review

**Spec coverage:** §1 schema → Task 1; §2 validation → Task 1 (schema-level refinements, matching repo precedent that cross-node checks live in `GraphSchema.superRefine`); §3 waves passthrough → Task 2; §4 execute-skill → Task 5; §5 ledger (`--advisor-fired`, status count) → Task 3, memory (`advisor-repeat` + suggestion) → Task 4; §6 tests → per-task + Task 6 E2E, docs → Task 7. Risks section is informational — no task needed.

**Placeholder scan:** Task 2/3/6 test stubs reference "mirror the existing fixture style" — the exact fixtures exist in the named files and the implementer reads them first; all production code blocks are complete. No TBDs.

**Type consistency:** `AdvisorEvent` fields (`at, node, round, tier, streak`) defined Task 3, consumed Task 4 identically. `extractPatterns` third param `advisors: Map<string, AdvisorEvent[]>` defaults so Task 4's change is backward-compatible with existing call sites. `advisor-repeat` string appears identically in Task 4 (patterns + schema + suggestion check). Waves node keys `advisor`/`fan_out` match Task 5 skill references and Task 6 assertions.

**Known deviations from spec:** `streak` passed by executor via `--streak` (spec said "derived from round counter" — the executor owns the true streak; CLI records what it's told, null when omitted). Suggestion reuses action `review-failure` instead of a new action kind (zero schema churn; rationale carries the advisor framing). Both are deliberate YAGNI calls recorded here for the reviewer.
