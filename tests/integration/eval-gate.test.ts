import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { installKit } from "../../src/cli/commands/kit.js";
import { validateGraph } from "../../src/compiler/validate.js";
import { GraphSchema } from "../../src/schemas/graph.schema.js";

const TMP = join(import.meta.dir, "..", ".tmp-eval-gate");

describe("AC16: eval-gate node validation", () => {
  beforeAll(() => {
    if (existsSync(TMP)) rmSync(TMP, { recursive: true });
    mkdirSync(TMP, { recursive: true });
    installKit(TMP);
    symlinkSync(join(TMP, ".claude"), join(TMP, "claude"), "junction");
  });
  afterAll(() => {
    if (existsSync(TMP)) rmSync(TMP, { recursive: true });
  });

  test("eval-gate with eval + depend_on passes validation", () => {
    const graphYaml = `\
apiVersion: graphkit.dev/v2
kind: Graph
metadata:
  name: eval-gate-test
topology: diamond
nodes:
  scouter:
    agent: Software Architect
    objective: Analyze the codebase
    depend_on: []
  evaluator:
    agent: QA Engineer
    objective: Evaluate the findings
    role: eval-gate
    eval:
      mode: work_product
      rubric: strict
    depend_on: [scouter]
evidence:
  required_keys: []
`;
    const graphFile = join(TMP, "eval-gate.yaml");
    writeFileSync(graphFile, graphYaml);
    const graph = GraphSchema.parse(YAML.parse(graphYaml));
    const findings = validateGraph(graph, TMP);
    // No eval-gate findings
    expect(findings.filter((f) => f.check.startsWith("eval-gate"))).toEqual([]);
  });

  test("eval-gate without eval block fails validation", () => {
    const graphYaml = `\
apiVersion: graphkit.dev/v2
kind: Graph
metadata:
  name: eval-gate-bad
topology: diamond
nodes:
  scouter:
    agent: Software Architect
    objective: Analyze
    depend_on: []
  evaluator:
    agent: QA Engineer
    objective: Evaluate
    role: eval-gate
    depend_on: [scouter]
evidence:
  required_keys: []
`;
    const graph = GraphSchema.parse(YAML.parse(graphYaml));
    const findings = validateGraph(graph, TMP);
    expect(findings.some((f) => f.check === "eval-gate-config")).toBe(true);
  });

  test("eval-gate without depend_on fails validation", () => {
    const graphYaml = `\
apiVersion: graphkit.dev/v2
kind: Graph
metadata:
  name: eval-gate-no-deps
topology: diamond
nodes:
  evaluator:
    agent: QA Engineer
    objective: Evaluate
    role: eval-gate
    eval:
      mode: work_product
evidence:
  required_keys: []
`;
    const graph = GraphSchema.parse(YAML.parse(graphYaml));
    const findings = validateGraph(graph, TMP);
    expect(findings.some((f) => f.check === "eval-gate-depend_on")).toBe(true);
  });
});
