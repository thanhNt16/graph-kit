import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cac } from "cac";
import { gateGraph, registerGateCommand } from "../../src/cli/commands/gate.js";

function scaffoldProject(dir: string) {
  mkdirSync(join(dir, ".omp", "agents"), { recursive: true });
  writeFileSync(join(dir, ".omp", "agents", "software-architect.md"), "# SA\n");
  writeFileSync(join(dir, ".omp", "agents", "code-reviewer.md"), "# CR\n");
}

function runCli(args: string[], cwd: string) {
  const origCwd = process.cwd();
  process.chdir(cwd);
  const cli = cac("gk");
  registerGateCommand(cli);
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  let exitCode = 0;
  let code = 0;
  const origExit = process.exit;
  process.exit = (c?: number) => {
    exitCode = c ?? 1;
  };
  let error: Error | undefined;
  try {
    cli.parse(["node", "gk", ...args], { run: true });
  } catch (e) {
    error = e as Error;
  } finally {
    console.log = origLog;
    process.exit = origExit;
    process.chdir(origCwd);
    code = exitCode || ((process.exitCode as number | undefined) ?? 0);
    process.exitCode = 0; // emit-fail sets exitCode=1; reset so later tests start clean
  }
  return { stdout: logs.join("\n"), code, error };
}

const MINIMAL_GRAPH = `apiVersion: graphkit.dev/v2
kind: Graph
metadata:
  name: test-gate
topology: diamond
nodes:
  scouter:
    agent: software-architect
    objective: test
    depend_on: []
    evidence: [design]
evidence:
  required_keys: [design]
`;

describe("gateGraph", () => {
  let evDir: string;

  beforeEach(() => {
    evDir = join(tmpdir(), `gk-gate-graph-${process.pid}-${Date.now()}`);
    mkdirSync(evDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(evDir, { recursive: true, force: true });
  });

  test("all keys present and non-empty → MERGE with manifest", () => {
    writeFileSync(join(evDir, "design.md"), "approved\n");
    const result = gateGraph(["design"], evDir);
    expect(result.verdict).toBe("MERGE");
    expect(result.manifest.design.bytes).toBe(Buffer.byteLength("approved\n"));
    expect(result.manifest.design.sha256).toBe(createHash("sha256").update("approved\n").digest("hex"));
  });

  test("missing key → BLOCK lists missing", () => {
    const result = gateGraph(["missing"], evDir);
    expect(result.verdict).toBe("BLOCK");
    expect(result.missing).toEqual(["missing"]);
  });

  test("empty content → BLOCK lists empty", () => {
    writeFileSync(join(evDir, "empty.md"), " \n");
    const result = gateGraph(["empty"], evDir);
    expect(result.verdict).toBe("BLOCK");
    expect(result.missing).toEqual(["empty"]);
  });

  test("mixed: one present, one missing → BLOCK", () => {
    writeFileSync(join(evDir, "design.md"), "approved\n");
    const result = gateGraph(["design", "missing"], evDir);
    expect(result.verdict).toBe("BLOCK");
    expect(result.missing).toEqual(["missing"]);
    expect(result.manifest.design.sha256).toBeTruthy();
    expect(result.manifest.missing).toBeUndefined();
  });
});

describe("gk gate command", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = join(tmpdir(), `gk-gate-cmd-${process.pid}-${Date.now()}`);
    mkdirSync(tmp, { recursive: true });
    scaffoldProject(tmp);
  });

  afterEach(() => {
    process.exitCode = 0;
    rmSync(tmp, { recursive: true, force: true });
  });

  test("MERGE: exits 0 with ok envelope", () => {
    writeFileSync(join(tmp, "graph.yaml"), MINIMAL_GRAPH);
    const evDir = join(tmp, ".graphkit", "evidence");
    mkdirSync(evDir, { recursive: true });
    writeFileSync(join(evDir, "design.md"), "approved\n");
    const result = runCli(["gate", join(tmp, "graph.yaml")], tmp);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.status).toBe("ok");
    expect(parsed.data.verdict).toBe("MERGE");
    expect(parsed.data.scorecard).toEqual({ design: "ok" });
  });

  test("BLOCK: exits 1 with GATE_BLOCK fail envelope", () => {
    writeFileSync(join(tmp, "graph.yaml"), MINIMAL_GRAPH);
    // No evidence file created
    const result = runCli(["gate", join(tmp, "graph.yaml")], tmp);
    expect(result.code).toBe(1);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.status).toBe("fail");
    expect(parsed.error.code).toBe("GATE_BLOCK");
    expect(parsed.error.details.missing).toContain("design");
  });

  test("require_landed flows from graph schema; payload carries warnings/unlanded", () => {
    writeFileSync(
      join(tmp, "graph.yaml"),
      MINIMAL_GRAPH.replace("required_keys: [design]", "required_keys: [design]\n  require_landed: true"),
    );
    const evDir = join(tmp, ".graphkit", "evidence");
    mkdirSync(evDir, { recursive: true });
    writeFileSync(join(evDir, "design.md"), "approved\n");
    const runs = join(tmp, ".graphkit", "runs");
    mkdirSync(join(runs, "run-1"), { recursive: true });
    writeFileSync(
      join(runs, "run-1", "trace.jsonl"),
      `${JSON.stringify({ at: "t0", node: "build", model: null, status: "ok", evidence: ["design"], duration_ms: 1, notes: null })}\n`,
    );
    writeFileSync(
      join(runs, "index.jsonl"),
      `${JSON.stringify({ id: "run-1", graph: "graph.yaml", graph_sha256: "x", started_at: "t0", ended_at: "t1", status: "blocked", node_count: 1, failures: 0, evidence_keys: ["design"] })}\n`,
    );
    const result = runCli(["gate", join(tmp, "graph.yaml")], tmp);
    expect(result.code).toBe(1);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.error.code).toBe("GATE_BLOCK");
    expect(parsed.error.details.unlanded).toEqual(["build"]);
    expect(parsed.error.details.warnings).toEqual([]);
  });

  test("default file is graph.yaml in cwd", () => {
    writeFileSync(join(tmp, "graph.yaml"), MINIMAL_GRAPH);
    const evDir = join(tmp, ".graphkit", "evidence");
    mkdirSync(evDir, { recursive: true });
    writeFileSync(join(evDir, "design.md"), "approved\n");
    const result = runCli(["gate"], tmp);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.status).toBe("ok");
    expect(parsed.data.verdict).toBe("MERGE");
  });

  test("schema invalid graph exits 1", () => {
    writeFileSync(join(tmp, "graph.yaml"), "");
    const result = runCli(["gate", join(tmp, "graph.yaml")], tmp);
    expect(result.code).toBe(1);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.status).toBe("fail");
    expect(parsed.error.code).toBe("SCHEMA_INVALID");
  });

  test("--json flag is accepted but does not change output", () => {
    writeFileSync(join(tmp, "graph.yaml"), MINIMAL_GRAPH);
    const evDir = join(tmp, ".graphkit", "evidence");
    mkdirSync(evDir, { recursive: true });
    writeFileSync(join(evDir, "design.md"), "approved\n");
    const result = runCli(["gate", "--json", join(tmp, "graph.yaml")], tmp);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.status).toBe("ok");
    expect(parsed.data.verdict).toBe("MERGE");
  });
});
