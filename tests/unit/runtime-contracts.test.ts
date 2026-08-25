import { describe, expect, test } from "bun:test";
import { compileGraph } from "../../src/compiler/emitter.js";
import { validateGraph } from "../../src/compiler/validate.js";
import { buildPiArgs } from "../../kits/pi/extensions/gk-subagent";
import { GraphSchema } from "../../src/schemas/graph.schema.js";

const templatesDir = `${import.meta.dir}/../../kits/claude/templates`;

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
  test("rejects unsupported loop exit_condition", () => {
    const findings = validateGraph(
      graph({ nodes: { worker: { agent: "worker", objective: "work", loop: { enabled: true, exit_condition: "done" } } } }),
      "/tmp/no-agent-directory",
    );
    expect(findings).toContainEqual(
      expect.objectContaining({ check: "unsupported-field", path: "nodes.worker.loop.exit_condition" }),
    );
  });

  test("rejects every unsupported limits field", () => {
    const findings = validateGraph(
      graph({
        limits: { max_workers: 1, max_iterations: 2, max_findings: 3, budget_tokens: 4 },
      }),
      "/tmp/no-agent-directory",
    );
    for (const key of ["max_workers", "max_iterations", "max_findings", "budget_tokens"]) {
      expect(findings).toContainEqual(
        expect.objectContaining({ check: "unsupported-field", path: `limits.${key}` }),
      );
    }
  });

  test("requires stop_when for enabled loops", () => {
    const findings = validateGraph(
      graph({ nodes: { worker: { agent: "worker", objective: "work", loop: { enabled: true } } } }),
      "/tmp/no-agent-directory",
    );
    expect(findings).toContainEqual(expect.objectContaining({ check: "loop-exit", path: "nodes.worker.loop" }));
  });

  test("no_exec overrides tools and no_write", () => {
    expect(buildPiArgs({ agent: "a", objective: "x", constraints: { no_exec: true } })).toEqual([
      "-p",
      "--tools",
      "Read,Glob,Grep",
    ]);
    expect(
      buildPiArgs({ agent: "a", objective: "x", constraints: { no_exec: true, no_write: true, tools_allowlist: ["Bash"] } }),
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

  test("compiled config does not serialize limits", () => {
    const output = compileGraph(graph({ limits: { max_workers: 1 } }), templatesDir);
    const config = JSON.parse(output.match(/const graphConfig = ({[\s\S]*?});/)?.[1] ?? "{}");
    expect(config).not.toHaveProperty("limits");
  });
});