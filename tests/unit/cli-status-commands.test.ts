import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerExecuteCommand } from "../../src/cli/commands/execute.js";
import { registerStatusCommand } from "../../src/cli/commands/status.js";
import { registerVisualizeCommand } from "../../src/cli/commands/visualize.js";
import { appendNode, startRun } from "../../src/memory/ledger.js";
import { createCliHarness } from "../helpers/cli-harness.js";

describe("gk status", () => {
  let root: string;
  beforeEach(() => {
    root = join(tmpdir(), `gk-status-${process.pid}-${Date.now()}`);
    mkdirSync(root, { recursive: true });
  });
  afterEach(() => {
    process.exitCode = 0;
    rmSync(root, { recursive: true, force: true });
  });

  test("no active run: --json keeps the stable ok envelope", () => {
    const result = createCliHarness(registerStatusCommand, { cwd: root }).run(["status", "--json"]);
    expect(result.exit).toBeUndefined();
    expect(JSON.parse(result.stdout)).toEqual({
      status: "ok",
      data: { running: false, run: null, coverage: null },
    });
  });

  test("no active run: default output is a human one-liner, exit 0", () => {
    const result = createCliHarness(registerStatusCommand, { cwd: root }).run(["status"]);
    expect(result.exit).toBeUndefined();
    expect(result.stdout).toBe("no active run");
  });

  test("active run: --json keeps the full envelope (run, coverage, gate_error)", () => {
    seedActiveRun(root);
    const result = createCliHarness(registerStatusCommand, { cwd: root }).run(["status", "--json"]);
    expect(result.exit).toBeUndefined();
    const parsed = JSON.parse(result.stdout);
    expect(parsed.status).toBe("ok");
    expect(parsed.data.running).toBe(true);
    expect(parsed.data.run.name).toBe("demo");
    expect(parsed.data.coverage.verdict).toBe("MERGE");
  });

  test("active run: default output is a human summary (run, round, coverage, verdict)", () => {
    seedActiveRun(root);
    const result = createCliHarness(registerStatusCommand, { cwd: root }).run(["status"]);
    expect(result.exit).toBeUndefined();
    expect(result.stdout).toContain("run: demo");
    expect(result.stdout).toContain("round:");
    expect(result.stdout).toContain("coverage: 1/1 keys ok");
    expect(result.stdout).toContain("verdict: MERGE");
  });

  // A4: the ledger is authoritative for identity — a real `gk run start` run
  // must report its run id, not the sidecar's stale "name" (was "unknown").
  test("ledger-started run reports its run id, round derived from the trace", () => {
    writeFileSync(
      join(root, "graph.yaml"),
      `apiVersion: graphkit.dev/v2\nkind: Graph\nmetadata:\n  name: demo\ntopology: diamond\nnodes:\n  a:\n    agent: reviewer\n    objective: test\n    depend_on: []\n    evidence: [design]\nevidence:\n  required_keys: [design]\n`,
    );
    mkdirSync(join(root, ".graphkit", "evidence"), { recursive: true });
    writeFileSync(join(root, ".graphkit", "evidence", "design.md"), "done\n");
    const { id } = startRun(root, join(root, "graph.yaml"));
    appendNode(root, {
      node: "a",
      wave: 2,
      agent: "reviewer",
      model: null,
      status: "ok",
      evidence: ["design"],
      duration_ms: null,
      notes: null,
    });
    const result = createCliHarness(registerStatusCommand, { cwd: root }).run(["status"]);
    expect(result.exit).toBeUndefined();
    expect(result.stdout).toContain(`run: ${id}`);
    expect(result.stdout).toContain("round: 3"); // highest wave + 1
    expect(result.stdout).toContain("verdict: MERGE");
  });
});

function seedActiveRun(root: string) {
  mkdirSync(join(root, ".graphkit", "runs"), { recursive: true });
  mkdirSync(join(root, ".graphkit", "evidence"), { recursive: true });
  writeFileSync(join(root, ".graphkit", "runs", ".active"), "");
  writeFileSync(join(root, ".graphkit", "runs", "current.json"), JSON.stringify({ name: "demo", started_at: "now" }));
  writeFileSync(
    join(root, "graph.yaml"),
    `apiVersion: graphkit.dev/v2\nkind: Graph\nmetadata:\n  name: demo\ntopology: diamond\nnodes:\n  a:\n    agent: reviewer\n    objective: test\n    depend_on: []\n    evidence: [design]\nevidence:\n  required_keys: [design]\n`,
  );
  writeFileSync(join(root, ".graphkit", "evidence", "design.md"), "done\n");
}

describe("gk execute/visualize stubs", () => {
  let root: string;
  beforeEach(() => {
    root = join(tmpdir(), `gk-stubs-${process.pid}-${Date.now()}`);
    mkdirSync(root, { recursive: true });
  });
  afterEach(() => {
    process.exitCode = 0;
    rmSync(root, { recursive: true, force: true });
  });
  test("execute exits 1 with NOT_IMPLEMENTED", () => {
    const result = createCliHarness(registerExecuteCommand, { cwd: root }).run(["execute"]);
    expect(result.exit).toBe(1);
    expect(JSON.parse(result.stdout).error.code).toBe("NOT_IMPLEMENTED");
  });
  test("visualize exits 1 with NOT_IMPLEMENTED", () => {
    const result = createCliHarness(registerVisualizeCommand, { cwd: root }).run(["visualize"]);
    expect(result.exit).toBe(1);
    expect(JSON.parse(result.stdout).error.code).toBe("NOT_IMPLEMENTED");
  });
});

// Round 4: coverage scores the ACTIVE RUN's recorded graph, not the parent.
describe("gk status coverage source (round 4)", () => {
  let root: string;
  beforeEach(() => {
    root = join(tmpdir(), `gk-status-r4-${process.pid}-${Date.now()}`);
    mkdirSync(root, { recursive: true });
  });
  afterEach(() => {
    process.exitCode = 0;
    rmSync(root, { recursive: true, force: true });
  });

  test("resumed run scores against the derived session graph (meta.graph_path)", () => {
    // Parent graph requires [design, extra]; the session graph (what the run
    // executes, required_keys shrunk to pending) requires only [design]. The
    // old cwd/graph.yaml scoring reported a permanent missing-key BLOCK the
    // resumed run could never clear.
    writeFileSync(
      join(root, "graph.yaml"),
      `apiVersion: graphkit.dev/v2\nkind: Graph\nmetadata:\n  name: parent\ntopology: diamond\nnodes:\n  a:\n    agent: reviewer\n    objective: test\n    depend_on: []\n    evidence: [design, extra]\nevidence:\n  required_keys: [design, extra]\n`,
    );
    const sessionPath = join(root, "session.yaml");
    writeFileSync(
      sessionPath,
      `apiVersion: graphkit.dev/v2\nkind: Graph\nmetadata:\n  name: parent-resume\ntopology: diamond\nnodes:\n  a:\n    agent: reviewer\n    objective: test\n    depend_on: []\n    evidence: [design]\nevidence:\n  required_keys: [design]\n`,
    );
    mkdirSync(join(root, ".graphkit", "evidence"), { recursive: true });
    writeFileSync(join(root, ".graphkit", "evidence", "design.md"), "done\n");
    startRun(root, sessionPath); // records graph_path = session.yaml in meta.json

    const result = createCliHarness(registerStatusCommand, { cwd: root }).run(["status", "--json"]);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.data.running).toBe(true);
    expect(parsed.data.coverage.verdict).toBe("MERGE"); // was BLOCK (missing extra) before
    expect(Object.keys(parsed.data.coverage.scorecard)).toEqual(["design"]);
  });
});
