import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { agentFileName, validateGraph } from "../../src/compiler/validate.js";
import { GraphSchema } from "../../src/schemas/graph.schema.js";

const FIXTURES = join(import.meta.dir, "..", "fixtures");
const PROJECT_ROOT = join(import.meta.dir, "..", "..", "kits");

function loadYaml(name: string) {
  return YAML.parse(readFileSync(join(FIXTURES, name), "utf-8"));
}

describe("agentFileName", () => {
  test("lowercases and hyphenates", () => {
    expect(agentFileName("Software Architect")).toBe("software-architect.md");
    expect(agentFileName("Code Reviewer")).toBe("code-reviewer.md");
    expect(agentFileName("QA Engineer")).toBe("qa-engineer.md");
  });
});

describe("schema rejects invalid graphs", () => {
  test("no-agent: zod rejects missing agent field", () => {
    const result = GraphSchema.safeParse(loadYaml("invalid-graph-no-agent.yaml"));
    expect(result.success).toBe(false);
  });

  test("cyclic: zod superRefine rejects cycle", () => {
    const result = GraphSchema.safeParse(loadYaml("invalid-graph-cyclic.yaml"));
    expect(result.success).toBe(false);
  });
});

describe("validateGraph structural checks", () => {
  test("missing-ref: finds refs-exist finding", () => {
    const parsed = GraphSchema.parse(loadYaml("invalid-graph-missing-ref.yaml"));
    const findings = validateGraph(parsed, PROJECT_ROOT);
    expect(findings).toContainEqual(expect.objectContaining({ check: "refs-exist", path: "nodes.scouter.refs" }));
  });

  test("evidence-keys: finds missing required key", () => {
    const parsed = GraphSchema.parse(loadYaml("invalid-graph-missing-ref.yaml"));
    const findings = validateGraph(parsed, PROJECT_ROOT);
    expect(findings).toContainEqual(
      expect.objectContaining({
        check: "evidence-keys",
        path: "evidence.required_keys",
        message: expect.stringContaining("report"),
      }),
    );
  });

  test("loop-exit: finds enabled loop without stop condition", () => {
    const parsed = GraphSchema.parse({
      apiVersion: "graphkit.dev/v2",
      kind: "Graph",
      metadata: { name: "loop-test" },
      topology: "diamond",
      nodes: {
        looper: {
          agent: "Software Architect",
          objective: "research",
          loop: { enabled: true, max_rounds: 5 },
          depend_on: [],
        },
      },
    });
    const findings = validateGraph(parsed, PROJECT_ROOT);
    expect(findings).toContainEqual(expect.objectContaining({ check: "loop-exit", path: "nodes.looper.loop" }));
  });

  test("agent-binding: finds unknown agent", () => {
    const parsed = GraphSchema.parse({
      apiVersion: "graphkit.dev/v2",
      kind: "Graph",
      metadata: { name: "bad-agent" },
      topology: "diamond",
      nodes: {
        worker: { agent: "Nonexistent Agent", objective: "work", depend_on: [] },
      },
    });
    const findings = validateGraph(parsed, PROJECT_ROOT);
    expect(findings).toContainEqual(
      expect.objectContaining({
        check: "agent-binding",
        path: "nodes.worker.agent",
        message: expect.stringContaining("Nonexistent Agent"),
      }),
    );
  });

  // --- memory-augmented + eval-gate (Task 6) ---
  const baseGraph = {
    apiVersion: "graphkit.dev/v2",
    kind: "Graph",
    metadata: { name: "g" },
    topology: "memory-augmented",
    topology_config: { inner: { template: "diamond" }, memory: { curator_node: "curator" } },
    nodes: {
      scouter: { agent: "Software Architect", objective: "x" },
      worker: { agent: "Code Reviewer", objective: "y" },
      synthesizer: { agent: "Software Architect", objective: "z" },
      curator: { agent: "Memory Curator", objective: "curate" },
    },
  };

  test("memory-augmented requires inner.template", () => {
    const g = GraphSchema.parse({ ...baseGraph, topology_config: { memory: {} } });
    const findings = validateGraph(g, "/nonexistent-root");
    expect(findings.some((f) => f.check === "memory-inner")).toBe(true);
  });

  test("memory-augmented requires the curator node to exist", () => {
    const g = GraphSchema.parse({
      ...baseGraph,
      topology_config: { inner: { template: "diamond" }, memory: { curator_node: "missing" } },
    });
    const findings = validateGraph(g, "/nonexistent-root");
    expect(findings.some((f) => f.check === "memory-curator-node")).toBe(true);
  });

  test("eval-gate requires eval config", () => {
    const g = GraphSchema.parse({
      ...baseGraph,
      topology: "diamond",
      nodes: {
        worker: { agent: "Code Reviewer", objective: "x" },
        "eval-gate": { agent: "Code Reviewer", objective: "gate", role: "eval-gate", depend_on: ["worker"] },
      },
    });
    const findings = validateGraph(g, "/nonexistent-root");
    expect(findings.some((f) => f.check === "eval-gate-config")).toBe(true);
  });

  test("eval-gate with eval config + depend_on passes its checks", () => {
    const g = GraphSchema.parse({
      ...baseGraph,
      topology: "diamond",
      nodes: {
        worker: { agent: "Code Reviewer", objective: "x" },
        "eval-gate": {
          agent: "Code Reviewer",
          objective: "gate",
          role: "eval-gate",
          depend_on: ["worker"],
          eval: { mode: "work_product" },
        },
      },
    });
    const findings = validateGraph(g, "/nonexistent-root");
    expect(findings.some((f) => f.check === "eval-gate-config")).toBe(false);
  });

  test("valid-diamond: zero findings", () => {
    const parsed = GraphSchema.parse(loadYaml("valid-diamond.yaml"));
    const findings = validateGraph(parsed, PROJECT_ROOT);
    expect(findings).toEqual([]);
  });
});
