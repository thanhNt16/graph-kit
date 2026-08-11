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

describe("viewer node drag", () => {
  test("dragging a node updates its group transform", async () => {
    const harness = createViewerHarness(
      APP_BUNDLE,
      graph({
        a: node("a", "x", "sonnet"),
        b: node("b", "y", "opus", { depend_on: ["a"] }),
      }),
    );
    await flush();
    const before = harness.nodeTransform("a");
    harness.dragNode("a", 30, 40);
    const after = harness.nodeTransform("a");
    expect(after).not.toBe(before);
  });

  test("dragging a node does not pan the viewport", async () => {
    const harness = createViewerHarness(APP_BUNDLE, graph({ a: node("a", "x", "sonnet") }));
    await flush();
    const vpBefore = harness.viewportTransform();
    harness.dragNode("a", 30, 40);
    expect(harness.viewportTransform()).toBe(vpBefore);
  });

  test("drag deltas are divided by the viewport zoom (k)", async () => {
    const harness = createViewerHarness(APP_BUNDLE, graph({ a: node("a", "x", "sonnet") }));
    await flush();
    // Zoom out once so state.view.k != 1; read the exact k from the viewport.
    harness.zoomWheel(240); // deltaY > 0 -> zoomBy(1/1.1)
    const vp = harness.viewportTransform()!;
    const km = /scale\(([\d.]+)\)/.exec(vp);
    expect(km).not.toBeNull();
    const k = Number(km![1]);
    expect(k).not.toBe(1);

    const start = harness.nodeTransform("a") ?? "";
    const sm = /translate\((-?[\d.]+)\s+(-?[\d.]+)\)/.exec(start);
    const tx0 = sm ? Number(sm[1]) : 0;
    const ty0 = sm ? Number(sm[2]) : 0;

    harness.dragNode("a", 30, 40);
    const expected = `translate(${tx0 + 30 / k} ${ty0 + 40 / k})`;
    expect(harness.nodeTransform("a")).toBe(expected);
  });
});
