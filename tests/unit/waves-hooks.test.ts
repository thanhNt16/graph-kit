// tests/unit/waves-hooks.test.ts
import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cac } from "cac";
import { registerGraphCommands } from "../../src/cli/commands/graph.js";

function runCli(args: string[]) {
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
  try {
    cli.parse(["node", "gk", ...args], { run: true });
  } finally {
    console.log = origLog;
    process.exit = origExit;
  }
  return { stdout: logs.join("\n"), code: exitCode };
}

const GRAPH = join(tmpdir(), `gk-waves-hooks-${process.pid}-${Date.now()}.yaml`);
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

describe("gk graph waves hook emission", () => {
  test("waves payload carries per-node and graph-level hook commands", () => {
    const { stdout, code } = runCli(["graph", "waves", GRAPH, "--json"]);
    expect(code).toBe(0);
    const d = JSON.parse(stdout).data;
    expect(d.on_graph_complete).toEqual(["gk run end --status merged"]);
    expect(d.waves[0].nodes[0].hooks).toEqual(["gk run node {node} --status ok"]);
    expect(d.waves[1].nodes[0].hooks).toEqual(["gk run node {node} --status ok"]);
  });
  test("graph without hooks emits empty arrays", () => {
    const graph = join(tmpdir(), `gk-waves-nohooks-${process.pid}-${Date.now()}.yaml`);
    writeFileSync(
      graph,
      `topology: diamond\napiVersion: graphkit.dev/v2\nkind: Graph\nmetadata: { name: plain }\nnodes:\n  a: { agent: Code Reviewer, objective: x, depend_on: [] }\n`,
    );
    const { stdout, code } = runCli(["graph", "waves", graph, "--json"]);
    expect(code).toBe(0);
    const d = JSON.parse(stdout).data;
    expect(d.on_graph_complete).toEqual([]);
    expect(d.waves[0].nodes[0].hooks).toEqual([]);
  });
  test("waves payload carries advisor and fan_out verbatim", () => {
    const graph = join(tmpdir(), `gk-waves-advisor-${process.pid}-${Date.now()}.yaml`);
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
    const { stdout, code } = runCli(["graph", "waves", graph, "--json"]);
    expect(code).toBe(0);
    const payload = JSON.parse(stdout).data;
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
