import { describe, expect, test } from "bun:test";
import { buildPiArgs } from "../../kits/pi/extensions/gk-subagent";
import { validateGraph } from "../../src/compiler/validate.js";
import { GraphSchema } from "../../src/schemas/graph.schema.js";

function graph(overrides: Record<string, unknown> = {}) {
  return GraphSchema.parse({
    metadata: { name: "contracts" },
    topology: "custom",
    nodes: {
      worker: { agent: "worker", objective: "work", depend_on: [] },
    },
    ...overrides,
  });
}

describe("runtime contracts", () => {
  test("requires stop_when for enabled loops", () => {
    const findings = validateGraph(
      graph({ nodes: { worker: { agent: "worker", objective: "work", loop: { enabled: true } } } }),
      "/tmp/no-agent-directory",
    );
    expect(findings).toContainEqual(expect.objectContaining({ check: "loop-exit", path: "nodes.worker.loop" }));
  });

  test("rejects unsupported loop and limits fields at parse time", () => {
    const raw = {
      metadata: { name: "contracts" },
      topology: "custom",
      nodes: { worker: { agent: "worker", objective: "work", depend_on: [] } },
    };
    expect(
      GraphSchema.safeParse({
        ...raw,
        nodes: { worker: { agent: "worker", objective: "work", loop: { enabled: true, exit_condition: "done" } } },
      }).success,
    ).toBe(false);
    expect(GraphSchema.safeParse({ ...raw, limits: { max_workers: 1 } }).success).toBe(false);
  });

  test("no_exec overrides tools and no_write", () => {
    expect(buildPiArgs({ agent: "a", objective: "x", constraints: { no_exec: true } })).toEqual([
      "-p",
      "--tools",
      "Read,Glob,Grep",
    ]);
    expect(
      buildPiArgs({
        agent: "a",
        objective: "x",
        constraints: { no_exec: true, no_write: true, tools_allowlist: ["Bash"] },
      }),
    ).toEqual(["-p", "--tools", "Read,Glob,Grep"]);
  });

  test("tools and no_write use exclusive precedence", () => {
    expect(buildPiArgs({ agent: "a", objective: "x", constraints: { tools_allowlist: ["Bash"] } })).toEqual([
      "-p",
      "--tools",
      "Bash",
    ]);
    expect(buildPiArgs({ agent: "a", objective: "x", constraints: { no_write: true } })).toEqual([
      "-p",
      "--tools",
      "Read,Glob,Grep,Bash",
    ]);
  });
});
