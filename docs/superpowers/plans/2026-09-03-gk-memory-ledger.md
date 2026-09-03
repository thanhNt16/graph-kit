# GraphKit Memory Ledger, Pattern Compiler, and Dream Graph Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give gk a persistent run ledger, a deterministic pattern compiler over that ledger, a suggestion surface, and a dream graph that proposes memory consolidations as reviewable diffs.

**Architecture:** Three layers over the filesystem. `gk run start|node|end` appends episodic traces to `.graphkit/runs/`. `gk memory consolidate` reads those traces and derives `.graphkit/memory/patterns/*.md`, `suggestions/*.md`, and `.links.json` with zero model calls. A bundled `dream.yaml` template lets an agent propose semantic consolidations as a unified diff into `.graphkit/inbox/`, applied only by a human. gk itself never invokes a model.

**Tech Stack:** TypeScript, Bun (`bun test`, `bun run build`), `cac` for CLI, `zod` for schemas, `yaml` for frontmatter.

## Global Constraints

- **`src/eval/**` is OFF-LIMITS.** `program.md` invariant 3 freezes `benchmark.jsonl`, `src/eval/**`, `eval/**`, `scripts/cbm-parity.ts`, and the metric definition. `src/eval/memory-recall.ts` and `src/eval/forgetting.ts` live there. All new recall/decay logic goes in NEW modules under `src/memory/` that IMPORT from `src/eval/` — never edit those files.
- gk never invokes a model, spawns an agent, or reads an API key. It validates and compiles only.
- Every new CLI command MUST be added to `CLI_COMMANDS` in `src/cli/command-registry.ts` or `scripts/check-cli-parity.ts` fails.
- CLI output uses `ok(data)` / `fail(code, message, details)` from `src/cli/output.ts`. `fail()` already sets `process.exitCode = 1`.
- `cac` 6.x matches a single leading token only. Subcommands dispatch inside one `cli.command("name [subcommand] [args...]")` action, exactly like `registerMemoryCommands`.
- Frontmatter format: `---\n${YAML.stringify(obj)}---\n${body}` (no blank line between `---` and body).
- Timestamps: `new Date().toISOString()` — UTC ISO-8601. `MemoryDate` in the schema is `z.string().datetime({ offset: true })`.
- Tests: `bun:test` (`import { describe, expect, test } from "bun:test"`), temp dirs via `join(tmpdir(), \`gk-<name>-${process.pid}-${Date.now()}\`)`, cleaned in `afterEach`.
- No new npm dependencies.

---

## File Structure

**Create:**
- `src/memory/ledger.ts` — run ledger read/write primitives (start, appendNode, end, readIndex, readTrace).
- `src/cli/commands/run.ts` — `gk run` CLI surface over `ledger.ts`.
- `src/memory/patterns.ts` — deterministic pattern extraction (n-grams, co-occurrence, failure, reuse) + salience.
- `src/memory/links.ts` — `.links.json` builder (wikilinks + entity mentions).
- `src/memory/consolidate.ts` — orchestrates patterns + links + suggestions + `index.md`.
- `src/memory/suggest.ts` — ranking + dismissal over `suggestions/*.md`.
- `templates/gallery/dream.yaml` — the dream GraphTemplate.
- Tests: `tests/unit/run-ledger.test.ts`, `tests/unit/patterns.test.ts`, `tests/unit/links.test.ts`, `tests/unit/suggest.test.ts`, `tests/integration/ledger-consolidate.test.ts`.

**Modify:**
- `src/index.ts` — register the run command.
- `src/cli/command-registry.ts` — add `run start|node|end`, `memory consolidate`, `suggest`.
- `src/cli/commands/memory.ts` — dispatch `consolidate` subcommand.
- `src/schemas/memory.schema.ts` — pattern/suggestion frontmatter schemas.
- `src/cli/commands/graph.ts` — emit hook commands in the waves payload.
- `src/cli/commands/kit.ts` — mkdir `.graphkit/inbox`.
- Skills: `gk-execute`, `gk-recall`, `gk-brainstorm`, `gk-init-graph` (`.omp/skills/` + `kits/*/skills/`).
- `README.md`, `CHANGELOG.md`.

---

## Task 1: Run ledger core

**Files:**
- Create: `src/memory/ledger.ts`
- Test: `tests/unit/run-ledger.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface TraceLine { at: string; node: string; wave: number | null; agent: string | null; model: string | null; status: "ok" | "fail"; evidence: string[]; duration_ms: number | null; notes: string | null }`
  - `interface RunIndexLine { id: string; graph: string; graph_sha256: string; started_at: string; ended_at: string; status: "merged" | "blocked" | "failed"; node_count: number; failures: number; evidence_keys: string[] }`
  - `startRun(cwd: string, graphPath: string, now?: string): { id: string; dir: string }`
  - `appendNode(cwd: string, line: Omit<TraceLine, "at">, now?: string): { run: string; node: string }`
  - `endRun(cwd: string, status: RunIndexLine["status"], now?: string): RunIndexLine`
  - `activeRun(cwd: string): string | null`
  - `readRunIndex(cwd: string): RunIndexLine[]`
  - `readTrace(cwd: string, runId: string): TraceLine[]`
  - Errors thrown: `Error("RUN_ACTIVE: ...")`, `Error("NO_ACTIVE_RUN: ...")`, `Error("GRAPH_NOT_FOUND: ...")`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/run-ledger.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activeRun, appendNode, endRun, readRunIndex, readTrace, startRun } from "../../src/memory/ledger.js";

describe("run ledger", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = join(tmpdir(), `gk-ledger-${process.pid}-${Date.now()}`);
    mkdirSync(join(cwd, ".graphkit", "runs"), { recursive: true });
    writeFileSync(join(cwd, "graph.yaml"), "metadata:\n  name: demo\ntopology: diamond\n");
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  test("start writes .active, run.md, and empty trace", () => {
    const { id, dir } = startRun(cwd, join(cwd, "graph.yaml"), "2026-09-03T10:00:00.000Z");
    expect(id).toBe("20260903-100000-demo");
    expect(existsSync(join(dir, "run.md"))).toBe(true);
    expect(existsSync(join(dir, "trace.jsonl"))).toBe(true);
    expect(activeRun(cwd)).toBe(dir);
    expect(readFileSync(join(dir, "run.md"), "utf-8")).toContain("# Run 20260903-100000-demo");
  });

  test("second start while active fails", () => {
    startRun(cwd, join(cwd, "graph.yaml"), "2026-09-03T10:00:00.000Z");
    expect(() => startRun(cwd, join(cwd, "graph.yaml"), "2026-09-03T11:00:00.000Z")).toThrow(/RUN_ACTIVE/);
  });

  test("node append without active run fails", () => {
    expect(() =>
      appendNode(cwd, {
        node: "audit",
        wave: 0,
        agent: "code-reviewer",
        model: "sonnet",
        status: "ok",
        evidence: ["audit"],
        duration_ms: 1200,
        notes: null,
      }),
    ).toThrow(/NO_ACTIVE_RUN/);
  });

  test("start → node ×2 → end produces one index line and a readable trace", () => {
    const { id, dir } = startRun(cwd, join(cwd, "graph.yaml"), "2026-09-03T10:00:00.000Z");
    appendNode(cwd, { node: "a", wave: 0, agent: "x", model: "sonnet", status: "ok", evidence: ["k1"], duration_ms: 10, notes: null }, "2026-09-03T10:00:01.000Z");
    appendNode(cwd, { node: "b", wave: 1, agent: "y", model: "opus", status: "fail", evidence: [], duration_ms: 20, notes: "boom" }, "2026-09-03T10:00:02.000Z");
    const summary = endRun(cwd, "blocked", "2026-09-03T10:05:00.000Z");

    expect(summary.id).toBe(id);
    expect(summary.node_count).toBe(2);
    expect(summary.failures).toBe(1);
    expect(summary.evidence_keys).toEqual(["k1"]);
    expect(activeRun(cwd)).toBeNull();
    expect(readRunIndex(cwd)).toHaveLength(1);
    expect(readTrace(cwd, id).map((t) => t.node)).toEqual(["a", "b"]);
    expect(readFileSync(join(dir, "run.md"), "utf-8")).toContain("- `b` fail");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/run-ledger.test.ts`
Expected: FAIL — cannot resolve `../../src/memory/ledger.js`

- [ ] **Step 3: Write the implementation**

```ts
// src/memory/ledger.ts
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import YAML from "yaml";

export interface TraceLine {
  at: string;
  node: string;
  wave: number | null;
  agent: string | null;
  model: string | null;
  status: "ok" | "fail";
  evidence: string[];
  duration_ms: number | null;
  notes: string | null;
}

export interface RunIndexLine {
  id: string;
  graph: string;
  graph_sha256: string;
  started_at: string;
  ended_at: string;
  status: "merged" | "blocked" | "failed";
  node_count: number;
  failures: number;
  evidence_keys: string[];
}

const runsDir = (cwd: string) => join(cwd, ".graphkit", "runs");
const activeFile = (cwd: string) => join(runsDir(cwd), ".active");
const indexFile = (cwd: string) => join(runsDir(cwd), "index.jsonl");

/** Absolute path of the live run dir, or null when no run is active. */
export function activeRun(cwd: string): string | null {
  const f = activeFile(cwd);
  if (!existsSync(f)) return null;
  const dir = readFileSync(f, "utf-8").trim();
  return dir || null;
}

function graphName(graphPath: string): string {
  try {
    const parsed = YAML.parse(readFileSync(graphPath, "utf-8"));
    const name = parsed?.metadata?.name;
    if (typeof name === "string" && name.trim()) return name.trim();
  } catch {
    /* fall through to filename */
  }
  return basename(graphPath).replace(/\.ya?ml$/, "");
}

/** run id = YYYYMMDD-HHMMSS-<graphname>, derived from the start timestamp. */
function runId(now: string, name: string): string {
  const stamp = now.replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
  return `${stamp}-${name}`;
}

export function startRun(cwd: string, graphPath: string, now = new Date().toISOString()): { id: string; dir: string } {
  const existing = activeRun(cwd);
  if (existing) throw new Error(`RUN_ACTIVE: run already active at ${existing}; run \`gk run end\` first`);
  if (!existsSync(graphPath)) throw new Error(`GRAPH_NOT_FOUND: ${graphPath}`);

  const raw = readFileSync(graphPath, "utf-8");
  const name = graphName(graphPath);
  const id = runId(now, name);
  const dir = join(runsDir(cwd), id);
  mkdirSync(dir, { recursive: true });

  writeFileSync(join(dir, "trace.jsonl"), "");
  writeFileSync(
    join(dir, "meta.json"),
    `${JSON.stringify({ id, graph: name, graph_sha256: createHash("sha256").update(raw).digest("hex"), started_at: now }, null, 2)}\n`,
  );
  // GBrain layout: compiled truth above the rule, append-only timeline below.
  writeFileSync(
    join(dir, "run.md"),
    [`# Run ${id}`, "", `- graph: ${name}`, `- started_at: ${now}`, "- status: running", "", "---", "", "## Timeline", ""].join("\n"),
  );
  writeFileSync(activeFile(cwd), dir);
  return { id, dir };
}

export function appendNode(cwd: string, line: Omit<TraceLine, "at">, now = new Date().toISOString()) {
  const dir = activeRun(cwd);
  // Strict on purpose: an orphan trace line silently corrupts pattern statistics.
  if (!dir) throw new Error("NO_ACTIVE_RUN: start a run with `gk run start` before recording nodes");
  const entry: TraceLine = { at: now, ...line };
  appendFileSync(join(dir, "trace.jsonl"), `${JSON.stringify(entry)}\n`);
  const detail = [line.agent, line.duration_ms == null ? null : `${line.duration_ms}ms`, line.notes].filter(Boolean).join(" · ");
  appendFileSync(join(dir, "run.md"), `- \`${line.node}\` ${line.status}${detail ? ` — ${detail}` : ""}\n`);
  return { run: basename(dir), node: line.node };
}

export function readTrace(cwd: string, id: string): TraceLine[] {
  const f = join(runsDir(cwd), id, "trace.jsonl");
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as TraceLine];
      } catch {
        return []; // skip a torn line rather than abort the whole scan
      }
    });
}

export function readRunIndex(cwd: string): RunIndexLine[] {
  const f = indexFile(cwd);
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as RunIndexLine];
      } catch {
        return [];
      }
    });
}

export function endRun(cwd: string, status: RunIndexLine["status"], now = new Date().toISOString()): RunIndexLine {
  const dir = activeRun(cwd);
  if (!dir) throw new Error("NO_ACTIVE_RUN: nothing to end");
  const id = basename(dir);
  const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf-8"));
  const trace = readTrace(cwd, id);

  const summary: RunIndexLine = {
    id,
    graph: meta.graph,
    graph_sha256: meta.graph_sha256,
    started_at: meta.started_at,
    ended_at: now,
    status,
    node_count: trace.length,
    failures: trace.filter((t) => t.status === "fail").length,
    evidence_keys: Array.from(new Set(trace.flatMap((t) => t.evidence))).sort(),
  };

  appendFileSync(indexFile(cwd), `${JSON.stringify(summary)}\n`);
  const md = readFileSync(join(dir, "run.md"), "utf-8").replace(
    "- status: running",
    [`- status: ${status}`, `- ended_at: ${now}`, `- nodes: ${summary.node_count}`, `- failures: ${summary.failures}`].join("\n"),
  );
  writeFileSync(join(dir, "run.md"), md);
  rmSync(activeFile(cwd), { force: true });
  return summary;
}

/** Run ids present on disk, oldest first — ids are timestamp-prefixed so lexical == chronological. */
export function listRunIds(cwd: string): string[] {
  const d = runsDir(cwd);
  if (!existsSync(d)) return [];
  return readdirSync(d, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/run-ledger.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/memory/ledger.ts tests/unit/run-ledger.test.ts
git commit -m "feat(memory): run ledger core — start/node/end over .graphkit/runs"
```

---

## Task 2: `gk run` CLI surface

**Files:**
- Create: `src/cli/commands/run.ts`
- Modify: `src/index.ts`, `src/cli/command-registry.ts:18-101` (the `CLI_COMMANDS` array)
- Test: `tests/unit/run-cli.test.ts`

**Interfaces:**
- Consumes: `startRun`, `appendNode`, `endRun`, `activeRun` from Task 1.
- Produces: `registerRunCommands(cli: CAC): void`; CLI paths `run start`, `run node`, `run end`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/run-cli.test.ts
import { describe, expect, test } from "bun:test";
import { CLI_COMMANDS } from "../../src/cli/command-registry.js";
import { registerRunCommands } from "../../src/cli/commands/run.js";
import { cac } from "cac";

describe("gk run CLI", () => {
  test("registers a single `run` command with subcommand dispatch", () => {
    const cli = cac("gk");
    registerRunCommands(cli);
    expect(cli.commands.map((c) => c.name)).toContain("run");
  });

  test("command registry lists all three run subcommands", () => {
    const paths = CLI_COMMANDS.map((c) => c.path);
    expect(paths).toContain("run start");
    expect(paths).toContain("run node");
    expect(paths).toContain("run end");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/run-cli.test.ts`
Expected: FAIL — cannot resolve `../../src/cli/commands/run.js`

- [ ] **Step 3: Write the implementation**

```ts
// src/cli/commands/run.ts
import { join } from "node:path";
import type { CAC } from "cac";
import { activeRun, appendNode, endRun, startRun } from "../../memory/ledger.js";
import { subcommandsFor } from "../command-registry.js";
import { fail, ok } from "../output.js";

function errCode(e: unknown): { code: string; message: string } {
  const message = String((e as Error)?.message ?? e);
  const code = message.match(/^([A-Z_]+):/)?.[1] ?? "RUN_ERROR";
  return { code, message };
}

export function registerRunCommands(cli: CAC) {
  cli
    .command("run [subcommand] [args...]", `Run ledger commands\nSubcommands: ${subcommandsFor("run")}`)
    .option("--graph <path>", "graph.yaml path (default: ./graph.yaml)")
    .option("--status <status>", "node: ok|fail — end: merged|blocked|failed")
    .option("--wave <n>", "wave index")
    .option("--agent <agent>", "agent id")
    .option("--model <model>", "model tier")
    .option("--evidence <keys>", "comma-separated evidence keys")
    .option("--duration-ms <n>", "node duration in ms")
    .option("--notes <text>", "free-text note")
    .option("--json", "JSON output")
    .action((subcommand, args, opts) => {
      const cwd = process.cwd();
      if (!subcommand) {
        console.log(
          `gk run — run ledger commands\n\nUsage:\n  gk run <subcommand> [args...]\n\nSubcommands: ${subcommandsFor("run")}`,
        );
        return;
      }
      try {
        if (subcommand === "start") {
          console.log(JSON.stringify(ok(startRun(cwd, opts.graph ?? join(cwd, "graph.yaml")))));
          return;
        }
        if (subcommand === "node") {
          const node = Array.isArray(args) ? args[0] : args;
          if (!node) {
            console.log(JSON.stringify(fail("MISSING_ARG", "node requires a node id")));
            return;
          }
          if (opts.status !== "ok" && opts.status !== "fail") {
            console.log(JSON.stringify(fail("BAD_STATUS", "node requires --status ok|fail")));
            return;
          }
          const result = appendNode(cwd, {
            node: String(node),
            wave: opts.wave == null ? null : Number(opts.wave),
            agent: opts.agent ?? null,
            model: opts.model ?? null,
            status: opts.status,
            evidence: opts.evidence ? String(opts.evidence).split(",").map((s) => s.trim()).filter(Boolean) : [],
            duration_ms: opts.durationMs == null ? null : Number(opts.durationMs),
            notes: opts.notes ?? null,
          });
          console.log(JSON.stringify(ok(result)));
          return;
        }
        if (subcommand === "end") {
          const status = opts.status ?? "merged";
          if (!["merged", "blocked", "failed"].includes(status)) {
            console.log(JSON.stringify(fail("BAD_STATUS", "end requires --status merged|blocked|failed")));
            return;
          }
          console.log(JSON.stringify(ok(endRun(cwd, status))));
          return;
        }
        if (subcommand === "status") {
          console.log(JSON.stringify(ok({ active: activeRun(cwd) })));
          return;
        }
        console.log(
          JSON.stringify(
            fail("UNKNOWN_RUN_SUBCOMMAND", `Unknown run subcommand "${subcommand}"`, {
              available: subcommandsFor("run").split(" "),
            }),
          ),
        );
      } catch (e) {
        const { code, message } = errCode(e);
        console.log(JSON.stringify(fail(code, message)));
      }
    });
}
```

- [ ] **Step 4: Register the command and update the manifest**

In `src/index.ts`, add the import beside the other command imports and the call beside the other `register*` calls:

```ts
import { registerRunCommands } from "./cli/commands/run.js";
```

```ts
registerRunCommands(cli);
```

In `src/cli/command-registry.ts`, append to the `CLI_COMMANDS` array (before the closing `];`):

```ts
  { path: "run start", description: "Start a run and write the ledger entry", options: ["--graph <path>", "--json"] },
  { path: "run node", description: "Append a node trace line to the active run", options: ["--status <status>", "--wave <n>", "--agent <agent>", "--model <model>", "--evidence <keys>", "--duration-ms <n>", "--notes <text>", "--json"] },
  { path: "run end", description: "Finalize the active run and append to index.jsonl", options: ["--status <status>", "--json"] },
  { path: "run status", description: "Show the active run directory", options: ["--json"] },
```

- [ ] **Step 5: Run tests and the parity gate**

Run: `bun test tests/unit/run-cli.test.ts && bun run build && bun scripts/check-cli-parity.ts`
Expected: tests PASS; parity gate reports no drift. If the gate reports `cli-manifest.json` drift, regenerate it the way the repo already does (check `package.json` scripts for the manifest generation script and run it), then re-run the gate.

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands/run.ts src/index.ts src/cli/command-registry.ts cli-manifest.json tests/unit/run-cli.test.ts
git commit -m "feat(cli): gk run start|node|end|status over the run ledger"
```

---

## Task 3: HookRef wiring in `gk graph waves`

**Files:**
- Modify: `src/cli/commands/graph.ts:945-974` (the `nodeObj` builder and `payload` assembly in the `waves` branch)
- Test: `tests/unit/waves-hooks.test.ts`

**Interfaces:**
- Consumes: the existing `HookRef` schema (`src/schemas/graph.schema.ts:65-69`), already parsed into `graph.hooks` with default `{ on_node_complete: [], on_fanout_dispatch: [], on_graph_complete: [] }`.
- Produces: each wave node object gains `hooks: string[]` (the graph's `on_node_complete` commands); the payload gains `on_graph_complete: string[]`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/waves-hooks.test.ts
import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cac } from "cac";
import { registerGraphCommands } from "../../src/cli/commands/graph.js";

// Same in-process harness as waves-memory.test.ts — no subprocess, no .omp scaffolding.
function runCli(args: string[]) {
  const cli = cac("gk");
  registerGraphCommands(cli);
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  let exitCode = 0;
  const origExit = process.exit;
  process.exit = (c?: number) => {
    exitCode = c ?? 1;
  };
  try {
    cli.parse(["node", "gk", ...args], { run: true });
  } finally {
    console.log = origLog;
    process.exit = origExit;
  }
  return { stdout: logs.join("\n"), code: exitCode };
}

const GRAPH = join(tmpdir(), `gk-waves-hooks-${process.pid}-${Date.now()}.yaml`);
writeFileSync(
  GRAPH,
  `topology: diamond
apiVersion: graphkit.dev/v2
kind: Graph
metadata: { name: hooked }
hooks:
  on_node_complete: ["gk run node {node} --status ok"]
  on_graph_complete: ["gk run end --status merged"]
nodes:
  a: { agent: Code Reviewer, objective: review, depend_on: [] }
  b: { agent: Software Architect, objective: verify, depend_on: [a] }
`,
);

describe("gk graph waves hook emission", () => {
  test("waves payload carries per-node and graph-level hook commands", () => {
    const { stdout, code } = runCli(["graph", "waves", GRAPH, "--json"]);
    expect(code).toBe(0);
    const d = JSON.parse(stdout).data;
    expect(d.on_graph_complete).toEqual(["gk run end --status merged"]);
    expect(d.waves[0].nodes[0].hooks).toEqual(["gk run node {node} --status ok"]);
    expect(d.waves[1].nodes[0].hooks).toEqual(["gk run node {node} --status ok"]);
  });

  test("graph without hooks emits empty arrays", () => {
    const NO_HOOKS = join(tmpdir(), `gk-waves-nohooks-${process.pid}-${Date.now()}.yaml`);
    writeFileSync(
      NO_HOOKS,
      `topology: diamond
apiVersion: graphkit.dev/v2
kind: Graph
metadata: { name: plain }
nodes:
  a: { agent: Code Reviewer, objective: x, depend_on: [] }
`,
    );
    const { stdout, code } = runCli(["graph", "waves", NO_HOOKS, "--json"]);
    expect(code).toBe(0);
    const d = JSON.parse(stdout).data;
    expect(d.on_graph_complete).toEqual([]);
    expect(d.waves[0].nodes[0].hooks).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/waves-hooks.test.ts`
Expected: FAIL — `payload.data.waves[0].nodes[0].hooks` is `undefined`

- [ ] **Step 3: Implement — extend `nodeObj` and the payload**

In `src/cli/commands/graph.ts`, in the `waves` branch, change the `nodeObj` arrow (currently at lines 945-956) to include hooks, and add the graph-level key to `payload`:

```ts
          // HookRef commands ride the payload so /gk:execute can run them without
          // re-reading graph.yaml. on_fanout_dispatch stays declared-but-unused:
          // no consumer exists, and inventing one would be speculative.
          const nodeHooks = graph.hooks?.on_node_complete ?? [];
          const nodeObj = (id: string) => ({
            id,
            agent: nodes[id]?.agent,
            model: nodes[id]?.model || "sonnet",
            objective: nodes[id]?.objective?.trim() || "",
            tools: nodes[id]?.tools || [],
            skills: nodes[id]?.skills || [],
            refs: nodes[id]?.refs || [],
            depend_on: nodes[id]?.depend_on || [],
            loop: nodes[id]?.loop || null,
            evidence: nodes[id]?.evidence || [],
            hooks: nodeHooks,
          });
```

Then in the `payload` object literal (currently lines 967-974), add one key after `evidence_required`:

```ts
            on_graph_complete: graph.hooks?.on_graph_complete ?? [],
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/unit/waves-hooks.test.ts tests/unit/waves-memory.test.ts`
Expected: PASS — both the new hook test and the existing waves/memory test

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/graph.ts tests/unit/waves-hooks.test.ts
git commit -m "feat(graph): emit HookRef commands in the waves payload"
```

---

## Task 4: Pattern extraction

**Files:**
- Create: `src/memory/patterns.ts`
- Test: `tests/unit/patterns.test.ts`

**Interfaces:**
- Consumes: `TraceLine`, `RunIndexLine`, `readRunIndex`, `readTrace` from Task 1; `actRScore`-style decay recomputed locally (do NOT edit `src/eval/forgetting.ts`; importing from it is allowed).
- Produces:
  - `type PatternKind = "node-sequence" | "evidence-cooccurrence" | "failure-recurrence" | "graph-reuse"`
  - `interface Pattern { signature: string; kind: PatternKind; label: string; members: string[]; runs: string[]; count: number; last_seen: string; salience: number }`
  - `extractPatterns(runs: RunIndexLine[], traces: Map<string, TraceLine[]>, now?: string): Pattern[]`
  - `patternSalience(count: number, lastSeen: string, now: string): number`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/patterns.test.ts
import { describe, expect, test } from "bun:test";
import { extractPatterns, patternSalience } from "../../src/memory/patterns.js";
import type { RunIndexLine, TraceLine } from "../../src/memory/ledger.js";

const NOW = "2026-09-03T00:00:00.000Z";

function run(id: string, graph: string, sha: string, keys: string[], at = "2026-09-01T00:00:00.000Z"): RunIndexLine {
  return { id, graph, graph_sha256: sha, started_at: at, ended_at: at, status: "merged", node_count: 0, failures: 0, evidence_keys: keys };
}
function node(n: string, status: "ok" | "fail" = "ok", evidence: string[] = [], at = "2026-09-01T00:00:00.000Z"): TraceLine {
  return { at, node: n, wave: 0, agent: "a", model: "sonnet", status, evidence, duration_ms: 1, notes: null };
}

describe("pattern extraction", () => {
  test("node-sequence needs 3 runs of the same adjacent pair", () => {
    const runs = ["r1", "r2", "r3"].map((id) => run(id, "g", "sha", []));
    const traces = new Map(runs.map((r) => [r.id, [node("plan"), node("build"), node("verify")]]));
    const pats = extractPatterns(runs, traces, NOW).filter((p) => p.kind === "node-sequence");
    const labels = pats.map((p) => p.label);
    expect(labels).toContain("plan → build");
    expect(labels).toContain("plan → build → verify");
  });

  test("a pair seen in only 2 runs is not a pattern", () => {
    const runs = ["r1", "r2"].map((id) => run(id, "g", "sha", []));
    const traces = new Map(runs.map((r) => [r.id, [node("plan"), node("build")]]));
    expect(extractPatterns(runs, traces, NOW).filter((p) => p.kind === "node-sequence")).toHaveLength(0);
  });

  test("evidence keys co-produced in 3 runs become a cooccurrence pattern", () => {
    const runs = ["r1", "r2", "r3"].map((id) => run(id, "g", `sha-${id}`, ["audit", "risk"]));
    const traces = new Map(runs.map((r) => [r.id, [node("a", "ok", ["audit"]), node("b", "ok", ["risk"])]]));
    const pats = extractPatterns(runs, traces, NOW).filter((p) => p.kind === "evidence-cooccurrence");
    expect(pats.map((p) => p.label)).toEqual(["audit + risk"]);
  });

  test("same node failing twice is a failure-recurrence pattern", () => {
    const runs = ["r1", "r2"].map((id) => run(id, "g", `sha-${id}`, []));
    const traces = new Map(runs.map((r) => [r.id, [node("flaky", "fail")]]));
    const pats = extractPatterns(runs, traces, NOW).filter((p) => p.kind === "failure-recurrence");
    expect(pats[0]?.label).toBe("flaky");
    expect(pats[0]?.count).toBe(2);
  });

  test("same graph sha run 3 times is graph-reuse", () => {
    const runs = ["r1", "r2", "r3"].map((id) => run(id, "audit-pr", "same-sha", []));
    const pats = extractPatterns(runs, new Map(), NOW).filter((p) => p.kind === "graph-reuse");
    expect(pats[0]?.label).toBe("audit-pr");
    expect(pats[0]?.count).toBe(3);
  });

  test("signatures are stable across runs of the extractor", () => {
    const runs = ["r1", "r2", "r3"].map((id) => run(id, "g", "sha", []));
    const traces = new Map(runs.map((r) => [r.id, [node("plan"), node("build")]]));
    const a = extractPatterns(runs, traces, NOW).map((p) => p.signature);
    const b = extractPatterns(runs, traces, NOW).map((p) => p.signature);
    expect(a).toEqual(b);
  });

  test("salience decays with a 14-day half-life", () => {
    const fresh = patternSalience(4, NOW, NOW);
    const old = patternSalience(4, "2026-08-20T00:00:00.000Z", NOW);
    expect(fresh).toBeCloseTo(4, 5);
    expect(old).toBeLessThan(fresh);
    expect(old).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/patterns.test.ts`
Expected: FAIL — cannot resolve `../../src/memory/patterns.js`

- [ ] **Step 3: Write the implementation**

```ts
// src/memory/patterns.ts
// Deterministic pattern extraction over the run ledger. Zero model calls:
// everything here is counting, and counting is free.
import { createHash } from "node:crypto";
import type { RunIndexLine, TraceLine } from "./ledger.js";

export type PatternKind = "node-sequence" | "evidence-cooccurrence" | "failure-recurrence" | "graph-reuse";

export interface Pattern {
  signature: string;
  kind: PatternKind;
  label: string;
  members: string[];
  runs: string[];
  count: number;
  last_seen: string;
  salience: number;
}

const SEQ_MIN_RUNS = 3;
const SEQ_MIN_LEN = 2;
const SEQ_MAX_LEN = 4;
const COOCCUR_MIN_RUNS = 3;
const FAILURE_MIN = 2;
const REUSE_MIN_RUNS = 3;
const HALF_LIFE_DAYS = 14; // same constant as src/eval/forgetting.ts
const DAY_MS = 86_400_000;

/** count × exp2 recency decay. Frequent-but-stale ranks below frequent-and-recent. */
export function patternSalience(count: number, lastSeen: string, now: string): number {
  const t = Date.parse(lastSeen);
  const n = Date.parse(now);
  if (Number.isNaN(t) || Number.isNaN(n)) return count;
  const ageDays = Math.max(0, (n - t) / DAY_MS);
  return count * 0.5 ** (ageDays / HALF_LIFE_DAYS);
}

function signatureOf(kind: PatternKind, members: string[]): string {
  return createHash("sha1").update(`${kind}::${members.join("\u0000")}`).digest("hex").slice(0, 8);
}

/** Accumulator: which runs contributed, how many hits, and the newest timestamp. */
interface Acc {
  runs: Set<string>;
  count: number;
  last: string;
}

function bump(map: Map<string, Acc>, key: string, runId: string, at: string) {
  const cur = map.get(key) ?? { runs: new Set<string>(), count: 0, last: at };
  cur.runs.add(runId);
  cur.count += 1;
  if (at > cur.last) cur.last = at;
  map.set(key, cur);
}

function toPattern(kind: PatternKind, members: string[], label: string, acc: Acc, now: string): Pattern {
  return {
    signature: signatureOf(kind, members),
    kind,
    label,
    members,
    runs: Array.from(acc.runs).sort(),
    count: acc.count,
    last_seen: acc.last,
    salience: patternSalience(acc.count, acc.last, now),
  };
}

export function extractPatterns(
  runs: RunIndexLine[],
  traces: Map<string, TraceLine[]>,
  now = new Date().toISOString(),
): Pattern[] {
  const sequences = new Map<string, Acc>();
  const cooccur = new Map<string, Acc>();
  const failures = new Map<string, Acc>();
  const reuse = new Map<string, Acc>();

  for (const run of runs) {
    const trace = traces.get(run.id) ?? [];
    const at = run.ended_at || run.started_at;

    // node-sequence: contiguous n-grams of node ids, length 2..4
    const ids = trace.map((t) => t.node);
    for (let len = SEQ_MIN_LEN; len <= SEQ_MAX_LEN; len += 1) {
      for (let i = 0; i + len <= ids.length; i += 1) {
        bump(sequences, ids.slice(i, i + len).join("\u0000"), run.id, at);
      }
    }

    // evidence-cooccurrence: unordered pairs of keys produced in the same run
    const keys = Array.from(new Set(trace.flatMap((t) => t.evidence).concat(run.evidence_keys))).sort();
    for (let i = 0; i < keys.length; i += 1) {
      for (let j = i + 1; j < keys.length; j += 1) {
        bump(cooccur, `${keys[i]}\u0000${keys[j]}`, run.id, at);
      }
    }

    // failure-recurrence: a node id that failed
    for (const t of trace) if (t.status === "fail") bump(failures, t.node, run.id, t.at || at);

    // graph-reuse: identical graph content run repeatedly
    bump(reuse, `${run.graph}\u0000${run.graph_sha256}`, run.id, at);
  }

  const out: Pattern[] = [];
  for (const [key, acc] of sequences) {
    if (acc.runs.size < SEQ_MIN_RUNS) continue;
    const members = key.split("\u0000");
    out.push(toPattern("node-sequence", members, members.join(" → "), acc, now));
  }
  for (const [key, acc] of cooccur) {
    if (acc.runs.size < COOCCUR_MIN_RUNS) continue;
    const members = key.split("\u0000");
    out.push(toPattern("evidence-cooccurrence", members, members.join(" + "), acc, now));
  }
  for (const [key, acc] of failures) {
    if (acc.count < FAILURE_MIN) continue;
    out.push(toPattern("failure-recurrence", [key], key, acc, now));
  }
  for (const [key, acc] of reuse) {
    if (acc.runs.size < REUSE_MIN_RUNS) continue;
    const members = key.split("\u0000");
    out.push(toPattern("graph-reuse", members, members[0], acc, now));
  }
  return out.sort((a, b) => b.salience - a.salience || a.signature.localeCompare(b.signature));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/patterns.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add src/memory/patterns.ts tests/unit/patterns.test.ts
git commit -m "feat(memory): deterministic pattern extraction over the run ledger"
```

---

## Task 5: Link graph builder

**Files:**
- Create: `src/memory/links.ts`
- Test: `tests/unit/links.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (reads `.graphkit/memory/**.md` directly).
- Produces:
  - `interface LinkGraph { generated_at: string; links: Record<string, string[]> }`
  - `buildLinks(memDir: string, now?: string): LinkGraph`
  - `writeLinks(memDir: string, graph: LinkGraph): void`
  - `readLinks(memDir: string): LinkGraph` (returns an empty graph when missing or corrupt)
  - `neighborsOf(graph: LinkGraph, id: string): string[]`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/links.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildLinks, neighborsOf, readLinks, writeLinks } from "../../src/memory/links.js";

function mem(dir: string, file: string, fm: Record<string, string>, body: string) {
  const head = Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join("\n");
  writeFileSync(join(dir, file), `---\n${head}\n---\n${body}`);
}

describe("link graph", () => {
  let memDir: string;
  beforeEach(() => {
    memDir = join(tmpdir(), `gk-links-${process.pid}-${Date.now()}`, ".graphkit", "memory");
    mkdirSync(join(memDir, "patterns"), { recursive: true });
  });
  afterEach(() => rmSync(join(memDir, "..", ".."), { recursive: true, force: true }));

  test("authored wikilinks become bidirectional edges", () => {
    mem(memDir, "a.md", { id: "a", type: "knowledge" }, "see [[b]] for detail\n");
    mem(memDir, "b.md", { id: "b", type: "knowledge" }, "standalone\n");
    const g = buildLinks(memDir, "2026-09-03T00:00:00.000Z");
    expect(neighborsOf(g, "a")).toContain("b");
    expect(neighborsOf(g, "b")).toContain("a");
  });

  test("shared source path links two entries without any wikilink", () => {
    mem(memDir, "a.md", { id: "a", type: "knowledge", source: ".graphkit/evidence/audit.md" }, "x\n");
    mem(memDir, "b.md", { id: "b", type: "knowledge" }, "derived from `.graphkit/evidence/audit.md`\n");
    const g = buildLinks(memDir, "2026-09-03T00:00:00.000Z");
    expect(neighborsOf(g, "a")).toContain("b");
  });

  test("entries sharing nothing are not linked", () => {
    mem(memDir, "a.md", { id: "a", type: "knowledge" }, "apples\n");
    mem(memDir, "b.md", { id: "b", type: "knowledge" }, "bicycles\n");
    expect(neighborsOf(buildLinks(memDir, "2026-09-03T00:00:00.000Z"), "a")).toEqual([]);
  });

  test("subfolder entries participate in the graph", () => {
    mem(memDir, "a.md", { id: "a", type: "knowledge" }, "links to [[p1]]\n");
    mem(join(memDir, "patterns"), "p1.md", { id: "p1", type: "pattern" }, "seq\n");
    expect(neighborsOf(buildLinks(memDir, "2026-09-03T00:00:00.000Z"), "p1")).toContain("a");
  });

  test("corrupt .links.json reads as empty rather than throwing", () => {
    writeFileSync(join(memDir, ".links.json"), "{ not json");
    expect(readLinks(memDir).links).toEqual({});
  });

  test("write then read round-trips", () => {
    const g = { generated_at: "2026-09-03T00:00:00.000Z", links: { a: ["b"], b: ["a"] } };
    writeLinks(memDir, g);
    expect(readLinks(memDir)).toEqual(g);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/links.test.ts`
Expected: FAIL — cannot resolve `../../src/memory/links.js`

- [ ] **Step 3: Write the implementation**

```ts
// src/memory/links.ts
// Derived connection graph. Disposable by contract: always rebuildable from the
// memory files, never hand-edited. Authored [[wikilinks]] are canonical; shared
// entity mentions (paths, evidence keys, graph/node ids) add the rest — no model.
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface LinkGraph {
  generated_at: string;
  links: Record<string, string[]>;
}

const RESERVED = new Set(["index.md", "log.md"]);
const WIKILINK = /\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g;
// Entities worth linking on: repo-ish paths and dotted/slashed identifiers.
const ENTITY = /(?:[\w.-]+\/)+[\w.-]+/g;

interface Entry {
  id: string;
  wikilinks: string[];
  entities: Set<string>;
}

function parseEntry(path: string, fallbackId: string): Entry | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return null;
  }
  const m = raw.match(/^---\n([\s\S]*?)\n---/);
  const head = m?.[1] ?? "";
  const id = head.match(/^id:\s*(.+)$/m)?.[1]?.trim() || fallbackId;
  const body = m ? raw.slice(m[0].length) : raw;

  const wikilinks = Array.from(body.matchAll(WIKILINK), (w) => w[1].trim()).filter(Boolean);
  const entities = new Set<string>();
  const source = head.match(/^source:\s*(.+)$/m)?.[1]?.trim();
  if (source) entities.add(source);
  for (const e of `${head}\n${body}`.matchAll(ENTITY)) entities.add(e[0]);
  return { id, wikilinks, entities };
}

/** Walk the memory root plus one level of subfolders (patterns/, suggestions/). */
function collect(memDir: string): Entry[] {
  if (!existsSync(memDir)) return [];
  const out: Entry[] = [];
  for (const de of readdirSync(memDir, { withFileTypes: true })) {
    if (de.isFile() && de.name.endsWith(".md") && !RESERVED.has(de.name)) {
      const e = parseEntry(join(memDir, de.name), de.name.replace(/\.md$/, ""));
      if (e) out.push(e);
    } else if (de.isDirectory() && !de.name.startsWith(".")) {
      const sub = join(memDir, de.name);
      for (const f of readdirSync(sub, { withFileTypes: true })) {
        if (!f.isFile() || !f.name.endsWith(".md")) continue;
        const e = parseEntry(join(sub, f.name), f.name.replace(/\.md$/, ""));
        if (e) out.push(e);
      }
    }
  }
  return out;
}

export function buildLinks(memDir: string, now = new Date().toISOString()): LinkGraph {
  const entries = collect(memDir);
  const known = new Set(entries.map((e) => e.id));
  const links: Record<string, Set<string>> = {};
  const add = (a: string, b: string) => {
    if (a === b) return;
    (links[a] ??= new Set()).add(b);
    (links[b] ??= new Set()).add(a);
  };

  for (const e of entries) {
    links[e.id] ??= new Set();
    for (const target of e.wikilinks) if (known.has(target)) add(e.id, target);
  }

  // Shared entity mention → derived edge.
  const byEntity = new Map<string, string[]>();
  for (const e of entries) {
    for (const ent of e.entities) byEntity.set(ent, [...(byEntity.get(ent) ?? []), e.id]);
  }
  for (const ids of byEntity.values()) {
    if (ids.length < 2) continue;
    for (let i = 0; i < ids.length; i += 1) for (let j = i + 1; j < ids.length; j += 1) add(ids[i], ids[j]);
  }

  return {
    generated_at: now,
    links: Object.fromEntries(Object.entries(links).map(([k, v]) => [k, Array.from(v).sort()])),
  };
}

export function writeLinks(memDir: string, graph: LinkGraph): void {
  writeFileSync(join(memDir, ".links.json"), `${JSON.stringify(graph, null, 2)}\n`);
}

export function readLinks(memDir: string): LinkGraph {
  const f = join(memDir, ".links.json");
  const empty: LinkGraph = { generated_at: "", links: {} };
  if (!existsSync(f)) return empty;
  try {
    const parsed = JSON.parse(readFileSync(f, "utf-8"));
    return parsed && typeof parsed === "object" && parsed.links ? (parsed as LinkGraph) : empty;
  } catch {
    return empty; // disposable by contract — a corrupt file rebuilds, never blocks
  }
}

export function neighborsOf(graph: LinkGraph, id: string): string[] {
  return graph.links[id] ?? [];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/links.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/memory/links.ts tests/unit/links.test.ts
git commit -m "feat(memory): derived link graph over memory entries"
```

---

## Task 6: Pattern/suggestion schemas

**Files:**
- Modify: `src/schemas/memory.schema.ts` (append after `MemoryFileSchema`, before `MemoryConfig`)
- Test: `tests/unit/pattern-schema.test.ts`

**Interfaces:**
- Consumes: existing `MemoryFileSchema` (`.passthrough()`, requires `id` and `type`).
- Produces: `PatternFileSchema`, `SuggestionFileSchema`, `SUGGESTION_ACTIONS`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/pattern-schema.test.ts
import { describe, expect, test } from "bun:test";
import { PatternFileSchema, SuggestionFileSchema } from "../../src/schemas/memory.schema.js";

const BASE = {
  created_at: "2026-09-03T00:00:00.000Z",
  valid_from: "2026-09-03T00:00:00.000Z",
  salience: 3.5,
};

describe("pattern and suggestion frontmatter", () => {
  test("accepts a well-formed pattern", () => {
    const parsed = PatternFileSchema.safeParse({
      ...BASE,
      id: "pattern-1a2b3c4d",
      type: "pattern",
      kind: "node-sequence",
      label: "plan → build",
      members: ["plan", "build"],
      runs: ["r1", "r2", "r3"],
      count: 3,
      last_seen: "2026-09-02T00:00:00.000Z",
      signature: "1a2b3c4d",
    });
    expect(parsed.success).toBe(true);
  });

  test("rejects an unknown pattern kind", () => {
    const parsed = PatternFileSchema.safeParse({
      ...BASE,
      id: "p", type: "pattern", kind: "vibes", label: "x",
      members: [], runs: [], count: 1, last_seen: BASE.created_at, signature: "abcd1234",
    });
    expect(parsed.success).toBe(false);
  });

  test("accepts a suggestion and defaults status to proposed", () => {
    const parsed = SuggestionFileSchema.safeParse({
      ...BASE,
      id: "suggestion-1a2b3c4d",
      type: "suggestion",
      action: "materialize-template",
      rationale: "audit-pr ran 6 times",
      based_on: ["pattern-1a2b3c4d"],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.status).toBe("proposed");
  });

  test("rejects an unknown suggestion action", () => {
    const parsed = SuggestionFileSchema.safeParse({
      ...BASE, id: "s", type: "suggestion", action: "do-magic", rationale: "x", based_on: [],
    });
    expect(parsed.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/pattern-schema.test.ts`
Expected: FAIL — `PatternFileSchema` is not exported

- [ ] **Step 3: Implement — append to `src/schemas/memory.schema.ts`**

Insert after the `MemoryFileSchema` definition (after line 22, before `export const MemoryConfig`):

```ts
export const PATTERN_KINDS = ["node-sequence", "evidence-cooccurrence", "failure-recurrence", "graph-reuse"] as const;
export const SUGGESTION_ACTIONS = ["materialize-template", "capture-skill", "review-failure"] as const;

/** Derived pattern entries under .graphkit/memory/patterns/. */
export const PatternFileSchema = MemoryFileSchema.extend({
  type: z.literal("pattern"),
  kind: z.enum(PATTERN_KINDS),
  label: z.string().min(1),
  members: z.array(z.string()),
  runs: z.array(z.string()),
  count: z.number().int().min(1),
  last_seen: MemoryDate,
  signature: z.string().min(4),
});

/** Actionable suggestions under .graphkit/memory/suggestions/. */
export const SuggestionFileSchema = MemoryFileSchema.extend({
  type: z.literal("suggestion"),
  action: z.enum(SUGGESTION_ACTIONS),
  rationale: z.string().min(1),
  based_on: z.array(z.string()),
  status: z.enum(["proposed", "accepted", "dismissed"]).default("proposed"),
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/unit/pattern-schema.test.ts tests/unit/memory-schema.test.ts`
Expected: PASS — new schema tests plus the untouched existing memory-schema suite

- [ ] **Step 5: Commit**

```bash
git add src/schemas/memory.schema.ts tests/unit/pattern-schema.test.ts
git commit -m "feat(schema): pattern and suggestion frontmatter schemas"
```

---

## Task 7: `gk memory consolidate`

**Files:**
- Create: `src/memory/consolidate.ts`
- Modify: `src/cli/commands/memory.ts:226` (add subcommand dispatch before the `trace` branch), `src/cli/command-registry.ts`
- Test: `tests/integration/ledger-consolidate.test.ts`

**Interfaces:**
- Consumes: `readRunIndex`, `readTrace`, `listRunIds` (Task 1); `extractPatterns`, `Pattern` (Task 4); `buildLinks`, `writeLinks` (Task 5); `PatternFileSchema`, `SuggestionFileSchema` (Task 6).
- Produces:
  - `interface ConsolidateResult { runs: number; patterns: number; suggestions: number; links: number; pruned: number }`
  - `consolidate(cwd: string, now?: string): ConsolidateResult`
  - `suggestionsFor(patterns: Pattern[]): Array<{ id: string; action: string; rationale: string; based_on: string[] }>`

- [ ] **Step 1: Write the failing test**

```ts
// tests/integration/ledger-consolidate.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendNode, endRun, startRun } from "../../src/memory/ledger.js";
import { consolidate } from "../../src/memory/consolidate.js";

const GRAPH = "metadata:\n  name: demo\ntopology: diamond\n";

describe("ledger → consolidate", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = join(tmpdir(), `gk-consolidate-${process.pid}-${Date.now()}`);
    mkdirSync(join(cwd, ".graphkit", "runs"), { recursive: true });
    mkdirSync(join(cwd, ".graphkit", "memory"), { recursive: true });
    writeFileSync(join(cwd, "graph.yaml"), GRAPH);
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  function fakeRun(hour: number) {
    const at = `2026-09-0${hour}T10:00:00.000Z`;
    startRun(cwd, join(cwd, "graph.yaml"), at);
    appendNode(cwd, { node: "plan", wave: 0, agent: "software-architect", model: "opus", status: "ok", evidence: ["plan"], duration_ms: 5, notes: null }, at);
    appendNode(cwd, { node: "build", wave: 1, agent: "data-engineer", model: "sonnet", status: "ok", evidence: ["build"], duration_ms: 5, notes: null }, at);
    endRun(cwd, "merged", at);
  }

  test("three identical runs produce patterns, suggestions, links, and an index", () => {
    fakeRun(1);
    fakeRun(2);
    fakeRun(3);

    const result = consolidate(cwd, "2026-09-03T12:00:00.000Z");
    expect(result.runs).toBe(3);
    expect(result.patterns).toBeGreaterThan(0);

    const memDir = join(cwd, ".graphkit", "memory");
    const patternFiles = readdirSync(join(memDir, "patterns"));
    expect(patternFiles.length).toBe(result.patterns);
    const anyPattern = readFileSync(join(memDir, "patterns", patternFiles[0]), "utf-8");
    expect(anyPattern).toContain("type: pattern");

    expect(existsSync(join(memDir, ".links.json"))).toBe(true);
    expect(readFileSync(join(memDir, "index.md"), "utf-8")).toContain("# Memory Index");
    expect(result.suggestions).toBeGreaterThan(0);
  });

  test("consolidate is idempotent — running twice does not duplicate files", () => {
    fakeRun(1);
    fakeRun(2);
    fakeRun(3);
    const first = consolidate(cwd, "2026-09-03T12:00:00.000Z");
    const second = consolidate(cwd, "2026-09-03T12:00:00.000Z");
    expect(second.patterns).toBe(first.patterns);
    expect(readdirSync(join(cwd, ".graphkit", "memory", "patterns")).length).toBe(first.patterns);
  });

  test("zero runs is a clean no-op", () => {
    const result = consolidate(cwd, "2026-09-03T12:00:00.000Z");
    expect(result).toEqual({ runs: 0, patterns: 0, suggestions: 0, links: 0, pruned: 0 });
  });

  test("stale pattern files whose signature no longer appears are pruned", () => {
    const patternsDir = join(cwd, ".graphkit", "memory", "patterns");
    mkdirSync(patternsDir, { recursive: true });
    writeFileSync(
      join(patternsDir, "deadbeef.md"),
      "---\nid: pattern-deadbeef\ntype: pattern\nkind: node-sequence\nlabel: gone\nmembers: []\nruns: []\ncount: 1\nlast_seen: 2026-01-01T00:00:00.000Z\nsignature: deadbeef\ngenerated:\n  by: process:gk-memory-consolidate\n  at: 2026-01-01T00:00:00.000Z\n---\nstale\n",
    );
    fakeRun(1);
    fakeRun(2);
    fakeRun(3);
    const result = consolidate(cwd, "2026-09-03T12:00:00.000Z");
    expect(result.pruned).toBe(1);
    expect(existsSync(join(patternsDir, "deadbeef.md"))).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/integration/ledger-consolidate.test.ts`
Expected: FAIL — cannot resolve `../../src/memory/consolidate.js`

- [ ] **Step 3: Write the implementation**

```ts
// src/memory/consolidate.ts
// The free layer: turn the run ledger into patterns, suggestions, links, and an
// index. Pure filesystem + counting; the dream graph consumes this output rather
// than re-deriving it, which is what keeps the dream prompt cheap.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { buildLinks, writeLinks } from "./links.js";
import { listRunIds, readRunIndex, readTrace, type TraceLine } from "./ledger.js";
import { extractPatterns, type Pattern } from "./patterns.js";

export interface ConsolidateResult {
  runs: number;
  patterns: number;
  suggestions: number;
  links: number;
  pruned: number;
}

export interface SuggestionDraft {
  id: string;
  action: "materialize-template" | "capture-skill" | "review-failure";
  rationale: string;
  based_on: string[];
  salience: number;
}

const GENERATOR = "process:gk-memory-consolidate";
const INDEX_MAX_LINES = 200; // Claude Code's cap: an index nobody can read is not an index

/** One suggestion per pattern that implies an action. Deterministic, no model. */
export function suggestionsFor(patterns: Pattern[]): SuggestionDraft[] {
  const out: SuggestionDraft[] = [];
  for (const p of patterns) {
    const based = [`pattern-${p.signature}`];
    const id = `suggestion-${createHash("sha1").update(`${p.kind}:${p.signature}`).digest("hex").slice(0, 8)}`;
    if (p.kind === "graph-reuse") {
      out.push({
        id,
        action: "materialize-template",
        rationale: `Graph "${p.label}" ran ${p.count} times unchanged. Package it: \`gk template pack\`, then materialize instead of re-authoring.`,
        based_on: based,
        salience: p.salience,
      });
    } else if (p.kind === "node-sequence" && p.members.length >= 3) {
      out.push({
        id,
        action: "capture-skill",
        rationale: `The chain "${p.label}" recurred across ${p.runs.length} runs. Capture it as a skill or a template sub-graph.`,
        based_on: based,
        salience: p.salience,
      });
    } else if (p.kind === "failure-recurrence") {
      out.push({
        id,
        action: "review-failure",
        rationale: `Node "${p.label}" failed ${p.count} times across ${p.runs.length} runs. Fix the node objective or its agent binding.`,
        based_on: based,
        salience: p.salience,
      });
    }
  }
  return out;
}

function writeEntry(dir: string, file: string, frontmatter: Record<string, unknown>, body: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), `---\n${YAML.stringify(frontmatter)}---\n${body}`);
}

/** Delete generated files in `dir` whose basename is not in `keep`. Hand-written
 *  files (no `generated.by` of ours) are never touched. */
function prune(dir: string, keep: Set<string>): number {
  if (!existsSync(dir)) return 0;
  let pruned = 0;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".md") || keep.has(f)) continue;
    const raw = readFileSync(join(dir, f), "utf-8");
    if (!raw.includes(GENERATOR)) continue;
    rmSync(join(dir, f));
    pruned += 1;
  }
  return pruned;
}

export function consolidate(cwd: string, now = new Date().toISOString()): ConsolidateResult {
  const memDir = join(cwd, ".graphkit", "memory");
  mkdirSync(memDir, { recursive: true });

  const runs = readRunIndex(cwd);
  if (runs.length === 0) return { runs: 0, patterns: 0, suggestions: 0, links: 0, pruned: 0 };

  const traces = new Map<string, TraceLine[]>();
  for (const id of listRunIds(cwd)) traces.set(id, readTrace(cwd, id));

  const patterns = extractPatterns(runs, traces, now);
  const patternsDir = join(memDir, "patterns");
  const keptPatterns = new Set<string>();
  for (const p of patterns) {
    const file = `${p.signature}.md`;
    keptPatterns.add(file);
    writeEntry(
      patternsDir,
      file,
      {
        id: `pattern-${p.signature}`,
        type: "pattern",
        kind: p.kind,
        label: p.label,
        members: p.members,
        runs: p.runs,
        count: p.count,
        last_seen: p.last_seen,
        signature: p.signature,
        created_at: now,
        valid_from: now,
        salience: Number(p.salience.toFixed(4)),
        expired: false,
        tags: [p.kind],
        generated: { by: GENERATOR, at: now },
        recorded_at: now,
        status: "stable",
      },
      `${p.label}\n\nObserved in ${p.runs.length} run(s): ${p.runs.join(", ")}.\n`,
    );
  }

  const drafts = suggestionsFor(patterns);
  const suggestionsDir = join(memDir, "suggestions");
  const keptSuggestions = new Set<string>();
  for (const s of drafts) {
    const file = `${s.id}.md`;
    keptSuggestions.add(file);
    // Preserve a human's dismissal across re-consolidation.
    const existingPath = join(suggestionsDir, file);
    let status = "proposed";
    if (existsSync(existingPath)) {
      const prior = readFileSync(existingPath, "utf-8").match(/^status:\s*(\w+)$/m)?.[1];
      if (prior === "dismissed" || prior === "accepted") status = prior;
    }
    writeEntry(
      suggestionsDir,
      file,
      {
        id: s.id,
        type: "suggestion",
        action: s.action,
        rationale: s.rationale,
        based_on: s.based_on,
        status,
        created_at: now,
        valid_from: now,
        salience: Number(s.salience.toFixed(4)),
        expired: false,
        tags: [s.action],
        generated: { by: GENERATOR, at: now },
        recorded_at: now,
      },
      `${s.rationale}\n`,
    );
  }

  const pruned = prune(patternsDir, keptPatterns) + prune(suggestionsDir, keptSuggestions);

  const linkGraph = buildLinks(memDir, now);
  writeLinks(memDir, linkGraph);

  const topPatterns = patterns.slice(0, 20);
  const indexLines = [
    "# Memory Index",
    "",
    `Generated ${now} by ${GENERATOR}. Regenerate with \`gk memory consolidate\`.`,
    "",
    `- runs: ${runs.length}`,
    `- patterns: ${patterns.length}`,
    `- suggestions: ${drafts.length}`,
    `- linked entries: ${Object.keys(linkGraph.links).length}`,
    "",
    "## Top patterns",
    "",
    ...topPatterns.map((p) => `- \`${p.signature}\` (${p.kind}, ×${p.count}) ${p.label}`),
    "",
    "## Open suggestions",
    "",
    ...drafts.slice(0, 20).map((s) => `- ${s.action}: ${s.rationale}`),
    "",
  ].slice(0, INDEX_MAX_LINES);
  writeFileSync(join(memDir, "index.md"), `${indexLines.join("\n")}\n`);

  return {
    runs: runs.length,
    patterns: patterns.length,
    suggestions: drafts.length,
    links: Object.keys(linkGraph.links).length,
    pruned,
  };
}
```

- [ ] **Step 4: Wire the subcommand**

In `src/cli/commands/memory.ts`, add the import beside the others:

```ts
import { consolidate } from "../../memory/consolidate.js";
```

and add this branch immediately before the existing `if (subcommand === "trace")` block:

```ts
      if (subcommand === "consolidate") {
        console.log(JSON.stringify(ok(consolidate(process.cwd()))));
        return;
      }
```

In `src/cli/command-registry.ts`, append to `CLI_COMMANDS`:

```ts
  { path: "memory consolidate", description: "Derive patterns, suggestions, and links from the run ledger", options: ["--json"] },
```

- [ ] **Step 5: Run tests and the parity gate**

Run: `bun test tests/integration/ledger-consolidate.test.ts && bun run build && bun scripts/check-cli-parity.ts`
Expected: 4 tests PASS; parity gate clean (regenerate `cli-manifest.json` if it reports drift)

- [ ] **Step 6: Commit**

```bash
git add src/memory/consolidate.ts src/cli/commands/memory.ts src/cli/command-registry.ts cli-manifest.json tests/integration/ledger-consolidate.test.ts
git commit -m "feat(memory): gk memory consolidate — patterns, suggestions, links, index"
```

---

## Task 8: Expanded recall (root + subfolders + link neighbors)

**Deviation note vs spec §7:** the spec said `MemoryFileSchema.type` gains `pattern|suggestion`. Unnecessary — `type` is already free-form `z.string().trim().min(1)` with `.passthrough()`, and Task 6 adds strict sub-schemas instead. No edit to the base schema's type union; behavior is identical.

**Files:**
- Create: `src/memory/recall-expanded.ts`
- Modify: `src/cli/commands/memory.ts` (`touchMemory` at lines 181–208 walks root only; `recall` branch at lines 242–280)
- Test: `tests/unit/recall-expanded.test.ts`

**Interfaces:**
- Consumes: `loadMemories`, `rankByOverlap`, `applyRecallFilters`, `MemoryDoc`, `RecallHit` from `src/eval/memory-recall.ts` (IMPORT ONLY — file is frozen); `readLinks` from Task 5.
- Produces:
  - `interface ExpandedHit extends RecallHit { linked: boolean }` — `file` is the path relative to the memory root (e.g. `patterns/abc12345.md`).
  - `interface ExpandedRecall { results: ExpandedHit[]; linked: number; scanned: number }`
  - `expandedRecall(memDir: string, query: string, k?: number, now?: string): ExpandedRecall`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/recall-expanded.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expandedRecall } from "../../src/memory/recall-expanded.js";

function entry(dir: string, file: string, fm: Record<string, unknown>, body: string) {
  const head = Object.entries(fm).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("\n");
  writeFileSync(join(dir, file), `---\n${head}\n---\n${body}`);
}

describe("expanded recall", () => {
  let memDir: string;
  beforeEach(() => {
    const root = join(tmpdir(), `gk-recall-exp-${process.pid}-${Date.now()}`);
    memDir = join(root, ".graphkit", "memory");
    mkdirSync(join(memDir, "patterns"), { recursive: true });
  });
  afterEach(() => rmSync(join(memDir, "..", ".."), { recursive: true, force: true }));

  test("searches root and subfolders together, ranked across both", () => {
    entry(memDir, "auth.md", { id: "auth", type: "knowledge", salience: 0.5 }, "oauth token rotation notes\n");
    entry(memDir, "patterns/p1.md", { id: "pattern-p1", type: "pattern", salience: 1.0 }, "oauth refresh sequence seen often\n");
    const r = expandedRecall(memDir, "oauth", 5, "2026-09-03T00:00:00.000Z");
    expect(r.results.map((h) => h.id)).toEqual(["pattern-p1", "auth"]); // 2×1.0 beats 1×0.5
    expect(r.results[0].file).toBe("patterns/p1.md");
    expect(r.results.every((h) => h.linked === false)).toBe(true);
  });

  test("link neighbors fill remaining slots below direct hits", () => {
    entry(memDir, "auth.md", { id: "auth", type: "knowledge", salience: 1.0 }, "oauth token rotation\nsee [[tokens]]\n");
    entry(memDir, "tokens.md", { id: "tokens", type: "knowledge", salience: 1.0 }, "jwt signing keys — no oauth term\n");
    const r = expandedRecall(memDir, "oauth", 2, "2026-09-03T00:00:00.000Z");
    const ids = r.results.map((h) => h.id);
    expect(ids[0]).toBe("auth");
    expect(ids).toContain("tokens"); // joined via [[wikilink]], penalized
    expect(r.results.find((h) => h.id === "tokens")?.linked).toBe(true);
  });

  test("direct hits always outrank linked neighbors", () => {
    entry(memDir, "auth.md", { id: "auth", type: "knowledge", salience: 1.0 }, "oauth\nsee [[tokens]]\n");
    entry(memDir, "tokens.md", { id: "tokens", type: "knowledge", salience: 1.0 }, "oauth too, mentions tokens\n");
    const r = expandedRecall(memDir, "oauth", 2, "2026-09-03T00:00:00.000Z");
    expect(r.results.every((h) => h.linked === false)).toBe(true); // both direct: no room for linked
  });

  test("empty store returns empty", () => {
    expect(expandedRecall(memDir, "anything", 5, "2026-09-03T00:00:00.000Z").results).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/recall-expanded.test.ts`
Expected: FAIL — cannot resolve `../../src/memory/recall-expanded.js`

- [ ] **Step 3: Write the implementation**

```ts
// src/memory/recall-expanded.ts
// Recall over root + subfolders (patterns/, suggestions/), with .links.json
// neighbors joining below direct hits. Imports the frozen retriever from
// src/eval — this module only widens the doc set and joins the link graph.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  applyRecallFilters,
  loadMemories,
  rankByOverlap,
  type MemoryDoc,
  type RecallHit,
} from "../eval/memory-recall.js";
import { readLinks } from "./links.js";

export interface ExpandedHit extends RecallHit {
  linked: boolean;
}

export interface ExpandedRecall {
  results: ExpandedHit[];
  linked: number;
  scanned: number;
}

const LINK_PENALTY = 0.5; // linked-not-keyword ranks below any direct hit

/** Memory root plus one sublevel, matching the consolidate layout. */
function recallDirs(memDir: string): Array<{ dir: string; prefix: string }> {
  if (!existsSync(memDir)) return [];
  const dirs = [{ dir: memDir, prefix: "" }];
  for (const de of readdirSync(memDir, { withFileTypes: true })) {
    if (de.isDirectory() && !de.name.startsWith(".")) dirs.push({ dir: join(memDir, de.name), prefix: `${de.name}/` });
  }
  return dirs;
}

export function expandedRecall(memDir: string, query: string, k = 5, now = new Date().toISOString()): ExpandedRecall {
  const docs: MemoryDoc[] = [];
  const where = new Map<string, string>(); // id → relative file path
  for (const { dir, prefix } of recallDirs(memDir)) {
    for (const d of loadMemories(dir)) {
      docs.push(d);
      where.set(d.id, prefix + d.file);
    }
  }

  const direct = applyRecallFilters(rankByOverlap(query, docs), now) as MemoryDoc[];
  const hits: ExpandedHit[] = direct.slice(0, k).map((d) => ({ id: d.id, file: where.get(d.id) ?? d.file, salience: d.salience, linked: false }));

  // Link expansion: neighbors of direct hits fill leftover slots, penalized.
  const graph = readLinks(memDir);
  const seen = new Set(hits.map((h) => h.id));
  let linked = 0;
  // Direct hits only seed the expansion (snapshot — hits grows below).
  outer: for (const hit of [...hits]) {
    for (const n of graph.links[hit.id] ?? []) {
      if (seen.has(n)) continue;
      const doc = docs.find((d) => d.id === n);
      if (!doc) continue; // neighbor must exist as a loaded doc to be returnable
      if (hits.length >= k) break outer;
      hits.push({ id: n, file: where.get(n) ?? doc.file, salience: doc.salience * LINK_PENALTY, linked: true });
      seen.add(n);
      linked += 1;
    }
  }

  return { results: hits, linked, scanned: docs.length };
}
```

- [ ] **Step 4: Extend `touchMemory` to walk subfolders**

In `src/cli/commands/memory.ts`, replace the file-enumeration loop opening of `touchMemory` (lines 186–188) so candidates come from root + one sublevel:

```ts
  const memDir = join(cwd, ".graphkit", "memory");
  if (!existsSync(memDir)) return null;
  // Root plus one sublevel (patterns/, suggestions/) — subfolder entries must
  // get use_count reinforcement too, or decay eventually evicts every pattern.
  const candidates: Array<{ file: string; path: string }> = [];
  for (const de of readdirSync(memDir, { withFileTypes: true })) {
    if (de.isFile() && de.name.endsWith(".md")) candidates.push({ file: de.name, path: join(memDir, de.name) });
    else if (de.isDirectory() && !de.name.startsWith(".")) {
      for (const f of readdirSync(join(memDir, de.name), { withFileTypes: true })) {
        if (f.isFile() && f.name.endsWith(".md")) candidates.push({ file: f.name, path: join(memDir, de.name, f.name) });
      }
    }
  }
  for (const { file, path } of candidates) {
```

Then inside the loop: DELETE the old `const path = join(memDir, file);` line (the destructured `path` replaces it), keep `const raw = readFileSync(path, "utf-8")` and `writeFileSync(path, ...)` as they are, and keep everything else identical. The returned `file` stays the basename — ids are globally unique (`pattern-<sig>`, `suggestion-<id>`).

- [ ] **Step 5: Wire the recall subcommand to the expanded retriever**

In the `recall` branch of `registerMemoryCommands` (lines 263–268), replace:

```ts
        let results: Array<{ id: string; file: string; salience: number }> = [];
        try {
          const stats = recallWithStats(memDir, query, topk);
          results = stats.results;
          malformed = stats.malformed;
        } catch (e) {
```

with:

```ts
        let results: Array<{ id: string; file: string; salience: number; linked: boolean }> = [];
        let linked = 0;
        try {
          const stats = expandedRecall(memDir, query, topk);
          results = stats.results;
          linked = stats.linked;
        } catch (e) {
```

and add the import at the top of the file:

```ts
import { expandedRecall } from "../../memory/recall-expanded.js";
```

(`recallWithStats` may become unused in this file — remove its import if so.) Replace the `let malformed = 0;` declaration at line 255 with nothing (delete it), and change the final output line to:

```ts
        console.log(JSON.stringify(ok({ query, top_k: results.length, results, linked, recall_topk: topk })));
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun test tests/unit/recall-expanded.test.ts tests/unit/recall-topk.test.ts tests/unit/skill-recall.test.ts`
Expected: PASS — new tests plus the frozen retriever's own suite (proves the eval module was imported, not modified)

- [ ] **Step 7: Commit**

```bash
git add src/memory/recall-expanded.ts src/cli/commands/memory.ts tests/unit/recall-expanded.test.ts
git commit -m "feat(memory): recall across subfolders with link-neighbor expansion"
```

---

## Task 9: `gk suggest` — suggestion surface

**Files:**
- Create: `src/memory/suggest.ts`, `src/cli/commands/suggest.ts`
- Modify: `src/index.ts`, `src/cli/command-registry.ts`
- Test: `tests/unit/suggest.test.ts`

**Interfaces:**
- Consumes: suggestion files written by Task 7 (`suggestions/*.md` with `status`).
- Produces:
  - `interface SuggestionEntry { id: string; file: string; action: string; rationale: string; based_on: string[]; status: string; salience: number }`
  - `readSuggestions(memDir: string): SuggestionEntry[]`
  - `rankSuggestions(entries: SuggestionEntry[]): SuggestionEntry[]` — salience desc, id asc tiebreak, `proposed` first
  - `dismissSuggestion(memDir: string, id: string, now?: string): boolean`
  - `registerSuggestCommands(cli: CAC): void`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/suggest.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dismissSuggestion, rankSuggestions, readSuggestions } from "../../src/memory/suggest.js";

function suggestion(dir: string, id: string, salience: number, status = "proposed") {
  writeFileSync(
    join(dir, "suggestions", `${id}.md`),
    `---\nid: ${id}\ntype: suggestion\naction: review-failure\nrationale: "node failed 3 times"\nbased_on: [pattern-x]\nstatus: ${status}\nsalience: ${salience}\ncreated_at: 2026-09-01T00:00:00.000Z\nvalid_from: 2026-09-01T00:00:00.000Z\n---\nbody\n`,
  );
}

describe("gk suggest", () => {
  let memDir: string;
  beforeEach(() => {
    const root = join(tmpdir(), `gk-suggest-${process.pid}-${Date.now()}`);
    memDir = join(root, ".graphkit", "memory");
    mkdirSync(join(memDir, "suggestions"), { recursive: true });
  });
  afterEach(() => rmSync(join(memDir, ".."), { recursive: true, force: true }));

  test("reads and ranks by salience desc", () => {
    suggestion(memDir, "suggestion-low", 1.5);
    suggestion(memDir, "suggestion-high", 4.2);
    const ranked = rankSuggestions(readSuggestions(memDir));
    expect(ranked.map((s) => s.id)).toEqual(["suggestion-high", "suggestion-low"]);
  });

  test("dismissed suggestions rank last but are retained on disk", () => {
    suggestion(memDir, "suggestion-gone", 9.9, "dismissed");
    suggestion(memDir, "suggestion-live", 0.1);
    const ranked = rankSuggestions(readSuggestions(memDir));
    expect(ranked[0].id).toBe("suggestion-live");
    expect(ranked).toHaveLength(2);
  });

  test("dismissSuggestion flips status and preserves the body", () => {
    suggestion(memDir, "suggestion-target", 2.0);
    expect(dismissSuggestion(memDir, "suggestion-target", "2026-09-03T00:00:00.000Z")).toBe(true);
    const raw = readFileSync(join(memDir, "suggestions", "suggestion-target.md"), "utf-8");
    expect(raw).toMatch(/^status: dismissed$/m);
    expect(raw.endsWith("body\n")).toBe(true);
  });

  test("dismissSuggestion returns false for unknown id", () => {
    expect(dismissSuggestion(memDir, "suggestion-nope")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/suggest.test.ts`
Expected: FAIL — cannot resolve `../../src/memory/suggest.js`

- [ ] **Step 3: Write `src/memory/suggest.ts`**

```ts
// src/memory/suggest.ts
// Ranking + dismissal over suggestions/*.md. Consolidate owns creation and
// pruning; this module only reads and flips status — one writer per concern.
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";

export interface SuggestionEntry {
  id: string;
  file: string;
  action: string;
  rationale: string;
  based_on: string[];
  status: string;
  salience: number;
}

export function readSuggestions(memDir: string): SuggestionEntry[] {
  const dir = join(memDir, "suggestions");
  if (!existsSync(dir)) return [];
  const out: SuggestionEntry[] = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".md"))) {
    const raw = readFileSync(join(dir, f), "utf-8");
    const m = raw.match(/^---\n([\s\S]*?)\n---/);
    if (!m) continue;
    try {
      const fm = (YAML.parse(m[1]) ?? {}) as Record<string, unknown>;
      out.push({
        id: String(fm.id ?? f.replace(/\.md$/, "")),
        file: f,
        action: String(fm.action ?? ""),
        rationale: String(fm.rationale ?? ""),
        based_on: Array.isArray(fm.based_on) ? fm.based_on.map(String) : [],
        status: String(fm.status ?? "proposed"),
        salience: typeof fm.salience === "number" ? fm.salience : 0,
      });
    } catch {
      // unparseable frontmatter: skip, consolidate will prune it next pass
    }
  }
  return out;
}

export function rankSuggestions(entries: SuggestionEntry[]): SuggestionEntry[] {
  const weight = (s: SuggestionEntry) => (s.status === "proposed" ? 1 : 0);
  return [...entries].sort(
    (a, b) => weight(b) - weight(a) || b.salience - a.salience || a.id.localeCompare(b.id),
  );
}

export function dismissSuggestion(memDir: string, id: string, now = new Date().toISOString()): boolean {
  const dir = join(memDir, "suggestions");
  if (!existsSync(dir)) return false;
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".md"))) {
    const path = join(dir, f);
    const raw = readFileSync(path, "utf-8");
    const m = raw.match(/^---\n([\s\S]*?)\n---/);
    if (!m) continue;
    const fm = (YAML.parse(m[1]) ?? {}) as Record<string, unknown>;
    if (String(fm.id ?? "") !== id && f.replace(/\.md$/, "") !== id) continue;
    fm.status = "dismissed";
    fm.dismissed_at = now;
    writeFileSync(path, `---\n${YAML.stringify(fm)}---\n${raw.slice(m[0].length)}`);
    return true;
  }
  return false;
}
```

- [ ] **Step 4: Write `src/cli/commands/suggest.ts`**

```ts
// src/cli/commands/suggest.ts
import { join } from "node:path";
import type { CAC } from "cac";
import { dismissSuggestion, rankSuggestions, readSuggestions } from "../../memory/suggest.js";
import { fail, ok } from "../output.js";

export function registerSuggestCommands(cli: CAC) {
  cli
    .command("suggest", "Show ranked workflow suggestions from memory")
    .option("--dismiss <id>", "dismiss a suggestion by id")
    .option("--all", "include dismissed suggestions")
    .option("--json", "JSON output")
    .action((opts) => {
      const memDir = join(process.cwd(), ".graphkit", "memory");
      if (opts.dismiss) {
        if (dismissSuggestion(memDir, String(opts.dismiss))) {
          console.log(JSON.stringify(ok({ dismissed: String(opts.dismiss) })));
        } else {
          console.log(JSON.stringify(fail("SUGGESTION_NOT_FOUND", `No suggestion with id "${opts.dismiss}"`)));
        }
        return;
      }
      let ranked = rankSuggestions(readSuggestions(memDir));
      if (!opts.all) ranked = ranked.filter((s) => s.status === "proposed");
      if (opts.json) {
        console.log(JSON.stringify(ok({ count: ranked.length, suggestions: ranked })));
      } else if (ranked.length === 0) {
        console.log("No suggestions. Run `gk memory consolidate` after a few graph runs.");
      } else {
        for (const s of ranked) {
          console.log(`[${s.action}] ${s.id} (salience ${s.salience.toFixed(2)})\n  ${s.rationale}`);
        }
      }
    });
}
```

- [ ] **Step 5: Register — `src/index.ts` and `src/cli/command-registry.ts`**

In `src/index.ts` add the import and the `registerSuggestCommands(cli);` call beside the others. In `CLI_COMMANDS` append:

```ts
  { path: "suggest", description: "Show ranked workflow suggestions from memory", options: ["--dismiss <id>", "--all", "--json"] },
```

- [ ] **Step 6: Run tests and the parity gate**

Run: `bun test tests/unit/suggest.test.ts && bun run build && bun scripts/check-cli-parity.ts`
Expected: 4 tests PASS; parity clean (regenerate the manifest if it drifts)

- [ ] **Step 7: Commit**

```bash
git add src/memory/suggest.ts src/cli/commands/suggest.ts src/index.ts src/cli/command-registry.ts cli-manifest.json tests/unit/suggest.test.ts
git commit -m "feat(cli): gk suggest — ranked suggestions with dismissal"
```

---

## Task 10: Dream graph template + inbox directory

**Files:**
- Create: `templates/gallery/dream.gk.yaml`
- Modify: `src/cli/commands/kit.ts:148` (the mkdir list `["evidence", "reports", "memory", "runs"]`)
- Test: `tests/unit/dream-template.test.ts`

**Interfaces:**
- Consumes: GraphTemplate v1 shape (as `templates/gallery/audit-pr.gk.yaml`), `template list` auto-discovers `templates/gallery/*.gk.yaml`.
- Produces: a validated, materializable `dream` template whose `dream` node writes ONLY into `.graphkit/inbox/<timestamp>-dream/`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/dream-template.test.ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";

const GALLERY = join(import.meta.dir, "..", "..", "templates", "gallery");

describe("dream template", () => {
  const raw = readFileSync(join(GALLERY, "dream.gk.yaml"), "utf-8");
  const tpl = YAML.parse(raw);

  test("is a GraphTemplate named dream with focus/since parameters", () => {
    expect(tpl.kind).toBe("GraphTemplate");
    expect(tpl.metadata.name).toBe("dream");
    expect(tpl.parameters.focus.required).toBe(false);
    expect(tpl.parameters.since.required).toBe(false);
  });

  test("harvest and challenge are write-free; dream writes only to the inbox", () => {
    const flat = (arr: unknown[]) => arr.flatMap((c) => (typeof c === "object" && c ? Object.entries(c as Record<string, unknown>) : []));
    expect(flat(tpl.graph.nodes.harvest.constraints)).toContainEqual(["no_write", true]);
    expect(flat(tpl.graph.nodes.challenge.constraints)).toContainEqual(["no_write", true]);
    expect(flat(tpl.graph.nodes.dream.constraints ?? [])).toEqual([]);
    expect(tpl.graph.nodes.dream.objective).toContain(".graphkit/inbox");
    expect(tpl.graph.nodes.dream.objective).not.toMatch(/memory\/patterns\/|memory\/suggestions\//);
  });

  test("chain is harvest → dream → challenge with an evidence gate", () => {
    expect(tpl.graph.nodes.dream.depend_on).toEqual(["harvest"]);
    expect(tpl.graph.nodes.challenge.depend_on).toEqual(["dream"]);
    expect(tpl.graph.evidence.required_keys).toContain("dream-proposal");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/dream-template.test.ts`
Expected: FAIL — ENOENT on `templates/gallery/dream.gk.yaml`

- [ ] **Step 3: Write the template**

```yaml
# templates/gallery/dream.gk.yaml
apiVersion: graphkit.dev/v1
kind: GraphTemplate
metadata:
  name: dream
  description: Consolidate project memory — propose merges, new links, and retiments as a reviewable diff
  version: 1
parameters:
  focus:
    description: Optional theme to dream about (e.g. "release workflow"); empty = whole store
    required: false
    default: ""
  since:
    description: Optional ISO date; only consider runs/patterns after it; empty = no cutoff
    required: false
    default: ""
recommendations:
  agents:
    - memory-curator
    - agents-orchestrator
    - qa-engineer
graph:
  apiVersion: graphkit.dev/v2
  kind: Graph
  metadata:
    name: dream
    description: Consolidate project memory into a reviewable proposal
  topology: diamond
  inputs:
    focus:
      type: string
      required: false
    since:
      type: string
      required: false
  nodes:
    harvest:
      agent: agents-orchestrator
      objective: >
        Read .graphkit/runs/index.jsonl, .graphkit/memory/patterns/, and
        .graphkit/memory/suggestions/. Summarize: run count by graph, top
        patterns by salience. Focus theme: {{focus}}. Cutoff: {{since}}.
        Output a compact digest only — no writes.
      constraints:
        - no_write: true
      depend_on: []
      evidence: [dream-harvest]
    dream:
      agent: memory-curator
      objective: >
        Using the harvest digest, propose memory consolidations: mergeable or
        duplicate patterns, missing [[wikilinks]] between related entries,
        entries to retire (expire), and any new suggestion worth raising.
        WRITE SCOPE (hard contract): you may create files ONLY under
        .graphkit/inbox/<ISO-timestamp>-dream/ — a proposal.md plus a unified
        diff (diff.patch) a human applies with `git apply`. You must NEVER
        edit .graphkit/memory/ directly in this node.
      depend_on: [harvest]
      evidence: [dream-proposal]
    challenge:
      agent: qa-engineer
      objective: >
        Read the dream node's proposal under .graphkit/inbox/. Challenge every
        proposed change: is each merge justified by the pattern data? does any
        change lose information? is the diff applicable? Verdict line must be
        exactly "VERDICT: propose" or "VERDICT: reject" with reasons. No writes.
      constraints:
        - no_write: true
      depend_on: [dream]
      evidence: [dream-verdict]
  evidence:
    required_keys: [dream-proposal, dream-verdict]
```

Note on honesty: `dream`'s write scope is a prompt-level contract carried in the objective — gk has no filesystem sandbox to enforce it mechanically. The objective text is the enforcement surface, and the evidence gate (`dream-proposal`, `dream-verdict`) makes an off-scope run visible.

- [ ] **Step 4: Add the inbox dir to kit scaffolding**

In `src/cli/commands/kit.ts` line 148, extend the list:

```ts
  for (const dir of ["evidence", "reports", "memory", "runs", "inbox"]) {
```

- [ ] **Step 5: Run tests**

Run: `bun test tests/unit/dream-template.test.ts tests/unit/template-schema.test.ts tests/unit/template-materialize.test.ts tests/unit/template-commands.test.ts`
Expected: PASS — dream template valid, listed, materializable; existing template suites unaffected

- [ ] **Step 6: Commit**

```bash
git add templates/gallery/dream.gk.yaml src/cli/commands/kit.ts tests/unit/dream-template.test.ts
git commit -m "feat(templates): dream graph — propose memory consolidations as reviewable diffs"
```

---

## Task 11: End-to-end pipeline integration test

**Files:**
- Create: `tests/integration/memory-pipeline.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–9.
- Produces: proof the full loop works: ledger → consolidate → suggest → dismiss → recall.

- [ ] **Step 1: Write the test**

```ts
// tests/integration/memory-pipeline.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendNode, endRun, startRun } from "../../src/memory/ledger.js";
import { consolidate } from "../../src/memory/consolidate.js";
import { expandedRecall } from "../../src/memory/recall-expanded.js";
import { dismissSuggestion, rankSuggestions, readSuggestions } from "../../src/memory/suggest.js";

describe("memory pipeline", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = join(tmpdir(), `gk-pipeline-${process.pid}-${Date.now()}`);
    mkdirSync(join(cwd, ".graphkit", "runs"), { recursive: true });
    writeFileSync(join(cwd, "graph.yaml"), "metadata:\n  name: ci-flow\ntopology: diamond\n");
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  test("run ×3 → consolidate → suggest → dismiss → recall", () => {
    for (const day of [1, 2, 3]) {
      const at = `2026-09-0${day}T09:00:00.000Z`;
      startRun(cwd, join(cwd, "graph.yaml"), at);
      appendNode(cwd, { node: "plan", wave: 0, agent: "software-architect", model: "opus", status: "ok", evidence: ["plan"], duration_ms: 3, notes: null }, at);
      appendNode(cwd, { node: "build", wave: 1, agent: "data-engineer", model: "sonnet", status: "ok", evidence: ["build"], duration_ms: 3, notes: null }, at);
      appendNode(cwd, { node: "verify", wave: 2, agent: "qa-engineer", model: "sonnet", status: "ok", evidence: ["verify"], duration_ms: 3, notes: null }, at);
      endRun(cwd, "merged", at);
    }

    const consolidated = consolidate(cwd, "2026-09-03T12:00:00.000Z");
    expect(consolidated.runs).toBe(3);
    expect(consolidated.patterns).toBeGreaterThan(2); // at least plan→build and plan→build→verify
    expect(consolidated.suggestions).toBeGreaterThan(0); // chain ≥3 members ⇒ capture-skill

    const suggestions = rankSuggestions(readSuggestions(join(cwd, ".graphkit", "memory")));
    expect(suggestions.length).toBeGreaterThan(0);
    // capture-skill (plan→build→verify ×3) and materialize-template (same sha ×3)
    // tie on salience; don't assert order between them.
    expect(suggestions.some((s) => s.action === "capture-skill")).toBe(true);
    expect(suggestions.some((s) => s.action === "materialize-template")).toBe(true);

    expect(dismissSuggestion(join(cwd, ".graphkit", "memory"), suggestions[0].id, "2026-09-03T12:01:00.000Z")).toBe(true);
    const afterDismiss = rankSuggestions(readSuggestions(join(cwd, ".graphkit", "memory"))).filter((s) => s.status === "proposed");
    expect(afterDismiss.map((s) => s.id)).not.toContain(suggestions[0].id);
    expect(existsSync(join(cwd, ".graphkit", "memory", "suggestions", `${suggestions[0].id}.md`))).toBe(true);

    // recall finds the pattern files by content terms
    const recall = expandedRecall(join(cwd, ".graphkit", "memory"), "plan build verify", 5, "2026-09-03T12:00:00.000Z");
    expect(recall.results.length).toBeGreaterThan(0);
    expect(recall.results.some((h) => h.file.startsWith("patterns/"))).toBe(true);

    // re-consolidate must not resurrect the dismissed suggestion
    consolidate(cwd, "2026-09-03T13:00:00.000Z");
    const resurrected = readSuggestions(join(cwd, ".graphkit", "memory")).find((s) => s.id === suggestions[0].id);
    expect(resurrected?.status).toBe("dismissed");
  });
});
```

- [ ] **Step 2: Run it**

Run: `bun test tests/integration/memory-pipeline.test.ts`
Expected: PASS on the first run — this test has no new implementation; it verifies the composition. If it fails, the bug is in an earlier task; fix the task's module, not this test.

- [ ] **Step 3: Commit**

```bash
git add tests/integration/memory-pipeline.test.ts
git commit -m "test(memory): end-to-end ledger → consolidate → suggest → recall pipeline"
```

---

## Task 12: Skill updates (ledger contract + suggest surface)

**Files:**
- Modify: `.omp/skills/gk-execute/SKILL.md` (tracked repo copy)
- Modify: `kits/claude/skills/gk-run/SKILL.md` (compiled-workflow path — `.active` marker cutover)
- Modify: `gk-recall`, `gk-brainstorm`, `gk-init-graph` skills — `.omp/skills/<name>/SKILL.md` where tracked, else the kit copies
- Mirror every change to all kit copies: `kits/{claude,codex,cursor,pi}/skills/<name>/SKILL.md` (verify each kit has the counterpart with `ls`; skip missing)
- Test: none (documentation surfaces) — verification is a grep step

**Interfaces:**
- Consumes: CLI surfaces from Tasks 2, 7, 8, 9.
- Produces: skills that drive the ledger; no skill writes `.graphkit/runs/` by hand anymore.

- [ ] **Step 1: gk-execute — add the run-ledger contract**

In `.omp/skills/gk-execute/SKILL.md`, insert this section right after the `## Process` heading's Step 1 (`gk graph waves ...`):

````markdown
### Step 1b: Start the run ledger

```bash
gk run start graph.yaml --json
```

Before dispatching wave 1, start the ledger. If it fails with `RUN_ACTIVE`, a previous
run never ended — ask the user, or run `gk run status` to inspect, before proceeding.

### Recording nodes

After EVERY node dispatch returns (ok or fail), append a trace line:

```bash
gk run node <node-id> --status ok|fail --wave <wave-index> --agent <agent> --evidence <comma,keys> --duration-ms <ms>
```

A failed dispatch (ok:false) MUST be recorded with `--status fail` BEFORE stopping the
graph — the failure pattern is exactly what `gk memory consolidate` later surfaces.

If the waves payload carries `hooks: [...]` on a node, run those command strings
verbatim instead of hand-writing the equivalent `gk run node` call; `{node}` in the
string substitutes the node id.

### Ending

After the final wave (and the evidence gate): `gk run end --status merged|blocked|failed`,
then `gk memory consolidate --json`. If the payload has `on_graph_complete`, run those
commands verbatim — `gk run end` + `gk memory consolidate` are what they normally contain.
````

- [ ] **Step 2: gk-run — `.active` marker cutover**

In `kits/claude/skills/gk-run/SKILL.md`, replace step 3's marker sentence ("Create `.graphkit/runs/.active` marker file (touched, empty).") with:

```markdown
   Start the run ledger instead of a bare marker: `gk run start --json` — it creates the
   `.active` pointer AND the run directory the ledger owns. Keep writing `current.json`
   as before (the lease-enforce hook reads it).
```

and replace step 5 ("When the Workflow tool returns, remove `.graphkit/runs/.active`.") with:

```markdown
5. When the Workflow tool returns: `gk run end --status merged|failed` (removes `.active`,
   appends to `index.jsonl`), then `gk memory consolidate --json`.
```

- [ ] **Step 3: gk-recall — document the widened store**

Add to the gk-recall skill (`.omp/skills/gk-recall/SKILL.md` if tracked, else kit copies), after its recall-step list:

```markdown
## Store layout

`gk memory recall` searches the memory root AND its subfolders (`patterns/`,
`suggestions/`), then joins `.links.json` neighbors below direct hits. Patterns carry
`label`/`members` in their body — recall them by the node names they contain
(e.g. `gk memory recall "plan build verify"`). Hits are reinforced automatically
(`use_count` bump); dismissed suggestions stay recallable but `gk suggest` hides them.
```

- [ ] **Step 4: gk-brainstorm + gk-init-graph — suggest as authoring input**

Add one line to each skill's process, after its initial discovery step:

```markdown
Run `gk suggest --json` and fold relevant suggestions into the proposal: recurring
chains suggest sub-graphs, graph-reuse suggests starting from a template.
```

- [ ] **Step 5: Mirror to kit copies and verify**

Copy each edited `SKILL.md` over its counterpart in `kits/{claude,codex,cursor,pi}/skills/<name>/SKILL.md` (only where the counterpart exists).

Run: `grep -rL "gk run start" kits/*/skills/gk-execute/SKILL.md kits/claude/skills/gk-run/SKILL.md 2>/dev/null; echo done`
Expected: only `done` — every mirror carries the contract.

- [ ] **Step 6: Commit**

```bash
git add .omp/skills kits
git commit -m "docs(skills): run-ledger contract in gk-execute/gk-run; suggest input in authoring skills"
```

---

## Task 13: Docs and final gates

**Files:**
- Modify: `README.md`, `CHANGELOG.md`

- [ ] **Step 1: README — Memory + Execution sections**

Add a `## Memory` section to README (after the section covering graph execution, before any eval content):

````markdown
## Memory

gk remembers every run and improves suggestions over time — all deterministic, no model calls.

```bash
gk run start graph.yaml     # begin a run (fails if one is active)
gk run node <id> --status ok --wave 0 --agent <agent>
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
````

- [ ] **Step 2: CHANGELOG entry**

Add under a new unrealed version heading at the top of `CHANGELOG.md`:

```markdown
## 0.3.0

- Run ledger: `gk run start|node|end|status` records every execution to `.graphkit/runs/`.
- Pattern compiler: `gk memory consolidate` derives node sequences, evidence co-occurrence,
  failure recurrence, and graph reuse into `.graphkit/memory/patterns/` + `suggestions/`.
- Suggestions: `gk suggest` ranks them; `--dismiss` retains the file but hides it.
- Recall widened: searches subfolders, joins `.links.json` neighbors below direct hits.
- Dream graph template: proposes memory consolidations as reviewable diffs (`.graphkit/inbox/`).
- Waves payload carries `hooks` (on_node_complete) and `on_graph_complete` commands.
```

- [ ] **Step 3: Full gate**

Run: `bun run build && bun test && bun scripts/check-cli-parity.ts`
Expected: build clean, full suite green, parity clean. Any failure is a regression from an earlier task — fix at the source module.

- [ ] **Step 4: Commit**

```bash
git add README.md CHANGELOG.md
git commit -m "docs: memory ledger, pattern compiler, suggest, and dream graph"
```

---

## Self-Review

Covered during plan writing:
- Spec coverage: ledger (Tasks 1–3), pattern compiler (4, 6, 7), links (5), suggestions (7, 9), recall (8), dream (10), kit scaffolding (10), skills (12), docs (13). The spec's `type` enum change is intentionally dropped (Task 8 deviation note — free-form `type` already admits the new values; strict sub-schemas added instead).
- Type consistency: `Pattern` flows Task 4 → 7; `LinkGraph` Task 5 → 8; `SuggestionEntry` Task 9; ledger types Task 1 → 4 → 7. `src/eval/**` imported, never edited.
- No placeholders: every step carries full code or an exact edit.

## Execution Options

Per superpowers convention, execute via **subagent-driven-development** (recommended; each task to an isolated subagent with this plan as contract) or **inline executing-plans** (single session, task by task).
