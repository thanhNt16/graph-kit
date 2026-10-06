import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CAC, cac } from "cac";
import { registerStatusCommand } from "../../src/cli/commands/status.js";
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
  return { code, output: JSON.parse(logs.join("\n")) };
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

  test("no active run returns stable success", () => {
    const result = runCli(["status"], root, registerStatusCommand);
    expect(result.code).toBe(0);
    expect(result.output).toEqual({ status: "ok", data: { running: false, run: null, coverage: null } });
  });

  test("active run reports ledger run id, node tallies and evidence gate", () => {
    writeFileSync(
      join(root, "graph.yaml"),
      `apiVersion: graphkit.dev/v2\nkind: Graph\nmetadata:\n  name: demo\ntopology: diamond\nnodes:\n  a:\n    agent: reviewer\n    objective: test\n    depend_on: []\n    evidence: [design]\nevidence:\n  required_keys: [design]\n`,
    );
    mkdirSync(join(root, ".graphkit", "evidence"), { recursive: true });
    const start = startRun(root, join(root, "graph.yaml"));
    appendNode(root, {
      node: "a",
      wave: 0,
      agent: "reviewer",
      model: null,
      status: "ok",
      evidence: ["design"],
      duration_ms: 5,
      notes: null,
    });
    writeFileSync(join(root, ".graphkit", "evidence", "design.md"), "done\n");

    const result = runCli(["status"], root, registerStatusCommand);
    expect(result.code).toBe(0);
    expect(result.output.data.running).toBe(true);
    expect(result.output.data.run.id).toBe(start.id);
    expect(result.output.data.run.graph).toBe("demo");
    expect(result.output.data.nodes).toEqual({ ok: 1, fail: 0, skipped: 0, challenge: 0 });
    expect(result.output.data.coverage.verdict).toBe("MERGE");
  });
});
