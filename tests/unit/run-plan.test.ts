// Round 5 D1: gk run plan — pre-flight execution plan (validate + waves +
// worst-case dispatch projection). Exit 1 on invalid graph = the execute
// skill's missing Step 0.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerRunCommands } from "../../src/cli/commands/run.js";
import { createCliHarness } from "../helpers/cli-harness.js";

const graphYaml = `apiVersion: graphkit.dev/v2
kind: Graph
metadata: { name: planned }
topology: custom
nodes:
  scout: { agent: a, objective: o, depend_on: [], model: haiku }
  looped:
    agent: b
    objective: o
    depend_on: [scout]
    model: sonnet
    loop: { enabled: true, max_rounds: 3, stop_when: "done" }
loops:
  - nodes: [scout, looped]
    max_rounds: 2
    stop_when: "done"
`;

describe("gk run plan", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = join(tmpdir(), `gk-plan-${process.pid}-${Date.now()}`);
    mkdirSync(join(cwd, ".graphkit", "runs"), { recursive: true });
    writeFileSync(join(cwd, "graph.yaml"), graphYaml);
  });
  afterEach(() => {
    process.exitCode = 0;
    rmSync(cwd, { recursive: true, force: true });
  });

  test("human mode prints waves, tiers, and worst-case dispatches", () => {
    const run = createCliHarness(registerRunCommands, { cwd }).run(["run", "plan"]);
    expect(run.exit).toBeUndefined();
    expect(run.stdout).toContain("execution plan — planned (custom)");
    expect(run.stdout).toContain("waves:");
    expect(run.stdout).toContain("scout [haiku]");
    expect(run.stdout).toContain("looped [sonnet] ×3");
    expect(run.stdout).toContain("loop groups: [scout+looped] ×2");
    // min = 2 action nodes; worst = 2 + (3-1 looped) + (2-1)*2 group = 6
    expect(run.stdout).toContain("worst case: 6 node dispatch(es) (min 2)");
  });

  test("--json carries the plan and worst_case block", () => {
    const run = createCliHarness(registerRunCommands, { cwd }).run(["run", "plan", "--json"]);
    const parsed = JSON.parse(run.stdout);
    expect(parsed.status).toBe("ok");
    expect(parsed.data.plan.total_waves).toBe(2);
    expect(parsed.data.worst_case).toMatchObject({ dispatches_min: 2, dispatches_worst: 6, advisor_calls_worst: 0 });
    expect(parsed.data.worst_case.loop_groups).toEqual([{ nodes: ["scout", "looped"], max_rounds: 2 }]);
  });

  test("invalid graph exits 1 (preflight semantics)", () => {
    writeFileSync(
      join(cwd, "graph.yaml"),
      "apiVersion: graphkit.dev/v2\nkind: Graph\nmetadata: { name: bad }\ntopology: nope\nnodes: {}\n",
    );
    const run = createCliHarness(registerRunCommands, { cwd }).run(["run", "plan", "--json"]);
    expect(run.exitCode).toBe(1);
    const parsed = JSON.parse(run.stdout);
    expect(parsed.error.code).toBe("SCHEMA_INVALID");
  });

  test("missing graph file fails with the loader envelope", () => {
    const run = createCliHarness(registerRunCommands, { cwd }).run(["run", "plan", "--graph", "nope.yaml", "--json"]);
    expect(run.exitCode).toBe(1);
    expect(JSON.parse(run.stdout).error.code).toBe("GRAPH_FILE_NOT_FOUND");
  });
});
