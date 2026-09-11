// tests/unit/waves-hooks.test.ts
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerGraphCommands } from "../../src/cli/commands/graph.js";
import { createCliHarness } from "../helpers/cli-harness.js";

// Fixture graphs used to land as loose .yaml files directly in the global
// tmpdir() and were never cleaned up — pin them under one unique dir and
// remove it when the file finishes.
let fixtureDir: string;
let GRAPH: string;

beforeAll(() => {
  fixtureDir = join(tmpdir(), `gk-waves-hooks-${process.pid}-${Date.now()}`);
  mkdirSync(fixtureDir, { recursive: true });
  GRAPH = join(fixtureDir, "hooked.yaml");
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
});

afterAll(() => {
  process.exitCode = 0; // fail() sets process.exitCode=1 — reset so bun:test exits 0
  rmSync(fixtureDir, { recursive: true, force: true });
});

afterEach(() => {
  process.exitCode = 0;
});

describe("gk graph waves hook emission", () => {
  test("waves payload carries per-node and graph-level hook commands", () => {
    const run = createCliHarness(registerGraphCommands).run(["graph", "waves", GRAPH, "--json"]);
    expect(run.exit).toBeUndefined();
    const d = JSON.parse(run.stdout).data;
    expect(d.on_graph_complete).toEqual(["gk run end --status merged"]);
    expect(d.waves[0].nodes[0].hooks).toEqual(["gk run node {node} --status ok"]);
    expect(d.waves[1].nodes[0].hooks).toEqual(["gk run node {node} --status ok"]);
  });
  test("graph without hooks emits empty arrays", () => {
    const graph = join(fixtureDir, "no-hooks.yaml");
    writeFileSync(
      graph,
      `topology: diamond\napiVersion: graphkit.dev/v2\nkind: Graph\nmetadata: { name: plain }\nnodes:\n  a: { agent: Code Reviewer, objective: x, depend_on: [] }\n`,
    );
    const run = createCliHarness(registerGraphCommands).run(["graph", "waves", graph, "--json"]);
    expect(run.exit).toBeUndefined();
    const d = JSON.parse(run.stdout).data;
    expect(d.on_graph_complete).toEqual([]);
    expect(d.waves[0].nodes[0].hooks).toEqual([]);
  });
  test("waves payload carries advisor and fan_out verbatim", () => {
    const graph = join(fixtureDir, "advisor.yaml");
    writeFileSync(
      graph,
      [
        "apiVersion: graphkit.dev/v2",
        "kind: Graph",
        "metadata:",
        "  name: orch",
        "topology: diamond",
        "nodes:",
        "  plan:",
        "    agent: software-architect",
        "    objective: write briefs",
        "    model: fable",
        "  exec:",
        "    agent: code-reviewer",
        "    objective: execute briefs",
        "    depend_on: [plan]",
        "    model: sonnet",
        '    loop: { enabled: true, max_rounds: 6, stop_when: "done" }',
        "    advisor: { model: opus, after_failed_rounds: 2, max_calls: 2 }",
        '    fan_out: { briefs_from: plan, template: "Implement {brief.title}: {brief.body}" }',
      ].join("\n"),
    );
    const run = createCliHarness(registerGraphCommands).run(["graph", "waves", graph, "--json"]);
    expect(run.exit).toBeUndefined();
    const payload = JSON.parse(run.stdout).data;
    const nodes = payload.waves.flatMap((w: { nodes: unknown[] }) => w.nodes) as Array<{
      id: string;
      advisor: unknown;
      fan_out: unknown;
    }>;
    const exec = nodes.find((n) => n.id === "exec");
    expect(exec?.advisor).toEqual({ model: "opus", after_failed_rounds: 2, max_calls: 2 });
    expect(exec?.fan_out).toEqual({ briefs_from: "plan", template: "Implement {brief.title}: {brief.body}" });
    const plan = nodes.find((n) => n.id === "plan");
    expect(plan?.advisor).toBeNull();
    expect(plan?.fan_out).toBeNull();
  });
});
