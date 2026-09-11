import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerGraphCommands } from "../../src/cli/commands/graph.js";
import { createCliHarness } from "../helpers/cli-harness.js";

const FIXTURES = join(import.meta.dir, "..", "fixtures");
const diamond = join(FIXTURES, "minimal-diamond.yaml");

describe("graph subcommand regression (new/ascii/svg/waves)", () => {
  let root: string;
  let cwd: string;

  beforeEach(() => {
    root = join(tmpdir(), `gk-graph-reg-${process.pid}-${Date.now()}`);
    cwd = root;
    mkdirSync(cwd, { recursive: true });
  });

  afterEach(() => {
    process.exitCode = 0; // fail() sets process.exitCode=1 — reset so bun:test exits 0
    rmSync(root, { recursive: true, force: true });
  });

  test("graph new diamond emits a schema-parseable graph using absolute fixture", () => {
    const run = createCliHarness(registerGraphCommands, { cwd }).run(["graph", "new", "diamond"]);
    expect(run.exit).toBeUndefined();
    // emit raw YAML to stdout
    expect(run.stdout).toContain("kind: Graph");
    expect(run.stdout).toContain("topology: diamond");
  });

  test("graph ascii renders node boxes and edges for the diamond fixture", () => {
    const run = createCliHarness(registerGraphCommands, { cwd }).run(["graph", "ascii", diamond]);
    expect(run.exit).toBeUndefined();
    expect(run.stdout).toContain("scouter");
    expect(run.stdout).toContain("worker");
    expect(run.stdout).toContain("synthesizer");
  });

  test("graph svg writes a .svg diagram and reports its path", () => {
    const run = createCliHarness(registerGraphCommands, { cwd }).run(["graph", "svg", diamond]);
    expect(run.exit).toBeUndefined();
    const parsed = JSON.parse(run.stdout);
    expect(parsed.status).toBe("ok");
    expect(parsed.data.svg).toContain(".graphkit/diagrams/");
    expect(parsed.data.svg).toMatch(/\.svg$/);
    expect(existsSync(parsed.data.svg)).toBe(true);
  });

  test("graph waves reports the topological wave count for the diamond fixture", () => {
    const run = createCliHarness(registerGraphCommands, { cwd }).run(["graph", "waves", diamond, "--json"]);
    expect(run.exit).toBeUndefined();
    const parsed = JSON.parse(run.stdout);
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
apiVersion: graphkit.dev/v2
kind: Graph
metadata: { name: memory-test }
topology_config:
  inner: { template: custom }
  memory: { curator_node: curator, cadence: on_node_complete }
nodes:
  scouter: { agent: Software Architect, objective: test, depend_on: [] }
  worker: { agent: Code Reviewer, objective: test, depend_on: [scouter] }
  curator: { agent: Memory Curator, objective: test, depend_on: [] }
`,
    );
    const run = createCliHarness(registerGraphCommands, { cwd }).run(["graph", "waves", memGraph, "--json"]);
    expect(run.exit).toBeUndefined();
    const parsed = JSON.parse(run.stdout);
    const curatorWaves = (parsed.data.waves as { curator?: boolean }[]).filter((w) => w.curator === true);
    expect(curatorWaves.length).toBeGreaterThan(0);
  });

  test("unknown graph subcommand rejected (regression)", () => {
    const run = createCliHarness(registerGraphCommands, { cwd }).run(["graph", "bogus"]);
    expect(run.exit).toBe(1);
    const parsed = JSON.parse(run.stdout);
    expect(parsed.status).toBe("fail");
    expect(parsed.error.code).toBe("UNKNOWN_GRAPH_SUBCOMMAND");
  });
});

describe("gk-execute skill", () => {
  const skill = join(import.meta.dir, "..", "..", "kits", "claude", "skills", "gk-execute", "SKILL.md");
  test("claude gk-execute skill is present and spawns subagents directly (no Workflow tool)", () => {
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const body = readFileSync(skill, "utf-8");
    expect(body).toContain("directly spawning");
    expect(body).toContain("graph");
    expect(body).toContain("Agent");
  });
});
