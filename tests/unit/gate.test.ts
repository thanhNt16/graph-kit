import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
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
  const origExit = process.exit;
  process.exit = (c?: number) => { exitCode = c ?? 1; };
  let error: Error | undefined;
  try {
    cli.parse(["node", "gk", ...args], { run: true });
  } catch (e) {
    error = e as Error;
  } finally {
    console.log = origLog;
    process.exit = origExit;
    process.chdir(origCwd);
  }
  return { stdout: logs.join("\n"), code: exitCode, error };
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
    expect(result.manifest.design.sha256).toBe(
      createHash("sha256").update("approved\n").digest("hex"),
    );
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