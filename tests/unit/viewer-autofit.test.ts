import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ViewerGraph } from "../../src/viewer/normalize.js";
import { createViewerHarness, flush } from "../helpers/fake-dom.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const APP_BUNDLE = readFileSync(join(here, "../../claude/viewer/app.js"), "utf8");

function node(id: string, agent: string, model: string, over: Record<string, unknown> = {}): unknown {
  return {
    id,
    agent,
    model,
    objective: "",
    depend_on: [],
    dependents: [],
    skills: [],
    tools: [],
    refs: [],
    constraints: [],
    loop: null,
    evidence: [],
    level: 0,
    order: 0,
    ...over,
  };
}

function graph(nodes: Record<string, unknown>): ViewerGraph {
  const raw: ViewerGraph["nodes"] = {};
  let edgeCount = 0;
  for (const [id, n] of Object.entries(nodes)) {
    const dep = (n as { depend_on: string[] }).depend_on || [];
    edgeCount += dep.length;
    raw[id] = { ...(n as object), id, dependents: [] } as ViewerGraph["nodes"][string];
  }
  for (const id of Object.keys(raw)) {
    for (const dep of (raw[id] as unknown as { depend_on: string[] }).depend_on) {
      if (raw[dep]) (raw[dep] as unknown as { dependents: string[] }).dependents.push(id);
    }
  }
  return {
    name: "g",
    topology: "diamond",
    nodeCount: Object.keys(raw).length,
    edgeCount,
    nodes: raw,
  } as ViewerGraph;
}

describe("viewer auto-fit", () => {
  test("long node content gets a wider card than short content", async () => {
    const harness = createViewerHarness(
      APP_BUNDLE,
      graph({
        a: node("a", "x", "sonnet"),
        "a-very-long-identifier-that-definitely-overflows": node(
          "a-very-long-identifier-that-definitely-overflows",
          "code-reviewer",
          "opus",
        ),
      }),
    );
    await flush();
    const short = harness.nodeRectWidth("a");
    const long = harness.nodeRectWidth("a-very-long-identifier-that-definitely-overflows");
    expect(long).toBeGreaterThan(short);
  });

  test("re-measure only when content changes (cached size reused)", async () => {
    const harness = createViewerHarness(
      APP_BUNDLE,
      graph({
        a: node("a", "x", "sonnet"),
        b: node("b", "y", "opus", { depend_on: ["a"] }),
      }),
    );
    await flush();
    const w1 = harness.nodeRectWidth("b");
    // Same content, re-render: cached size must be reused (identical width).
    harness.emitUpdate({
      type: "graph",
      graph: graph({
        a: node("a", "x", "sonnet"),
        b: node("b", "y", "opus", { depend_on: ["a"] }),
      }),
    });
    await flush();
    expect(harness.nodeRectWidth("b")).toBe(w1);
  });
});
