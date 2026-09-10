import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CAC, cac } from "cac";
import { registerExecuteCommand } from "../../src/cli/commands/execute.js";
import { registerStatusCommand } from "../../src/cli/commands/status.js";
import { registerVisualizeCommand } from "../../src/cli/commands/visualize.js";
import { appendNode, startRun } from "../../src/memory/ledger.js";

function runCli(args: string[], cwd: string, register: (cli: CAC) => void) {
  const cli = cac("gk");
  register(cli);
  const logs: string[] = [];
  const origLog = console.log;
  const origExit = process.exit;
  const origCwd = process.cwd;
  let code = 0;
  console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  process.exit = (c?: number) => {
    code = c ?? 1;
  };
  process.cwd = () => cwd;
  try {
    cli.parse(["node", "gk", ...args], { run: true });
  } finally {
    console.log = origLog;
    process.exit = origExit;
    process.cwd = origCwd;
  }
  return { code, output: logs.join("\n") };
}

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
    const result = runCli(["status", "--json"], root, registerStatusCommand);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.output)).toEqual({
      status: "ok",
      data: { running: false, run: null, coverage: null },
    });
  });

  test("no active run: default output is a human one-liner, exit 0", () => {
    const result = runCli(["status"], root, registerStatusCommand);
    expect(result.code).toBe(0);
    expect(result.output).toBe("no active run");
  });

  test("active run: --json keeps the full envelope (run, coverage, gate_error)", () => {
    seedActiveRun(root);
    const result = runCli(["status", "--json"], root, registerStatusCommand);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.output);
    expect(parsed.status).toBe("ok");
    expect(parsed.data.running).toBe(true);
    expect(parsed.data.run.name).toBe("demo");
    expect(parsed.data.coverage.verdict).toBe("MERGE");
  });

  test("active run: default output is a human summary (run, round, coverage, verdict)", () => {
    seedActiveRun(root);
    const result = runCli(["status"], root, registerStatusCommand);
    expect(result.code).toBe(0);
    expect(result.output).toContain("run: demo");
    expect(result.output).toContain("round:");
    expect(result.output).toContain("coverage: 1/1 keys ok");
    expect(result.output).toContain("verdict: MERGE");
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
    const result = runCli(["status"], root, registerStatusCommand);
    expect(result.code).toBe(0);
    expect(result.output).toContain(`run: ${id}`);
    expect(result.output).toContain("round: 3"); // highest wave + 1
    expect(result.output).toContain("verdict: MERGE");
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
    const result = runCli(["execute"], root, registerExecuteCommand);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.output).error.code).toBe("NOT_IMPLEMENTED");
  });
  test("visualize exits 1 with NOT_IMPLEMENTED", () => {
    const result = runCli(["visualize"], root, registerVisualizeCommand);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.output).error.code).toBe("NOT_IMPLEMENTED");
  });
});
