/**
 * Executed browser-behavior tests for the bundled viewer (claude/viewer/app.js).
 *
 * These run the REAL minified IIFE inside node:vm with a purpose-built fake DOM
 * (tests/helpers/fake-dom.ts). They assert live DOM/state transitions, not
 * substring matches — and the retained-selection drawer assertions below FAIL
 * when app.js predates the applyGraph drawer-refresh fix.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ViewerGraph } from "../../src/viewer/normalize.js";
import { createViewerHarness, flush } from "../helpers/fake-dom.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const APP_BUNDLE = readFileSync(join(here, "../../claude/viewer/app.js"), "utf8");

function node(id: string, over: Partial<ViewerNodeShape>): unknown {
  const base: ViewerNodeShape = {
    id,
    agent: "Agent Alpha",
    model: "sonnet",
    objective: `objective-${id}`,
    tools: [`tool-${id}`],
    skills: [`skill-${id}`],
    refs: [],
    constraints: [],
    loop: null,
    evidence: [`ev-${id}`],
    depend_on: [],
    dependents: [],
    level: 0,
    order: 0,
  };
  return { ...base, ...over };
}

type ViewerNodeShape = {
  id: string;
  agent: string;
  model: string;
  objective: string;
  tools: string[];
  skills: string[];
  refs: unknown[];
  constraints: unknown[];
  loop: unknown;
  evidence: string[];
  depend_on: string[];
  dependents: string[];
  level: number;
  order: number;
};

function graph(name: string, nodes: Record<string, unknown>): ViewerGraph {
  const raw: ViewerGraph["nodes"] = {};
  let edgeCount = 0;
  for (const [id, n] of Object.entries(nodes)) {
    const dep = (n as ViewerNodeShape).depend_on || [];
    edgeCount += dep.length;
    raw[id] = { ...(n as ViewerNodeShape), id, dependents: [] };
  }
  // compute reverse edges so emphasisIds sees both directions
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

test("click opens the details drawer and shows the node's fields", async () => {
  const harness = createViewerHarness(
    APP_BUNDLE,
    graph("g", { a: node("a"), b: node("b", { agent: "Agent Beta", depend_on: ["a"] }) }),
  );
  await flush();
  harness.clickNode("b");
  expect(harness.drawerVisible()).toBe(true);
  expect(harness.drawerText()).toContain("Agent Beta");
  expect(harness.drawerText()).toContain("objective-b");
  expect(harness.drawerText()).toContain("a"); // dependency listed
});

test("valid graph update refreshes retained selected-node details", async () => {
  const harness = createViewerHarness(APP_BUNDLE, graph("g", { a: node("a") }));
  await flush();
  harness.clickNode("a");
  expect(harness.drawerText()).toContain("objective-a");

  // update keeps node 'a' but changes its objective — the open drawer must refresh
  harness.emitUpdate({ type: "graph", graph: graph("g", { a: node("a", { objective: "objective-a-NEW" }) }) });
  await flush();
  expect(harness.drawerVisible()).toBe(true);
  expect(harness.drawerText()).toContain("objective-a-NEW");
});

test("selected node removed by update closes the drawer", async () => {
  const harness = createViewerHarness(APP_BUNDLE, graph("g", { a: node("a") }));
  await flush();
  harness.clickNode("a");
  expect(harness.drawerVisible()).toBe(true);

  // update drops node 'a' entirely — drawer must close
  harness.emitUpdate({ type: "graph", graph: graph("g", { b: node("b") }) });
  await flush();
  expect(harness.drawerVisible()).toBe(false);
});

test("keyboard focus emphasizes the focused node's deps and dependents", async () => {
  const harness = createViewerHarness(
    APP_BUNDLE,
    graph("g", {
      a: node("a"),
      b: node("b", { depend_on: ["a"] }),
      c: node("c", { depend_on: ["a"] }),
    }),
  );
  await flush();
  harness.focusNode("a");
  expect(harness.nodeGroup("a")?.classList.contains("emph")).toBe(true);
  expect(harness.nodeGroup("b")?.classList.contains("emph")).toBe(true);
  expect(harness.nodeGroup("c")?.classList.contains("emph")).toBe(true);

  harness.blurNode();
  expect(harness.nodeGroup("a")?.classList.contains("emph")).toBe(false);
});

test("search/filter applies a visible dimming class to non-matching nodes", async () => {
  const harness = createViewerHarness(
    APP_BUNDLE,
    graph("g", { a: node("a", { skills: ["rocket"] }), b: node("b", { skills: ["anchor"] }) }),
  );
  await flush();
  harness.setSearch("rocket");
  expect(harness.nodeGroup("a")?.classList.contains("filtered")).toBe(false);
  expect(harness.nodeGroup("b")?.classList.contains("filtered")).toBe(true);

  // model filter: b is haiku, so picking sonnet dims b and keeps a
  const harness2 = createViewerHarness(
    APP_BUNDLE,
    graph("g", { a: node("a", { model: "sonnet" }), b: node("b", { model: "haiku" }) }),
  );
  await flush();
  harness2.setModelFilter("sonnet");
  expect(harness2.nodeGroup("a")?.classList.contains("filtered")).toBe(false);
  expect(harness2.nodeGroup("b")?.classList.contains("filtered")).toBe(true);
});

test("viewport pan transform survives a graph update (no re-fit)", async () => {
  const harness = createViewerHarness(APP_BUNDLE, graph("g", { a: node("a") }));
  await flush();
  harness.zoomWheel(240); // one zoom-out; sets state.view
  const before = harness.viewportTransform();
  expect(before).not.toBeNull();

  harness.emitUpdate({ type: "graph", graph: graph("g", { a: node("a", { objective: "x" }) }) });
  await flush();
  expect(harness.viewportTransform()).toBe(before);
});

test("graph node text lands as text nodes, not parsed HTML", async () => {
  const evil = '<img src=x onerror=alert(1)> & "hi"';
  const harness = createViewerHarness(APP_BUNDLE, graph("g", { a: node("a", { objective: evil }) }));
  await flush();
  harness.clickNode("a");
  // objective rendered only as text: no <img> element ever created, no onerror
  expect(harness.doc.ids.canvas.querySelectorAll("img").length).toBe(0);
  // drawer body may contain a text node (from render) — but never an img element
  expect(harness.doc.ids["drawer-body"].querySelectorAll("img").length).toBe(0);
});

test("stale banner appears on error update and clears on the next valid graph", async () => {
  const harness = createViewerHarness(APP_BUNDLE, graph("g", { a: node("a") }));
  await flush();
  expect(harness.staleVisible()).toBe(false);

  harness.emitUpdate({ type: "error", message: "boom", path: "graph.yaml" });
  await flush();
  expect(harness.staleVisible()).toBe(true);

  harness.emitUpdate({ type: "graph", graph: graph("g", { a: node("a", { objective: "ok" }) }) });
  await flush();
  expect(harness.staleVisible()).toBe(false);
});
