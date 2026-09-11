import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gateGraph, registerGateCommand } from "../../src/cli/commands/gate.js";
import { createCliHarness } from "../helpers/cli-harness.js";

function scaffoldProject(dir: string) {
  mkdirSync(join(dir, ".omp", "agents"), { recursive: true });
  writeFileSync(join(dir, ".omp", "agents", "software-architect.md"), "# SA\n");
  writeFileSync(join(dir, ".omp", "agents", "code-reviewer.md"), "# CR\n");
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

  test("MERGE default output is human: VERDICT line + per-key table, no JSON", () => {
    writeFileSync(join(tmp, "graph.yaml"), MINIMAL_GRAPH);
    const evDir = join(tmp, ".graphkit", "evidence");
    mkdirSync(evDir, { recursive: true });
    writeFileSync(join(evDir, "design.md"), "approved\n");
    const result = createCliHarness(registerGateCommand, { cwd: tmp }).run(["gate", join(tmp, "graph.yaml")]);
    expect(result.exit).toBeUndefined();
    expect(() => JSON.parse(result.stdout)).toThrow(); // human mode is not JSON
    expect(result.stdout).toContain("VERDICT: PASS");
    expect(result.stdout).toContain("key");
    expect(result.stdout).toContain("design");
    expect(result.stdout).toMatch(/design\s+ok\s+unknown/); // state + freshness columns
    expect(result.stdout).not.toContain("sha256"); // manifest is machine-only
  });

  test("gate --json keeps the ok envelope (verdict, scorecard, sha256 manifest)", () => {
    writeFileSync(join(tmp, "graph.yaml"), MINIMAL_GRAPH);
    const evDir = join(tmp, ".graphkit", "evidence");
    mkdirSync(evDir, { recursive: true });
    writeFileSync(join(evDir, "design.md"), "approved\n");
    const result = createCliHarness(registerGateCommand, { cwd: tmp }).run(["gate", "--json", join(tmp, "graph.yaml")]);
    expect(result.exit).toBeUndefined();
    const parsed = JSON.parse(result.stdout);
    expect(parsed.status).toBe("ok");
    expect(parsed.data.verdict).toBe("MERGE");
    expect(parsed.data.scorecard).toEqual({ design: "ok" });
    expect(parsed.data.manifest.design.sha256).toBe(createHash("sha256").update("approved\n").digest("hex"));
  });

  test("BLOCK default mode: human verdict table + repair hint, exit 1", () => {
    writeFileSync(join(tmp, "graph.yaml"), MINIMAL_GRAPH);
    // No evidence file created
    const result = createCliHarness(registerGateCommand, { cwd: tmp }).run(["gate", join(tmp, "graph.yaml")]);
    expect(result.exit).toBe(1);
    expect(result.stdout).toContain("VERDICT: BLOCK");
    expect(result.stdout).toContain("design");
    expect(result.stdout).toContain("Missing: design");
    expect(result.stdout).toContain(".graphkit/evidence/"); // repair path names the dir
    expect(result.stdout).not.toContain("sha256"); // manifest stays machine-only
  });

  test("BLOCK --json keeps the GATE_BLOCK fail envelope for scripts", () => {
    writeFileSync(join(tmp, "graph.yaml"), MINIMAL_GRAPH);
    const result = createCliHarness(registerGateCommand, { cwd: tmp }).run(["gate", "--json", join(tmp, "graph.yaml")]);
    expect(result.exit).toBe(1);
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
    const result = createCliHarness(registerGateCommand, { cwd: tmp }).run(["gate"]);
    expect(result.exit).toBeUndefined();
    expect(result.stdout).toContain("VERDICT: PASS");
  });

  test("schema invalid graph exits 1", () => {
    writeFileSync(join(tmp, "graph.yaml"), "");
    const result = createCliHarness(registerGateCommand, { cwd: tmp }).run(["gate", join(tmp, "graph.yaml")]);
    expect(result.exit).toBe(1);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.status).toBe("fail");
    expect(parsed.error.code).toBe("SCHEMA_INVALID");
  });
});
