import { describe, expect, test } from "bun:test";
import { GraphSchema } from "../../src/schemas/graph.schema";
import { GraphTemplateSchema, materializeTemplate } from "../../src/schemas/template.schema";

function baseGraph() {
  return {
    apiVersion: "graphkit.dev/v2",
    kind: "Graph",
    metadata: { name: "security-audit", description: "audit" },
    topology: "diamond",
    inputs: {},
    nodes: {
      reviewer: {
        agent: "code-reviewer",
        objective: "Audit {{target}} for {{focus}}.",
      },
    },
  };
}

function baseTemplate(overrides: Record<string, unknown> = {}) {
  return {
    apiVersion: "graphkit.dev/v1",
    kind: "GraphTemplate",
    metadata: { name: "security-audit", description: "audit", version: 1 },
    parameters: {
      target: { description: "Code or directory to audit", required: true },
      focus: { description: "Primary security concern", default: "general application security" },
    },
    recommendations: { agents: ["code-reviewer"], skills: ["security-review"], tools: ["Read"] },
    graph: baseGraph(),
    ...overrides,
  };
}

describe("GraphTemplate v1 schema", () => {
  test("accepts a minimal valid GraphTemplate v1", () => {
    const result = GraphTemplateSchema.safeParse(baseTemplate());
    expect(result.success).toBe(true);
  });

  test("rejects wrong apiVersion", () => {
    const result = GraphTemplateSchema.safeParse(baseTemplate({ apiVersion: "graphkit.dev/v2" }));
    expect(result.success).toBe(false);
  });

  test("rejects wrong kind", () => {
    const result = GraphTemplateSchema.safeParse(baseTemplate({ kind: "Graph" }));
    expect(result.success).toBe(false);
  });

  test("rejects template name outside ^[a-z0-9]+(?:-[a-z0-9]+)*$", () => {
    const t = baseTemplate();
    t.metadata = { ...t.metadata, name: "../etc/passwd" };
    const result = GraphTemplateSchema.safeParse(t);
    expect(result.success).toBe(false);
  });

  test("rejects a placeholder referencing an undeclared parameter", () => {
    const t = baseTemplate();
    t.graph.nodes.reviewer.objective = "Audit {{unknown}}.";
    const result = GraphTemplateSchema.safeParse(t);
    expect(result.success).toBe(false);
  });

  test("rejects a declared parameter that is unused", () => {
    const t = baseTemplate();
    t.parameters.unused = { description: "never referenced", required: false, default: "x" };
    const result = GraphTemplateSchema.safeParse(t);
    expect(result.success).toBe(false);
  });

  test("rejects a required parameter that has a default", () => {
    const t = baseTemplate();
    t.parameters.target = { description: "x", required: true, default: "y" };
    const result = GraphTemplateSchema.safeParse(t);
    expect(result.success).toBe(false);
  });

  test("rejects a parameter with no default and required not set", () => {
    const t = baseTemplate();
    t.parameters.loose = { description: "x" };
    const result = GraphTemplateSchema.safeParse(t);
    expect(result.success).toBe(false);
  });

  test("rejects a parameter name that is not lower-camel or kebab-case", () => {
    const t = baseTemplate();
    t.parameters.Target = { description: "x", required: true };
    const result = GraphTemplateSchema.safeParse(t);
    expect(result.success).toBe(false);
  });

  test("rejects a malformed placeholder token", () => {
    const t = baseTemplate();
    t.graph.nodes.reviewer.objective = "Audit {{bad name}}.";
    const result = GraphTemplateSchema.safeParse(t);
    expect(result.success).toBe(false);
  });

  test("accepts kebab-case parameter names", () => {
    const t = baseTemplate();
    t.parameters = {
      "repo-path": { description: "path", required: true },
    };
    t.graph.nodes.reviewer.objective = "Audit {{repo-path}}.";
    const result = GraphTemplateSchema.safeParse(t);
    expect(result.success).toBe(true);
  });

  test("validates the embedded graph against GraphSchema", () => {
    const t = baseTemplate();
    t.graph.topology = "does-not-exist";
    const result = GraphTemplateSchema.safeParse(t);
    expect(result.success).toBe(false);
  });
});

describe("materializeTemplate", () => {
  test("embedded placeholder resolves to text", () => {
    const t = baseTemplate();
    const graph = materializeTemplate(GraphTemplateSchema.parse(t), {
      target: "src/core",
      focus: "auth",
    });
    expect(graph.nodes.reviewer.objective).toBe("Audit src/core for auth.");
  });

  test("sole placeholder retains scalar type", () => {
    const t = baseTemplate();
    t.parameters.maxFiles = { description: "limit", required: true };
    t.graph.nodes.reviewer.constraints = [{ max_files: "{{maxFiles}}" }];
    const graph = materializeTemplate(GraphTemplateSchema.parse(t), {
      target: "src",
      maxFiles: 50,
    });
    expect(graph.nodes.reviewer.constraints[0].max_files).toBe(50);
    expect(typeof graph.nodes.reviewer.constraints[0].max_files).toBe("number");
  });

  test("materialized output passes GraphSchema", () => {
    const t = baseTemplate();
    const graph = materializeTemplate(GraphTemplateSchema.parse(t), {
      target: "src",
      focus: "general application security",
    });
    const result = GraphSchema.safeParse(graph);
    expect(result.success).toBe(true);
  });
});
