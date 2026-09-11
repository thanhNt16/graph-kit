import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerGraphCommands } from "../../src/cli/commands/graph.js";
import { createCliHarness } from "../helpers/cli-harness.js";

const FIXTURES = join(import.meta.dir, "..", "fixtures");
const graphFile = join(FIXTURES, "minimal-diamond.yaml");

function scaffoldProject(dir: string) {
  mkdirSync(join(dir, "claude", "agents"), { recursive: true });
  writeFileSync(join(dir, "claude", "agents", "software-architect.md"), "# SA\n");
  writeFileSync(join(dir, "claude", "agents", "code-reviewer.md"), "# CR\n");
}

describe("gk graph commands", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = join(tmpdir(), `gk-graph-cmd-test-${process.pid}-${Date.now()}`);
    mkdirSync(tmp, { recursive: true });
    scaffoldProject(tmp);
  });
  afterEach(() => {
    process.exitCode = 0;
    rmSync(tmp, { recursive: true, force: true });
  });

  test("graph list reports session graphs in initialized cwd", () => {
    mkdirSync(join(tmp, ".graphkit", "graphs"), { recursive: true });
    const run = createCliHarness(registerGraphCommands, { cwd: tmp, captureWarn: true }).run([
      "graph",
      "list",
      "--json",
    ]);
    expect(run.exit).toBeUndefined();
    const parsed = JSON.parse(run.stdout);
    expect(parsed.status).toBe("ok");
    expect(parsed.data.sessions).toEqual([]);
    expect(parsed.data.active).toBeNull();
  });
  test("graph inspect diamond outputs config keys", () => {
    const run = createCliHarness(registerGraphCommands, { captureWarn: true }).run(["graph", "inspect", "diamond"]);
    expect(run.exit).toBeUndefined();
    const parsed = JSON.parse(run.stdout);
    expect(parsed.status).toBe("ok");
    expect(parsed.data.topology).toBe("diamond");
    expect(parsed.data.config_keys).toContain("fanout.strategy");
    expect(parsed.data.config_keys).toContain("reduce");
  });
  test("graph inspect nonexistent fails with UNKNOWN_TOPOLOGY", () => {
    const parsed = JSON.parse(
      createCliHarness(registerGraphCommands, { captureWarn: true }).run(["graph", "inspect", "nonexistent"]).stdout,
    );
    expect(parsed.status).toBe("fail");
    expect(parsed.error.code).toBe("UNKNOWN_TOPOLOGY");
    expect(parsed.error.details.available).toHaveLength(11);
  });
  test("validate on minimal-diamond.yaml — schema parse succeeds", () => {
    const parsed = JSON.parse(
      createCliHarness(registerGraphCommands, { captureWarn: true }).run(["validate", graphFile, "--json"]).stdout,
    );
    if (parsed.status === "fail") expect(parsed.error.code).not.toBe("SCHEMA_INVALID");
  });
  test("waves outputs golden topological plan on minimal-diamond.yaml", () => {
    const out = createCliHarness(registerGraphCommands, { captureWarn: true }).run(["graph", "waves", graphFile]);
    expect(out.exit).toBeUndefined();
    expect(JSON.parse(out.stdout)).toEqual({
      status: "ok",
      data: {
        graph: "test-graph",
        topology: "diamond",
        total_waves: 3,
        total_nodes: 3,
        waves: [
          {
            wave: 0,
            parallel: false,
            nodes: [
              {
                id: "scouter",
                agent: "Software Architect",
                model: "opus",
                objective: "Analyze the codebase",
                tools: ["Read", "Glob", "Grep"],
                skills: [],
                refs: [],
                depend_on: [],
                loop: { enabled: false, max_rounds: 3 },
                evidence: ["attack_surface"],
                advisor: null,
                fan_out: null,
                hooks: [],
              },
            ],
          },
          {
            wave: 1,
            parallel: false,
            nodes: [
              {
                id: "worker",
                agent: "Code Reviewer",
                model: "sonnet",
                objective: "Audit assigned files",
                tools: [],
                skills: [],
                refs: [],
                depend_on: ["scouter"],
                loop: { enabled: false, max_rounds: 3 },
                evidence: ["findings"],
                advisor: null,
                fan_out: null,
                hooks: [],
              },
            ],
          },
          {
            wave: 2,
            parallel: false,
            nodes: [
              {
                id: "synthesizer",
                agent: "Software Architect",
                model: "opus",
                objective: "Merge findings into a report",
                tools: [],
                skills: [],
                refs: [],
                depend_on: ["worker"],
                loop: { enabled: false, max_rounds: 3 },
                evidence: ["report"],
                advisor: null,
                fan_out: null,
                hooks: [],
              },
            ],
          },
        ],
        evidence_required: ["report"],
        on_graph_complete: [],
      },
    });
  });
  test("waves rejects an empty graph through schema validation", () => {
    const file = join(tmp, "empty.yaml");
    writeFileSync(file, "");
    const out = createCliHarness(registerGraphCommands, { captureWarn: true }).run(["graph", "waves", file]);
    expect(out.exit).toBe(1);
    expect(JSON.parse(out.stdout).error.code).toBe("SCHEMA_INVALID");
    expect(out.stdout).not.toContain("TypeError");
  });
  test("waves rejects unresolved curator dependencies instead of returning a partial plan", () => {
    const file = join(tmp, "stalled.yaml");
    writeFileSync(
      file,
      `apiVersion: graphkit.dev/v2\nkind: Graph\nmetadata: { name: stalled }\ntopology: memory-augmented\nnodes:\n  curator: { agent: software-architect, objective: curate, depend_on: [] }\n  worker: { agent: code-reviewer, objective: work, depend_on: [curator] }\ntopology_config:\n  inner: { template: custom }\n  memory: { curator_node: curator }\nevidence: { required_keys: [] }\n`,
    );
    const out = createCliHarness(registerGraphCommands, { captureWarn: true }).run(["graph", "waves", file]);
    expect(out.exit).toBe(1);
    expect(JSON.parse(out.stdout).error).toMatchObject({
      code: "WAVES_INCOMPLETE",
      details: { unresolved: ["worker"] },
    });
  });
});
