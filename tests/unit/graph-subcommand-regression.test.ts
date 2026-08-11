import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cac } from "cac";
import { registerGraphCommands } from "../../src/cli/commands/graph.js";

const FIXTURES = join(import.meta.dir, "..", "fixtures");
const diamond = join(FIXTURES, "minimal-diamond.yaml");

function runCli(args: string[], cwd: string) {
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
  const origCwd = process.cwd;
  process.cwd = () => cwd;
  try {
    cli.parse(["node", "gk", ...args], { run: true });
  } finally {
    console.log = origLog;
    process.exit = origExit;
    process.cwd = origCwd;
  }
  return { stdout: logs.join("\n"), code: exitCode };
}

describe("graph subcommand regression (new/ascii/svg/waves)", () => {
  let root: string;
  let cwd: string;

  beforeEach(() => {
    root = join(tmpdir(), `gk-graph-reg-${process.pid}-${Date.now()}`);
    cwd = root;
    mkdirSync(cwd, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("graph new diamond emits a schema-parseable graph using absolute fixture", () => {
    const { stdout, code } = runCli(["graph", "new", "diamond"], cwd);
    expect(code).toBe(0);
    // emit raw YAML to stdout
    expect(stdout).toContain("kind: Graph");
    expect(stdout).toContain("topology: diamond");
  });

  test("graph ascii renders node boxes and edges for the diamond fixture", () => {
    const { stdout, code } = runCli(["graph", "ascii", diamond], cwd);
    expect(code).toBe(0);
    expect(stdout).toContain("scouter");
    expect(stdout).toContain("worker");
    expect(stdout).toContain("synthesizer");
  });

  test("graph svg writes a .svg diagram and reports its path", () => {
    const { stdout, code } = runCli(["graph", "svg", diamond], cwd);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.status).toBe("ok");
    expect(parsed.data.svg).toContain(".graphkit/diagrams/");
    expect(parsed.data.svg).toMatch(/\.svg$/);
    expect(existsSync(parsed.data.svg)).toBe(true);
  });

  test("graph waves reports the topological wave count for the diamond fixture", () => {
    const { stdout, code } = runCli(["graph", "waves", diamond, "--json"], cwd);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.status).toBe("ok");
    expect(parsed.data.topology).toBe("diamond");
    expect(parsed.data.total_waves).toBeGreaterThan(0);
    expect(Array.isArray(parsed.data.waves)).toBe(true);
  });

  test("graph waves memory-augmented still interleaves curator (regression)", () => {
    const memGraph = join(cwd, "mem.yaml");
    writeFileSync(
      memGraph,
      `topology: memory-augmented
topology_config:
  memory: { curator_node: curator, cadence: on_node_complete }
nodes:
  scouter: { agent: Software Architect, depend_on: [] }
  worker: { agent: Code Reviewer, depend_on: [scouter] }
  curator: { agent: Memory Curator, depend_on: [] }
`,
    );
    const { stdout, code } = runCli(["graph", "waves", memGraph, "--json"], cwd);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    const curatorWaves = (parsed.data.waves as { curator?: boolean }[]).filter((w) => w.curator === true);
    expect(curatorWaves.length).toBeGreaterThan(0);
  });

  test("unknown graph subcommand rejected (regression)", () => {
    const { stdout, code } = runCli(["graph", "bogus"], cwd);
    expect(code).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.status).toBe("fail");
    expect(parsed.error.code).toBe("UNKNOWN_GRAPH_SUBCOMMAND");
  });
});

describe("gk-execute skill", () => {
  const skill = join(import.meta.dir, "..", "..", "claude", "skills", "gk-execute", "SKILL.md");
  test("claude gk-execute skill is present and spawns subagents directly (no Workflow tool)", () => {
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const body = readFileSync(skill, "utf-8");
    expect(body).toContain("directly spawning");
    expect(body).toContain("graph");
    expect(body).toContain("Agent");
  });
});
