import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cac } from "cac";
import { registerGraphCommands } from "../../src/cli/commands/graph.js";

const FIXTURES = join(import.meta.dir, "..", "fixtures");
const graphFile = join(FIXTURES, "minimal-diamond.yaml");

function scaffoldProject(dir: string) {
  mkdirSync(join(dir, "claude", "agents"), { recursive: true });
  writeFileSync(join(dir, "claude", "agents", "software-architect.md"), "# SA\n");
  writeFileSync(join(dir, "claude", "agents", "code-reviewer.md"), "# CR\n");
}

function runCli(args: string[], _cwd?: string) {
  const cli = cac("gk");
  registerGraphCommands(cli);
  const logs: string[] = [];
  const origLog = console.log;
  const origWarn = console.warn;
  console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  console.warn = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  let exitCode = 0;
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
    console.warn = origWarn;
    process.exit = origExit;
  }
  return { stdout: logs.join("\n"), code: exitCode, error };
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

  test("graph list outputs all 11 topologies", () => {
    const { stdout, code } = runCli(["graph", "list"]);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.status).toBe("ok");
    expect(parsed.data.topologies).toHaveLength(11);
    expect(parsed.data.topologies).toContain("diamond");
    expect(parsed.data.topologies).toContain("tournament");
  });
  test("graph inspect diamond outputs config keys", () => {
    const { stdout, code } = runCli(["graph", "inspect", "diamond"]);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.status).toBe("ok");
    expect(parsed.data.topology).toBe("diamond");
    expect(parsed.data.config_keys).toContain("fanout.strategy");
    expect(parsed.data.config_keys).toContain("reduce");
  });
  test("graph inspect nonexistent fails with UNKNOWN_TOPOLOGY", () => {
    const parsed = JSON.parse(runCli(["graph", "inspect", "nonexistent"]).stdout);
    expect(parsed.status).toBe("fail");
    expect(parsed.error.code).toBe("UNKNOWN_TOPOLOGY");
    expect(parsed.error.details.available).toHaveLength(11);
  });
  test("validate on minimal-diamond.yaml — schema parse succeeds", () => {
    const parsed = JSON.parse(runCli(["validate", graphFile]).stdout);
    if (parsed.status === "fail") expect(parsed.error.code).not.toBe("SCHEMA_INVALID");
  });
  test("waves outputs golden topological plan on minimal-diamond.yaml", () => {
    const out = runCli(["graph", "waves", graphFile]);
    expect(out.code).toBe(0);
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
              },
            ],
          },
        ],
        evidence_required: ["report"],
      },
    });
  });
  test("waves rejects an empty graph through schema validation", () => {
    const file = join(tmp, "empty.yaml");
    writeFileSync(file, "");
    const out = runCli(["graph", "waves", file]);
    expect(out.code).toBe(1);
    expect(JSON.parse(out.stdout).error.code).toBe("SCHEMA_INVALID");
    expect(out.stdout).not.toContain("TypeError");
  });
  test("waves rejects unresolved curator dependencies instead of returning a partial plan", () => {
    const file = join(tmp, "stalled.yaml");
    writeFileSync(
      file,
      `apiVersion: graphkit.dev/v2\nkind: Graph\nmetadata: { name: stalled }\ntopology: memory-augmented\nnodes:\n  curator: { agent: software-architect, objective: curate, depend_on: [] }\n  worker: { agent: code-reviewer, objective: work, depend_on: [curator] }\ntopology_config:\n  inner: { template: custom }\n  memory: { curator_node: curator }\nevidence: { required_keys: [] }\n`,
    );
    const out = runCli(["graph", "waves", file]);
    expect(out.code).toBe(1);
    expect(JSON.parse(out.stdout).error).toMatchObject({
      code: "WAVES_INCOMPLETE",
      details: { unresolved: ["worker"] },
    });
  });
});
