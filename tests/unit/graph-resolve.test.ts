import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveGraphPath } from "../../src/cli/graph-resolve.js";

const GRAPH = `kind: Graph\nmetadata: {name: t}\ntopology: diamond\nnodes: {a: {agent: x, objective: o}}\n`;

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "gres-"));
  writeFileSync(join(dir, "graph.yaml"), GRAPH);
  return dir;
}

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
