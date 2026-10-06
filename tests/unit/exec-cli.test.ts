import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cac } from "cac";
import { registerExecCommand } from "../../src/cli/commands/exec.js";
import type { PlannedNode } from "../../src/compiler/plan.js";
import type { DispatchContext, DispatchOutcome, Runner } from "../../src/exec/types.js";
import { activeRun, isNodeLine, readTrace } from "../../src/runs/ledger.js";
import { GraphSchema } from "../../src/schemas/graph.schema.js";
import { saveSessionGraph } from "../../src/store/index.js";

// Task 4 contract: `gk exec` resolves the graph through the P0 resolver,
// plans it, and drives runGraph with a Runner seam. Child-process dispatch
// is subprocess-tested in exec-spawn.test.ts; here the Runner is canned so
// the VERB is what's under test — verdict envelope, trace lines, exit code,
// the judge-supply contract, and the worktree merge-on-land lifecycle.

const ROOT = join(import.meta.dir, "..", "..");

const okOut = (output = "done"): DispatchOutcome => ({ ok: true, output, exitCode: 0, durationMs: 5 });

class ScriptRunner implements Runner {
  calls: Array<{ id: string; ctx: DispatchContext }> = [];
  constructor(private script: (node: PlannedNode, ctx: DispatchContext, call: number) => DispatchOutcome) {}
  async dispatch(node: PlannedNode, ctx: DispatchContext): Promise<DispatchOutcome> {
    const call = this.calls.filter((c) => c.id === node.id).length + 1;
    this.calls.push({ id: node.id, ctx });
    return this.script(node, ctx, call);
  }
}

const LINEAR = `apiVersion: graphkit.dev/v2
kind: Graph
metadata:
  name: exec-test
topology: custom
nodes:
  build:
    agent: worker
    objective: build the thing
  review:
    agent: worker
    objective: review the build
    depend_on: [build]
`;

async function runCli(args: string[], cwd: string, deps: Parameters<typeof registerExecCommand>[1] = {}) {
  const cli = cac("gk");
  const reg = registerExecCommand(cli, deps); // cac doesn't await async actions
  const logs: string[] = [];
  const errs: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  const origCwd = process.cwd();
  console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => errs.push(a.map(String).join(" "));
  process.chdir(cwd);
  try {
    cli.parse(["node", "gk", ...args], { run: true });
    await reg.settle();
  } finally {
    console.log = origLog;
    console.error = origErr;
    process.chdir(origCwd);
  }
  const code = process.exitCode ? Number(process.exitCode) : 0;
  process.exitCode = 0; // fail() paths set process.exitCode=1 — reset so bun:test exits 0
  return { stdout: logs.join("\n"), stderr: errs.join("\n"), code };
}

let tmp = "";

function fresh(name: string): string {
  tmp = join(tmpdir(), `gk-exec-cli-${process.pid}-${name}-${Date.now()}`);
  mkdirSync(tmp, { recursive: true });
  mkdirSync(join(tmp, ".omp", "agents"), { recursive: true });
  writeFileSync(join(tmp, ".omp", "agents", "worker.md"), "You are worker.\n");
  return tmp;
}

function gitInit(dir: string): void {
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  writeFileSync(join(dir, ".gitignore"), ".graphkit/\n.omp/\n");
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
  writeFileSync(join(dir, "README.md"), "x\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
}

function branchExists(dir: string, branch: string): boolean {
  const r = spawnSync("git", ["rev-parse", "--verify", "--quiet", branch], { cwd: dir });
  return (r.exitCode ?? r.status) === 0; // bun's spawnSync: status, not exitCode
}

beforeEach(() => {
  tmp = "";
});
afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe("gk exec — headless runner", () => {
  test("--json: 2-node plan → merged verdict envelope, trace lines, exit 0", async () => {
    const cwd = fresh("happy");
    writeFileSync(join(cwd, "graph.yaml"), LINEAR);
    const runner = new ScriptRunner(() => okOut(`did ${"x".repeat(10)}`));
    const r = await runCli(["exec", "graph.yaml", "--json"], cwd, { runner });

    expect(r.code).toBe(0);
    const envelope = JSON.parse(r.stdout);
    expect(envelope.status).toBe("ok");
    expect(envelope.data.status).toBe("merged");
    expect(envelope.data.unresolved).toEqual([]);
    expect(envelope.data.nodes.map((n: { id: string; status: string }) => [n.id, n.status])).toEqual([
      ["build", "ok"],
      ["review", "ok"],
    ]);
    expect(envelope.data.waves.map((w: { index: number }) => w.index)).toEqual([0, 1]);
    // trace.jsonl carries the per-node lines with the run's dispatch intents
    const trace = readTrace(cwd, envelope.data.runId).filter(isNodeLine);
    expect(trace.map((l) => [l.node, l.status])).toEqual([
      ["build", "ok"],
      ["review", "ok"],
    ]);
    // run ended — no active pointer left behind
    expect(activeRun(cwd)).toBeNull();
    // progress lines live on stderr; stdout stays envelope-only
    expect(r.stderr).toContain("[exec]");
    expect(r.stderr).toContain("build");
    expect(r.stdout.trim().split("\n")).toHaveLength(1);
  });

  test("judge-dependent graph fails fast without --no-judge — nothing dispatches", async () => {
    const cwd = fresh("judge");
    writeFileSync(
      join(cwd, "graph.yaml"),
      LINEAR.replace("objective: build the thing", 'objective: build the thing\n    when: "tests pass upstream"'),
    );
    const runner = new ScriptRunner(() => okOut());
    const r = await runCli(["exec", "graph.yaml", "--json"], cwd, { runner });

    expect(r.code).toBe(1);
    const envelope = JSON.parse(r.stdout);
    expect(envelope.status).toBe("fail");
    expect(envelope.error.code).toBe("JUDGE_REQUIRED");
    expect(envelope.error.message).toContain("build");
    expect(runner.calls).toHaveLength(0); // fail BEFORE any dispatch
    expect(activeRun(cwd)).toBeNull(); // and before any run ledger state
  });

  test("--no-judge: warning on stderr, when-nodes skip with trace notes", async () => {
    const cwd = fresh("nojudge");
    writeFileSync(
      join(cwd, "graph.yaml"),
      LINEAR.replace("objective: build the thing", 'objective: build the thing\n    when: "tests pass upstream"'),
    );
    const runner = new ScriptRunner(() => okOut());
    const r = await runCli(["exec", "graph.yaml", "--json", "--no-judge"], cwd, { runner });

    expect(r.code).toBe(0);
    expect(r.stderr).toContain("--no-judge");
    const envelope = JSON.parse(r.stdout);
    expect(envelope.data.status).toBe("merged");
    const trace = readTrace(cwd, envelope.data.runId).filter(isNodeLine);
    expect(trace.map((l) => [l.node, l.status, l.notes])).toEqual([
      ["build", "skipped", "when-false"],
      ["review", "skipped", "upstream-skipped:build"],
    ]);
  });

  test("gate node: auto-skip → blocked verdict + exit 1; --yes approves", async () => {
    const cwd = fresh("gate");
    writeFileSync(
      join(cwd, "graph.yaml"),
      LINEAR.replace(
        "objective: review the build",
        'objective: review the build\n    gate:\n      question: "ship it?"',
      ),
    );
    const runner = new ScriptRunner(() => okOut());
    const no = await runCli(["exec", "graph.yaml", "--json"], cwd, { runner });
    expect(no.code).toBe(1);
    const blocked = JSON.parse(no.stdout);
    expect(blocked.data.status).toBe("blocked");
    const trace = readTrace(cwd, blocked.data.runId).filter(isNodeLine);
    expect(trace.filter((l) => l.node === "review").map((l) => [l.status, l.notes])).toEqual([
      ["skipped", "gate-auto-skipped"],
    ]);

    const yes = await runCli(["exec", "graph.yaml", "--json", "--yes"], cwd, { runner });
    expect(yes.code).toBe(0);
    const merged = JSON.parse(yes.stdout);
    expect(merged.data.status).toBe("merged");
  });

  test("unresolvable graph → NO_ACTIVE_GRAPH fail envelope", async () => {
    const cwd = fresh("nores");
    const runner = new ScriptRunner(() => okOut());
    const r = await runCli(["exec", "--json"], cwd, { runner });
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout).error.code).toBe("NO_ACTIVE_GRAPH");
    expect(runner.calls).toHaveLength(0);
  });

  test("--session resolves through the session-graph store", async () => {
    const cwd = fresh("session");
    mkdirSync(join(cwd, ".graphkit"), { recursive: true }); // assertInitialized
    const graph = GraphSchema.parse({
      apiVersion: "graphkit.dev/v2",
      kind: "Graph",
      metadata: { name: "exec-session" },
      topology: "custom",
      nodes: { solo: { agent: "worker", objective: "go" } },
    });
    const { id } = saveSessionGraph(graph, "exec-session", cwd);
    const runner = new ScriptRunner(() => okOut());
    const r = await runCli(["exec", "--session", id, "--json"], cwd, { runner });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).data.status).toBe("merged");
  });

  test("non-json mode prints a human verdict summary on stdout", async () => {
    const cwd = fresh("human");
    writeFileSync(join(cwd, "graph.yaml"), LINEAR);
    const runner = new ScriptRunner(() => okOut());
    const r = await runCli(["exec", "graph.yaml"], cwd, { runner });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("merged");
    expect(r.stdout).toContain("build");
  });

  test("top-level loops: → UNSUPPORTED_LOOPS fail fast before any dispatch", async () => {
    const cwd = fresh("loops");
    writeFileSync(
      join(cwd, "graph.yaml"),
      `apiVersion: graphkit.dev/v2
kind: Graph
metadata:
  name: loop-group
topology: custom
nodes:
  build:
    agent: worker
    objective: build the thing
loops:
  - nodes: [build]
    max_rounds: 3
    stop_when: tests pass
`,
    );
    const runner = new ScriptRunner(() => okOut());
    const r = await runCli(["exec", "graph.yaml", "--json"], cwd, { runner });
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout).error.code).toBe("UNSUPPORTED_LOOPS");
    expect(runner.calls).toHaveLength(0);
  });
});

describe("gk exec --worktree — merge-on-land", () => {
  test("write nodes get worktrees + branches, waves merge into the main tree", async () => {
    const cwd = fresh("wt-happy");
    gitInit(cwd);
    writeFileSync(
      join(cwd, "graph.yaml"),
      `apiVersion: graphkit.dev/v2
kind: Graph
metadata:
  name: wt-test
topology: custom
nodes:
  a:
    agent: worker
    objective: write a
  b:
    agent: worker
    objective: write b
  c:
    agent: worker
    objective: write c
    depend_on: [a]
  d:
    agent: worker
    objective: read only
    depend_on: [b]
    constraints:
      - no_write: true
`,
    );
    execFileSync("git", ["add", "."], { cwd });
    execFileSync("git", ["commit", "-q", "-m", "graph"], { cwd });

    const worktrees = new Map<string, string>();
    const runner = new ScriptRunner((node) => {
      const wt = worktrees.get(node.id);
      if (node.id !== "d") {
        if (!wt) throw new Error(`no worktree for write node ${node.id}`);
        writeFileSync(join(wt, `work-${node.id}.txt`), `from ${node.id}\n`);
      }
      expect(wt === undefined).toBe(node.id === "d"); // read-only node: no isolation
      return okOut();
    });
    const r = await runCli(["exec", "graph.yaml", "--json", "--worktree"], cwd, { runner, worktrees });

    expect(r.code).toBe(0);
    const envelope = JSON.parse(r.stdout);
    expect(envelope.data.status).toBe("merged");
    // every write node's work merged into the main tree
    for (const id of ["a", "b", "c"]) {
      expect(readFileSync(join(cwd, `work-${id}.txt`), "utf8")).toBe(`from ${id}\n`);
    }
    // branches kept, worktree checkouts removed
    for (const id of ["a", "b", "c"]) expect(branchExists(cwd, `gk/${id}`)).toBe(true);
    expect(existsSync(join(cwd, ".graphkit", "worktrees"))).toBe(false);
    // working tree clean after the merges
    expect(spawnSync("git", ["status", "--porcelain"], { cwd }).stdout.toString().trim()).toBe("");
  });

  test("merge conflict aborts, fails the node, stops the graph, keeps worktrees", async () => {
    const cwd = fresh("wt-conflict");
    gitInit(cwd);
    writeFileSync(
      join(cwd, "graph.yaml"),
      `apiVersion: graphkit.dev/v2
kind: Graph
metadata:
  name: wt-clash
topology: custom
nodes:
  a:
    agent: worker
    objective: write a
  b:
    agent: worker
    objective: write b
`,
    );
    execFileSync("git", ["add", "."], { cwd });
    execFileSync("git", ["commit", "-q", "-m", "graph"], { cwd });

    const worktrees = new Map<string, string>();
    const runner = new ScriptRunner((node) => {
      const wt = worktrees.get(node.id);
      if (!wt) throw new Error(`no worktree for ${node.id}`);
      // both nodes claim the same file with different content → merge conflict
      writeFileSync(join(wt, "shared.txt"), `from ${node.id}\n`);
      return okOut();
    });
    const r = await runCli(["exec", "graph.yaml", "--json", "--worktree"], cwd, { runner, worktrees });

    expect(r.code).toBe(1);
    const envelope = JSON.parse(r.stdout);
    expect(envelope.data.status).toBe("failed");
    // first branch merged clean, second conflicted
    expect(readFileSync(join(cwd, "shared.txt"), "utf8")).toBe("from a\n");
    const trace = readTrace(cwd, envelope.data.runId).filter(isNodeLine);
    expect(trace.filter((l) => l.node === "b").map((l) => [l.status, l.notes])).toEqual([
      ["fail", "merge-conflict:gk/b"],
    ]);
    // aborted merge left no merge state behind
    expect(spawnSync("git", ["rev-parse", "-q", "--verify", "MERGE_HEAD"], { cwd }).exitCode).not.toBe(0);
    // failed run keeps worktrees for debugging
    expect(readdirSync(join(cwd, ".graphkit", "worktrees")).sort()).toEqual(["a", "b"]);
    expect(branchExists(cwd, "gk/a")).toBe(true);
    expect(branchExists(cwd, "gk/b")).toBe(true);
  });

  test("non-git repo → WORKTREE_UNAVAILABLE fail fast", async () => {
    const cwd = fresh("wt-nogit");
    writeFileSync(join(cwd, "graph.yaml"), LINEAR);
    const runner = new ScriptRunner(() => okOut());
    const r = await runCli(["exec", "graph.yaml", "--json", "--worktree"], cwd, { runner });
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout).error.code).toBe("WORKTREE_UNAVAILABLE");
    expect(runner.calls).toHaveLength(0);
  });

  test("wiring: real SpawnRunner (no deps) runs the child inside its worktree", async () => {
    const cwd = fresh("wt-wiring");
    gitInit(cwd);
    writeFileSync(
      join(cwd, "graph.yaml"),
      `apiVersion: graphkit.dev/v2
kind: Graph
metadata:
  name: wt-wiring
topology: custom
nodes:
  a:
    agent: worker
    objective: report your working directory
`,
    );
    execFileSync("git", ["add", "."], { cwd });
    execFileSync("git", ["commit", "-q", "-m", "graph"], { cwd });

    // PATH stub: `omp` prints the child's cwd. No runner/worktrees deps are
    // injected — this exercises the production wiring (registerExecCommand →
    // SpawnRunner → spawnDispatch) that deps-injected tests bypass.
    const stub = join(cwd, "bin");
    mkdirSync(stub);
    writeFileSync(join(stub, "omp"), "#!/bin/sh\nexec pwd\n");
    chmodSync(join(stub, "omp"), 0o755);

    const rootPhysical = realpathSync(cwd);
    const origPath = process.env.PATH;
    process.env.PATH = `${stub}:${origPath}`;
    let r: { code: number; stdout: string; stderr: string };
    try {
      r = await runCli(["exec", "graph.yaml", "--json", "--worktree"], cwd);
    } finally {
      process.env.PATH = origPath;
    }

    expect(r.code).toBe(0);
    const envelope = JSON.parse(r.stdout);
    expect(envelope.data.status).toBe("merged");
    const pwd = envelope.data.nodes[0].outcome.output.trim();
    // C1 regression: child_cwd must reach spawnDispatch on the default path —
    // the child's pwd is INSIDE the worktree, never the repo root.
    expect(pwd).toBe(join(rootPhysical, ".graphkit", "worktrees", "a"));
    expect(pwd).not.toBe(rootPhysical);
  });
});

describe("SpawnRunner — child-process dispatch (subprocess-isolated)", () => {
  test("child_cwd runs the child in the worktree, agent fragment loads from the repo root", async () => {
    const proc = spawnSync(
      "bun",
      [
        "-e",
        `
        const { mkdtempSync, mkdirSync, writeFileSync, chmodSync } = require("node:fs");
        const { tmpdir } = require("node:os");
        const { join } = require("node:path");
        const tmp = mkdtempSync(join(tmpdir(), "gk-exec-spawn-"));
        mkdirSync(join(tmp, ".omp", "agents"), { recursive: true });
        writeFileSync(join(tmp, ".omp", "agents", "worker.md"), "You are worker.\\n");
        writeFileSync(join(tmp, ".omp", "agents", "gk-n1.md"), "You are gk-n1.\\n");
        mkdirSync(join(tmp, "wt"));
        const stub = join(tmp, "bin");
        mkdirSync(stub);
        // omp stub: print the child's working directory
        writeFileSync(join(stub, "omp"), '#!/bin/sh\\nexec pwd');
        chmodSync(join(stub, "omp"), 0o755);
        process.env.PATH = stub + ":" + process.env.PATH;
        const { SpawnRunner } = await import(process.env.GK_ROOT + "/src/cli/commands/exec.js");
        const runner = new SpawnRunner({ n1: "gk-n1" }, new Map([["n1", join(tmp, "wt")]]));
        const r = await runner.dispatch(
          { id: "n1", agent: "worker", model: "m", objective: "where am i", tools: [], skills: [], refs: [],
            advisor: null, fan_out: null, retry: null, when: null, budget_tokens: null, gate: null, role: null,
            eval: null, effort: "standard", timeout_ms: null, constraints: [], assumptions: [], owns: [],
            depend_on: [], loop: null, evidence: [], hooks: [] },
          { runId: "r1", cwd: tmp, node: null, attempt: 1, upstream: new Map() },
        );
        if (!r.ok) throw new Error("dispatch failed: " + r.output);
        const { realpathSync } = await import("node:fs");
        if (realpathSync(r.output.trim()) !== realpathSync(join(tmp, "wt")))
          throw new Error("child cwd: " + r.output + " expected " + join(tmp, "wt"));
        console.log("OK");
      `,
      ],
      {
        cwd: ROOT,
        env: { ...process.env, GK_ROOT: ROOT },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const out = proc.stdout.toString().trim();
    expect(proc.stderr.toString()).toBe("");
    expect(out).toBe("OK");
  });
});
