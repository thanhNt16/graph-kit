import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { materializeNodeAgents } from "../../src/cli/node-agents.js";
import { GraphSchema } from "../../src/schemas/graph.schema.js";

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "gk-agents-"));
  mkdirSync(join(dir, ".omp", "agents"), { recursive: true });
  writeFileSync(join(dir, ".omp", "agents", "worker.md"), "You are worker.\n# Worker\nDoes work.\n");
  return dir;
}

const baseNode = {
  agent: "worker",
  objective: "Do the thing",
  depend_on: [],
  evidence: [],
};

describe("materializeNodeAgents", () => {
  test("writes gk-<node> agents with model/tools/skills frontmatter", () => {
    const dir = fixture();
    const graph = GraphSchema.parse({
      apiVersion: "graphkit.dev/v2",
      kind: "Graph",
      metadata: { name: "t" },
      topology: "custom",
      nodes: {
        build: { ...baseNode, model: "sonnet", skills: ["gk-recall"] },
        audit: { ...baseNode, constraints: [{ no_write: true }] },
      },
    });
    const mapping = materializeNodeAgents(dir, graph);
    expect(mapping).toEqual({ build: "gk-build", audit: "gk-audit" });

    const build = readFileSync(join(dir, ".omp", "agents", "gk-build.md"), "utf8");
    expect(build).toMatch(/^---\nname: gk-build\n/);
    expect(build).toContain('model: "sonnet"');
    expect(build).toContain('autoloadSkills: ["gk-recall"]');
    expect(build).toContain("# Worker");

    const audit = readFileSync(join(dir, ".omp", "agents", "gk-audit.md"), "utf8");
    expect(audit).toContain('tools: ["read", "grep", "glob", "bash"]');
    expect(audit).not.toContain("model:");
  });

  test("explicit node.tools beat constraint-derived tools", () => {
    const dir = fixture();
    const graph = GraphSchema.parse({
      apiVersion: "graphkit.dev/v2",
      kind: "Graph",
      metadata: { name: "t" },
      topology: "custom",
      nodes: { n: { ...baseNode, tools: ["Read", "Grep"], constraints: [{ no_write: true }] } },
    });
    materializeNodeAgents(dir, graph);
    const out = readFileSync(join(dir, ".omp", "agents", "gk-n.md"), "utf8");
    expect(out).toContain('tools: ["read", "grep"]');
  });

  test("injects challengeable assumptions and owned scope into the agent body", () => {
    const dir = fixture();
    const graph = GraphSchema.parse({
      apiVersion: "graphkit.dev/v2",
      kind: "Graph",
      metadata: { name: "t" },
      topology: "custom",
      nodes: {
        n: { ...baseNode, assumptions: ["the API is stable"], owns: ["src/api/**", "docs/api.md"] },
      },
    });
    materializeNodeAgents(dir, graph);
    const out = readFileSync(join(dir, ".omp", "agents", "gk-n.md"), "utf8");
    expect(out).toContain("## Challengeable assumptions");
    expect(out).toContain("Premises you may challenge with evidence; not mandatory requirements.");
    expect(out).toContain("- the API is stable");
    expect(out).toContain("## Owned scope");
    expect(out).toContain("- src/api/**");
    expect(out).toContain("- docs/api.md");
  });

  test("role supervisor forces the read-only toolset regardless of constraints", () => {
    const dir = fixture();
    const graph = GraphSchema.parse({
      apiVersion: "graphkit.dev/v2",
      kind: "Graph",
      metadata: { name: "t" },
      topology: "custom",
      nodes: { n: { ...baseNode, role: "supervisor", constraints: [{ no_write: true }] } },
    });
    materializeNodeAgents(dir, graph);
    const out = readFileSync(join(dir, ".omp", "agents", "gk-n.md"), "utf8");
    expect(out).toContain('tools: ["read", "grep", "glob"]');
    expect(out).not.toContain("bash");
  });

  test("prunes stale gk-* agents from earlier graph revisions", () => {
    const dir = fixture();
    writeFileSync(join(dir, ".omp", "agents", "gk-removed.md"), "---\nname: gk-removed\ndescription: old\n---\n");
    const graph = GraphSchema.parse({
      apiVersion: "graphkit.dev/v2",
      kind: "Graph",
      metadata: { name: "t" },
      topology: "custom",
      nodes: { keep: baseNode },
    });
    materializeNodeAgents(dir, graph);
    const files = readdirSync(join(dir, ".omp", "agents")).sort();
    expect(files).toEqual(["gk-keep.md", "worker.md"]);
  });

  test("fails when a bound agent fragment is missing", () => {
    const dir = fixture();
    const graph = GraphSchema.parse({
      apiVersion: "graphkit.dev/v2",
      kind: "Graph",
      metadata: { name: "t" },
      topology: "custom",
      nodes: { n: { ...baseNode, agent: "ghost" } },
    });
    expect(() => materializeNodeAgents(dir, graph)).toThrow(/Agent 'ghost' not found/);
  });
});
