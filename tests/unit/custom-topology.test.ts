import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import YAML from "yaml";
import { compileGraph } from "../../src/compiler/emitter.js";
import { GraphSchema } from "../../src/schemas/graph.schema.js";

const TEMPLATES = join(import.meta.dir, "..", "..", "kits", "claude", "templates");

describe("custom topology", () => {
  test("compiles with createCustomWorkflow", () => {
    const yaml = `
apiVersion: graphkit.dev/v2
kind: Graph
metadata:
  name: test-custom
topology: custom
inputs:
  task: { type: string, required: true }
nodes:
  a:
    agent: code-reviewer
    objective: Do A
    depend_on: []
  b:
    agent: qa-engineer
    objective: Do B after A
    depend_on: [a]
  c:
    agent: code-reviewer
    objective: Do C after A (parallel with B)
    depend_on: [a]
  d:
    agent: software-architect
    objective: Merge B and C
    depend_on: [b, c]
evidence:
  required_keys: []
`;
    const graph = GraphSchema.parse(YAML.parse(yaml));
    const script = compileGraph(graph, TEMPLATES);
    expect(script).toContain("createCustomWorkflow");
    expect(script).toContain("export const meta");
    expect(script).toContain("return await _wf(_ctx)");
  });

  test("flow presets validate", () => {
    for (const preset of ["sdd", "superpowers", "research-and-build"]) {
      const yaml = `
apiVersion: graphkit.dev/v2
kind: Graph
metadata:
  name: test-${preset}
topology: ${preset}
nodes:
  a:
    agent: code-reviewer
    objective: test
    depend_on: []
`;
      const result = GraphSchema.safeParse(YAML.parse(yaml));
      expect(result.success).toBe(true);
    }
  });
});
