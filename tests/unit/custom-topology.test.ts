import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import YAML from "yaml";
import { createCustomWorkflow } from "../../kits/claude/templates/custom.workflow.js";
import { compileGraph } from "../../src/compiler/emitter.js";
import { GraphSchema } from "../../src/schemas/graph.schema.js";

const TEMPLATES = join(import.meta.dir, "..", "..", "kits", "claude", "templates");

const graphYaml = (extra: object) => {
  const base = YAML.parse(`apiVersion: graphkit.dev/v2
kind: Graph
metadata: { name: t }
topology: custom
nodes:
  a: { agent: code-reviewer, objective: A, depend_on: [] }
  b: { agent: qa-engineer, objective: B, depend_on: [a] }
evidence: { required_keys: [] }
`);
  return GraphSchema.parse(Object.assign(base, extra));
};

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

  test("compiled workflow aborts on {ok:false} before downstream dispatch", async () => {
    const calls: string[] = [];
    const ctx = {
      agent: async (p: string) => {
        calls.push(p);
        return { ok: false, output: "boom", exit_code: 1 };
      },
      parallel: async (ts: (() => Promise<unknown>)[]) => Promise.all(ts.map((t) => t())),
    };
    await expect(createCustomWorkflow(graphYaml({}))(ctx)).rejects.toThrow(
      "GK_WAVE_FAILED: node(s) a failed; later waves not dispatched",
    );
    expect(calls.join(" ")).not.toContain("B");
  });

  test("compiled workflow aborts on throwing agent before downstream dispatch", async () => {
    const calls: string[] = [];
    const ctx = {
      agent: async (p: string) => {
        calls.push(p);
        if (p.includes("A")) throw new Error("agent boom");
        return { ok: true };
      },
      parallel: async (ts: (() => Promise<unknown>)[]) => Promise.all(ts.map((t) => t())),
    };
    await expect(createCustomWorkflow(graphYaml({}))(ctx)).rejects.toThrow(
      "GK_WAVE_FAILED: node(s) a failed; later waves not dispatched",
    );
    expect(calls.join(" ")).not.toContain("B");
  });

  test("compiled workflow aborts on falsy agent result before downstream dispatch", async () => {
    const calls: string[] = [];
    const ctx = {
      agent: async (p: string) => {
        calls.push(p);
        return p.includes("A") ? null : { ok: true };
      },
      parallel: async (ts: (() => Promise<unknown>)[]) => Promise.all(ts.map((t) => t())),
    };
    await expect(createCustomWorkflow(graphYaml({}))(ctx)).rejects.toThrow(
      "GK_WAVE_FAILED: node(s) a failed; later waves not dispatched",
    );
    expect(calls.join(" ")).not.toContain("B");
  });

  test("compiled loop runs exactly max_rounds on plain-string results", async () => {
    let n = 0;
    const ctx = {
      agent: async () => {
        n += 1;
        return "not done";
      },
      parallel: async (ts: (() => Promise<unknown>)[]) => Promise.all(ts.map((t) => t())),
    };
    const graph = graphYaml({});
    delete (graph.nodes as Record<string, unknown>).b;
    graph.nodes.a.loop = { enabled: true, max_rounds: 3, stop_when: "never matches" };
    await createCustomWorkflow(graph)(ctx);
    expect(n).toBe(3);
  });
  test("loop fails fast on a failed round", async () => {
    const calls: string[] = [];
    const ctx = {
      agent: async (p: string) => {
        calls.push(p);
        return calls.length === 1 ? { ok: false, error: "boom" } : { ok: true };
      },
      parallel: async (ts: (() => Promise<unknown>)[]) => Promise.all(ts.map((t) => t())),
    };
    const graph = graphYaml({});
    delete (graph.nodes as Record<string, unknown>).b;
    graph.nodes.a.loop = { enabled: true, max_rounds: 2 };
    await expect(createCustomWorkflow(graph)(ctx)).rejects.toThrow("GK_WAVE_FAILED: node(s) a failed");
    expect(calls).toHaveLength(1);
  });

  test("passes evidence paths and only a 2KB upstream tail", async () => {
    const prompts: string[] = [];
    const graph = graphYaml({ outputs: { evidence_dir: ".graphkit/evidence/" } });
    graph.nodes.a.evidence = ["design"];
    const ctx = {
      agent: async (p: string) => {
        prompts.push(p);
        return p === "A" ? "x".repeat(3000) : "ok";
      },
      parallel: async (ts: (() => Promise<unknown>)[]) => Promise.all(ts.map((t) => t())),
    };
    await createCustomWorkflow(graph)(ctx);
    const downstream = prompts.find((p) => p.startsWith("B"))!;
    expect(downstream).toContain(".graphkit/evidence/design.md");
    expect(downstream).not.toContain("x".repeat(2049));
    expect(downstream).toContain("x".repeat(2048));
  });
});
