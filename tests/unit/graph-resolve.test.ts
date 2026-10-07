import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadGraphDoc, previewGraph, resolveGraphPath } from "../../src/cli/graph-resolve.js";
import { GraphKitError } from "../../src/errors.js";

const GRAPH = `kind: Graph\nmetadata: {name: t}\ntopology: diamond\nnodes: {a: {agent: x, objective: o}}\n`;

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "gres-"));
  writeFileSync(join(dir, "graph.yaml"), GRAPH);
  return dir;
}

const TEMPLATE = `apiVersion: graphkit.dev/v1
kind: GraphTemplate
metadata: { name: preview-tpl, description: d, version: 1 }
parameters:
  target:
    type: string
    required: false
    default: world
graph:
  apiVersion: graphkit.dev/v2
  kind: Graph
  metadata: { name: "inner-{{target}}" }
  topology: custom
  nodes:
    step1: { agent: code-reviewer, objective: "review {{target}}" }
`;

const TEMPLATE_REQUIRED_PARAM = TEMPLATE.replace(
  / {2}target:\n {4}type: string\n {4}required: false\n {4}default: world\n/,
  "  target:\n    type: string\n    required: true\n",
);

describe("loadGraphDoc", () => {
  test("routes kind GraphTemplate to the template variant", () => {
    const dir = scratch();
    const tpl = join(dir, "tpl.gk.yaml");
    writeFileSync(tpl, TEMPLATE);
    const doc = loadGraphDoc(tpl);
    expect(doc.kind).toBe("template");
    if (doc.kind === "template") expect(doc.template.metadata.name).toBe("preview-tpl");
  });
  test("routes a plain Graph to the graph variant", () => {
    const doc = loadGraphDoc(join(scratch(), "graph.yaml"));
    expect(doc.kind).toBe("graph");
    if (doc.kind === "graph") expect(doc.graph.metadata.name).toBe("t");
  });
  test("invalid template envelope → SCHEMA_INVALID, not Graph-schema noise", () => {
    const dir = scratch();
    const tpl = join(dir, "bad.gk.yaml");
    writeFileSync(tpl, TEMPLATE.replace("preview-tpl", "Bad_Name"));
    try {
      loadGraphDoc(tpl);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(GraphKitError);
      if (e instanceof GraphKitError) expect(e.code).toBe("SCHEMA_INVALID");
    }
  });
});

describe("previewGraph", () => {
  test("materializes a template in-memory with parameter defaults — zero disk writes", () => {
    const dir = scratch();
    writeFileSync(join(dir, "tpl.gk.yaml"), TEMPLATE);
    const { graph } = previewGraph(dir, join(dir, "tpl.gk.yaml"));
    expect(graph.metadata.name).toBe("inner-world");
    expect(graph.nodes.step1.objective).toBe("review world");
    expect(existsSync(join(dir, ".graphkit"))).toBe(false);
  });
  test("passes a plain graph through untouched", () => {
    const dir = scratch();
    const { graph } = previewGraph(dir, join(dir, "graph.yaml"));
    expect(graph.metadata.name).toBe("t");
  });
  test("required parameter without default → TEMPLATE_NOT_GRAPH with materialize hint", () => {
    const dir = scratch();
    const tpl = join(dir, "req.gk.yaml");
    writeFileSync(tpl, TEMPLATE_REQUIRED_PARAM);
    try {
      previewGraph(dir, tpl);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(GraphKitError);
      if (e instanceof GraphKitError) {
        expect(e.code).toBe("TEMPLATE_NOT_GRAPH");
        expect(e.details?.hint).toContain("gk template materialize");
      }
    }
  });
});

describe("resolveGraphPath", () => {
  test("explicit flag: existing file path wins", () => {
    const cwd = scratch();
    expect(resolveGraphPath(cwd, join(cwd, "graph.yaml")).source).toBe("flag");
  });
  test("explicit flag: session-graph id resolves (UX F1)", () => {
    const cwd = scratch();
    mkdirSync(join(cwd, ".graphkit", "graphs"), { recursive: true });
    writeFileSync(join(cwd, ".graphkit", "graphs", "2026-01-01-x.yaml"), GRAPH);
    expect(resolveGraphPath(cwd, "2026-01-01-x").path).toContain("2026-01-01-x.yaml");
  });
  test("explicit flag: nonexistent path AND non-id → GRAPH_NOT_FOUND with hint", () => {
    const cwd = scratch();
    expect(() => resolveGraphPath(cwd, "nope")).toThrow(/GRAPH_NOT_FOUND/);
  });
  test("omitted: session active pointer beats root graph.yaml (SB F2)", () => {
    const cwd = scratch();
    mkdirSync(join(cwd, ".graphkit", "graphs"), { recursive: true });
    writeFileSync(join(cwd, ".graphkit", "graphs", "2026-01-01-s.yaml"), GRAPH);
    writeFileSync(join(cwd, ".graphkit", "active"), "2026-01-01-s");
    expect(resolveGraphPath(cwd).source).toBe("active");
  });
  test("omitted: no pointer → root fallback", () => {
    const cwd = scratch();
    expect(resolveGraphPath(cwd).source).toBe("root");
  });
  test("omitted: nothing → NO_ACTIVE_GRAPH", () => {
    const cwd = mkdtempSync(join(tmpdir(), "gres-"));
    expect(() => resolveGraphPath(cwd)).toThrow(/NO_ACTIVE_GRAPH/);
  });
});
