/**
 * Executed browser-behavior tests for the viewer's marching-dash edge flow.
 *
 * The edge `<path>` carries a `stroke-dasharray` presentation attribute plus a
 * `data-dash="flow"` data marker that hooks the CSS edge-flow animation. When a
 * node is hovered, its adjacent edges get the `emph-conn` class (the runtime's
 * existing emphasis marker), which the stylesheet uses to switch the dash march
 * to the faster accent variant.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ViewerGraph } from "../../src/viewer/normalize.js";
import { createViewerHarness, flush } from "../helpers/fake-dom.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const APP_BUNDLE = readFileSync(join(here, "../../kits/claude/viewer/app.js"), "utf8");

function node(id: string, over: Partial<Record<string, unknown>> = {}): unknown {
  const base: Record<string, unknown> = {
    id,
    agent: "Agent Alpha",
    model: "sonnet",
    objective: `objective-${id}`,
    tools: [],
    skills: [],
    refs: [],
    constraints: [],
    loop: null,
    evidence: [],
    depend_on: [],
    dependents: [],
    level: 0,
    order: 0,
  };
  return { ...base, ...over };
}

function graph(name: string, nodes: Record<string, unknown>): ViewerGraph {
  const raw: ViewerGraph["nodes"] = {};
  let edgeCount = 0;
  for (const [id, n] of Object.entries(nodes)) {
    const dep = (n as { depend_on?: string[] }).depend_on || [];
    edgeCount += dep.length;
    raw[id] = { ...(n as object), id, dependents: [] } as ViewerGraph["nodes"][string];
  }
  for (const id of Object.keys(raw)) {
    for (const dep of raw[id].depend_on) {
      if (raw[dep]) raw[dep].dependents.push(id);
    }
  }
  return {
    name,
    topology: "diamond",
    nodeCount: Object.keys(raw).length,
    edgeCount,
    nodes: raw,
  } as ViewerGraph;
}

test("edges carry a dash flow attribute", async () => {
  const harness = createViewerHarness(APP_BUNDLE, graph("g", { a: node("a"), b: node("b", { depend_on: ["a"] }) }));
  await flush();
  const path = harness.edge("a", "b");
  expect(path).not.toBeNull();
  expect(path?.getAttribute("stroke-dasharray")).toBeTruthy();
  expect(path?.getAttribute("data-dash")).toBe("flow");
});

test("emphasized edges switch to the fast-flow variant", async () => {
  const harness = createViewerHarness(APP_BUNDLE, graph("g", { a: node("a"), b: node("b", { depend_on: ["a"] }) }));
  await flush();
  const path = harness.edge("a", "b");
  expect(path?.classList.contains("emph-conn")).toBe(false);
  harness.hoverNode("a");
  expect(path?.classList.contains("emph-conn")).toBe(true);
});

function shiftClickNode(harness: ReturnType<typeof createViewerHarness>, id: string) {
  const g = harness.nodeGroup(id);
  harness.doc.ids.canvas.dispatch("click", { target: g, shiftKey: true });
}

function plainClickNode(harness: ReturnType<typeof createViewerHarness>, id: string) {
  const g = harness.nodeGroup(id);
  harness.doc.ids.canvas.dispatch("click", { target: g, shiftKey: false });
}

test("Shift+click A then Shift+click C traces the route a→b→c", async () => {
  const harness = createViewerHarness(
    APP_BUNDLE,
    graph("g", { a: node("a"), b: node("b", { depend_on: ["a"] }), c: node("c", { depend_on: ["b"] }) }),
  );
  await flush();
  shiftClickNode(harness, "a");
  shiftClickNode(harness, "c");
  expect(harness.nodeGroup("a")?.classList.contains("route")).toBe(true);
  expect(harness.nodeGroup("b")?.classList.contains("route")).toBe(true);
  expect(harness.nodeGroup("c")?.classList.contains("route")).toBe(true);
  expect(harness.edge("a", "b")?.classList.contains("route")).toBe(true);
  expect(harness.edge("b", "c")?.classList.contains("route")).toBe(true);
});

test("active trace clears on plain click", async () => {
  const harness = createViewerHarness(
    APP_BUNDLE,
    graph("g", { a: node("a"), b: node("b", { depend_on: ["a"] }) }),
  );
  await flush();
  shiftClickNode(harness, "a");
  shiftClickNode(harness, "b");
  expect(harness.edge("a", "b")?.classList.contains("route")).toBe(true);
  plainClickNode(harness, "a");
  expect(harness.edge("a", "b")?.classList.contains("route")).toBe(false);
  expect(harness.nodeGroup("a")?.classList.contains("route")).toBe(false);
  // regression: the widened edge-hit ribbon got `.route` too and must release it
  // on clear — otherwise a visible orange line persists on every traced edge
  expect(harness.doc.ids.canvas.querySelectorAll("path.edge-hit.route").length).toBe(0);
});

test("Shift+click traces WITHOUT changing selection or opening the drawer", async () => {
  const harness = createViewerHarness(
    APP_BUNDLE,
    graph("g", { a: node("a"), b: node("b", { depend_on: ["a"] }) }),
  );
  await flush();
  expect(harness.drawerVisible()).toBe(false);
  // Shift+click the node group directly so the node's OWN click listener fires
  // (fake-dom does not bubble, so canvas-dispatched clicks only hit the
  // delegated svg listener). Regression: the node listener called select() for
  // every click, opening the drawer on each trace gesture.
  const groupB = harness.nodeGroup("b");
  groupB!.dispatch("click", { shiftKey: true });
  expect(harness.drawerVisible()).toBe(false);
  expect(harness.doc.ids.canvas.querySelectorAll("g.node-group.selected").length).toBe(0);
  // plain Shift+click gesture still traces through the delegated listener
  shiftClickNode(harness, "a");
  shiftClickNode(harness, "b");
  expect(harness.edge("a", "b")?.classList.contains("route")).toBe(true);
  expect(harness.drawerVisible()).toBe(false);
});
