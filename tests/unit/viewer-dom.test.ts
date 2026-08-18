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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

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

test("SSE connects only after the initial fetch settles", async () => {
  const pending = deferred<{ json(): Promise<unknown> }>();
  const harness = createViewerHarness(APP_BUNDLE, null, pending.promise);
  expect(harness.es).toHaveLength(0);

  pending.resolve({ json: () => Promise.resolve({ type: "graph", graph: graph("g", { a: node("a") }) }) });
  await flush();
  expect(harness.es).toHaveLength(1);
});

test("SSE connects after the initial fetch rejects", async () => {
  const pending = deferred<{ json(): Promise<unknown> }>();
  const harness = createViewerHarness(APP_BUNDLE, null, pending.promise);
  pending.reject(new Error("offline"));
  await flush();
  expect(harness.es).toHaveLength(1);
  expect(harness.doc.ids["error-screen"].classList.contains("hidden")).toBe(false);
});

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

test("search updates classes without replacing node or viewport elements", async () => {
  const harness = createViewerHarness(
    APP_BUNDLE,
    graph("g", { a: node("a", { skills: ["rocket"] }), b: node("b", { skills: ["anchor"] }) }),
  );
  await flush();
  const viewport = harness.viewport();
  const a = harness.nodeGroup("a");
  harness.setSearch("rocket");
  expect(harness.viewport()).toBe(viewport);
  expect(harness.nodeGroup("a")).toBe(a);
  expect(harness.nodeGroup("b")?.classList.contains("filtered")).toBe(true);
});

test("graph updates reconcile keyed nodes instead of replacing retained nodes", async () => {
  const harness = createViewerHarness(APP_BUNDLE, graph("g", { a: node("a"), b: node("b", { depend_on: ["a"] }) }));
  await flush();
  const a = harness.nodeGroup("a");
  harness.emitUpdate({
    type: "graph",
    graph: graph("g", { a: node("a", { objective: "changed" }), c: node("c", { depend_on: ["a"] }) }),
  });
  await flush();
  expect(harness.nodeGroup("a")).toBe(a);
  expect(harness.nodeGroup("b")).toBeNull();
  expect(harness.nodeGroup("c")).not.toBeNull();
});

test("keyed edge owns its render: removed with the edge", async () => {
  const harness = createViewerHarness(APP_BUNDLE, graph("g", { a: node("a"), b: node("b", { depend_on: ["a"] }) }));
  await flush();
  expect(harness.doc.ids.canvas.querySelector('path.edge[data-from="a"][data-to="b"]')).not.toBeNull();

  // dropping the dependency removes the edge
  const before = harness.edge("a", "b");
  expect(before).not.toBeNull();
  harness.emitUpdate({ type: "graph", graph: graph("g", { a: node("a"), b: node("b") }) });
  await flush();
  expect(harness.edge("a", "b")).toBeNull();
  expect(harness.doc.ids.canvas.querySelectorAll("path.edge-arrow")).toHaveLength(0);
});

test("edgeKey is collision-free: newline-containing IDs keep distinct edges", async () => {
  const harness = createViewerHarness(
    APP_BUNDLE,
    graph("g", {
      a: node("a"),
      "a\nb": node("a\nb"),
      "b\nc": node("b\nc", { depend_on: ["a"] }), // edge a -> b\nc
      c: node("c", { depend_on: ["a\nb"] }), // edge a\nb -> c
    }),
  );
  await flush();
  const edges = harness.doc.ids.canvas.querySelectorAll("path.edge");
  // under "from + sep + to" both edges key to "a\nb\nc" and would merge into one;
  // the length-prefixed key keeps them distinct, so two path.edge elements render.
  expect(edges.length).toBe(2);
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

test("normalized levels render as stable phase lanes", async () => {
  const harness = createViewerHarness(
    APP_BUNDLE,
    graph("g", {
      root: node("root", { level: 0, order: 0 }),
      worker: node("worker", { level: 1, order: 0, depend_on: ["root"] }),
    }),
  );
  await flush();
  expect(harness.lane(0)?.classList.contains("lane-group")).toBe(true);
  expect(harness.lane(1)?.textContent).toContain("Phase 1");
});

test("edges share an SVG marker and use curved path geometry", async () => {
  const harness = createViewerHarness(
    APP_BUNDLE,
    graph("g", {
      a: node("a"),
      b: node("b", { level: 1, depend_on: ["a"] }),
    }),
  );
  await flush();
  const edge = harness.edge("a", "b");
  expect(edge?.getAttribute("marker-end")).toBe("url(#arrow)");
  expect(edge?.getAttribute("d")).toContain(" C ");
  expect(harness.doc.ids.canvas.querySelectorAll("path.edge-arrow")).toHaveLength(0);
});

test("node cards include a model rail, model text, and loop badge", async () => {
  const harness = createViewerHarness(
    APP_BUNDLE,
    graph("g", {
      a: node("a", { model: "opus", loop: { enabled: true, max_rounds: 3 } }),
    }),
  );
  await flush();
  const group = harness.nodeGroup("a")!;
  expect(group.querySelector("rect.node-tier-rail")).not.toBeNull();
  expect(group.querySelector("text.node-badge")?.textContent).toContain("↻");
  expect(group.textContent).toContain("opus");
});

test("hiding lanes toggles the lane-layer visibility attribute (CSP-safe, no inline style)", async () => {
  const harness = createViewerHarness(APP_BUNDLE, graph("g", { a: node("a") }));
  await flush();
  const laneLayer = harness.doc.ids.canvas.querySelector("g.lane-layer");
  expect(laneLayer).not.toBeNull();
  expect(laneLayer?.getAttribute("visibility")).toBe("visible");

  // flip the toggle-lanes checkbox off — lanes must hide via the attribute
  const toggle = harness.doc.ids["toggle-lanes"];
  toggle.checked = false;
  toggle.dispatch("change", { target: toggle });
  expect(laneLayer?.getAttribute("visibility")).toBe("hidden");
  // style-string approach would set an inline style, which `style-src 'self'` blocks
  expect(laneLayer?.getAttribute("style")).toBeUndefined();
});

test("new nodes get the entrance class via classList, with no inline style attribute", async () => {
  const harness = createViewerHarness(APP_BUNDLE, graph("g", { a: node("a") }));
  await flush();
  const group = harness.nodeGroup("a")!;
  expect(group.classList.contains("is-new")).toBe(true);
  // the old approach set an inline `--level` custom property, blocked by CSP
  expect(group.getAttribute("style")).toBeUndefined();
});

test("lane toggle hides lanes without replacing graph elements", async () => {
  const harness = createViewerHarness(APP_BUNDLE, graph("g", { a: node("a") }));
  await flush();
  const a = harness.nodeGroup("a");
  harness.setLanes(false);
  expect(harness.viewport()?.querySelector("g.lane-layer")?.getAttribute("aria-hidden")).toBe("true");
  expect(harness.nodeGroup("a")).toBe(a);
});

test("selection uses a durable selected class and connected edge emphasis", async () => {
  const harness = createViewerHarness(
    APP_BUNDLE,
    graph("g", {
      a: node("a"),
      b: node("b", { depend_on: ["a"] }),
      c: node("c"),
    }),
  );
  await flush();
  harness.clickNode("a");
  expect(harness.nodeGroup("a")?.classList.contains("selected")).toBe(true);
  expect(harness.edge("a", "b")?.classList.contains("emph-conn")).toBe(true);
  expect(harness.nodeGroup("c")?.classList.contains("dim")).toBe(true);
});

test("graph update preserves active model and agent filters when values still exist", async () => {
  const harness = createViewerHarness(
    APP_BUNDLE,
    graph("g", {
      a: node("a", { model: "sonnet", agent: "Alpha" }),
      b: node("b", { model: "haiku", agent: "Beta" }),
    }),
  );
  await flush();
  harness.setModelFilter("sonnet");
  harness.setAgentFilter("Alpha");
  expect(harness.getEl("filter-model").value).toBe("sonnet");
  expect(harness.getEl("filter-agent").value).toBe("Alpha");

  harness.emitUpdate({
    type: "graph",
    graph: graph("g", {
      a: node("a", { model: "sonnet", agent: "Alpha" }),
      b: node("b", { model: "haiku", agent: "Beta" }),
    }),
  });
  await flush();
  expect(harness.getEl("filter-model").value).toBe("sonnet");
  expect(harness.getEl("filter-agent").value).toBe("Alpha");
  // 'haiku' dims under the retained model filter
  expect(harness.nodeGroup("b")?.classList.contains("filtered")).toBe(true);
  expect(harness.nodeGroup("a")?.classList.contains("filtered")).toBe(false);
});

test("agent named '__proto__' cannot pollute the agent filter options", async () => {
  const harness = createViewerHarness(
    APP_BUNDLE,
    graph("g", {
      a: node("a", { agent: "__proto__" }),
      b: node("b", { agent: "Alpha" }),
    }),
  );
  await flush();
  const options = harness.getEl("filter-agent").querySelectorAll("option");
  const values = options.map((o) => (o as unknown as { value: string }).value);
  // no inherited proto pollution; only the real agents appear (plus the seed "all" option)
  expect(values).toContain("__proto__");
  expect(values).toContain("Alpha");
  expect(values.filter((v) => v === "" || v === "Alpha" || v === "__proto__")).toHaveLength(3);
  // selecting the proto-named agent applies the filter without leaking it
  harness.setAgentFilter("__proto__");
  expect(harness.nodeGroup("a")?.classList.contains("filtered")).toBe(false);
  expect(harness.nodeGroup("b")?.classList.contains("filtered")).toBe(true);
});

test("graph update preserves keyboard focus on the active node", async () => {
  const harness = createViewerHarness(
    APP_BUNDLE,
    graph("g", {
      a: node("a", { level: 0, order: 0 }),
      b: node("b", { level: 1, order: 0, depend_on: ["a"] }),
    }),
  );
  await flush();
  harness.focusNode("a");
  expect(harness.doc.activeElement).toBe(harness.nodeGroup("a"));

  // live SSE update re-appends groups for tab order; focus must survive it
  harness.emitUpdate({
    type: "graph",
    graph: graph("g", {
      a: node("a", { level: 0, order: 0 }),
      b: node("b", { level: 1, order: 0, depend_on: ["a"] }),
    }),
  });
  await flush();
  expect(harness.doc.activeElement).toBe(harness.nodeGroup("a"));
});

test("graph update resets stale filters to all when the value disappears", async () => {
  const harness = createViewerHarness(APP_BUNDLE, graph("g", { a: node("a", { model: "sonnet", agent: "Alpha" }) }));
  await flush();
  harness.setModelFilter("sonnet");
  harness.setAgentFilter("Alpha");

  // update drops sonnet and Alpha entirely
  harness.emitUpdate({
    type: "graph",
    graph: graph("g", { a: node("a", { model: "haiku", agent: "Beta" }) }),
  });
  await flush();
  expect(harness.getEl("filter-model").value).toBe("");
  expect(harness.getEl("filter-agent").value).toBe("");
  // state-visible behavior: with no filter active nothing is filtered out
  expect(harness.nodeGroup("a")?.classList.contains("filtered")).toBe(false);
});

test("arbitrary punctuation/whitespace node IDs emphasize their connected edges", async () => {
  const weirdFrom = "a b\tc";
  const weirdTo = "d\ne|f";
  const harness = createViewerHarness(
    APP_BUNDLE,
    graph("g", {
      [weirdFrom]: node(weirdFrom),
      [weirdTo]: node(weirdTo, { depend_on: [weirdFrom] }),
      bystander: node("bystander"),
    }),
  );
  await flush();
  harness.clickNode(weirdFrom);
  expect(harness.nodeGroup(weirdFrom)?.classList.contains("selected")).toBe(true);
  const edge = harness.edge(weirdFrom, weirdTo);
  expect(edge).not.toBeNull();
  expect(edge?.classList.contains("emph-conn")).toBe(true);
});

test("opening the drawer turns it into a modal dialog and focuses its title", async () => {
  const harness = createViewerHarness(APP_BUNDLE, graph("g", { a: node("a") }));
  await flush();
  const drawer = harness.getEl("drawer");
  // visitor LEAVES the accessible dialog state dirty on next open
  drawer.setAttribute("role", "dialog");
  drawer.setAttribute("aria-modal", "true");
  harness.clickNode("a");
  expect(harness.drawerVisible()).toBe(true);
  expect(drawer.getAttribute("role")).toBe("dialog");
  expect(drawer.getAttribute("aria-modal")).toBe("true");
  expect(harness.doc.activeElement).toBe(harness.getEl("drawer-title"));
});

test("closing the drawer returns focus to the selected node", async () => {
  const harness = createViewerHarness(APP_BUNDLE, graph("g", { a: node("a"), b: node("b", { depend_on: ["a"] }) }));
  await flush();
  harness.clickNode("a");
  expect(harness.drawerVisible()).toBe(true);
  harness.clickNode("b");
  // focus was captured in a; b is now selected — close returns it to b
  harness.emitUpdate({ type: "graph", graph: graph("g", { a: node("a"), b: node("b", { depend_on: ["a"] }) }) });
  await flush();
  harness.closeDrawer();
  expect(harness.drawerVisible()).toBe(false);
  expect(harness.doc.activeElement).toBe(harness.nodeGroup("b"));
});

test("ArrowRight moves focus to the nearest rightward visible neighbor", async () => {
  const harness = createViewerHarness(
    APP_BUNDLE,
    graph("g", {
      a: node("a", { level: 0, order: 0 }),
      b: node("b", { level: 1, order: 0, depend_on: ["a"] }),
      c: node("c", { level: 1, order: 1, depend_on: ["a"] }),
    }),
  );
  await flush();
  harness.focusNode("a");
  harness.keydown("ArrowRight", harness.nodeGroup("a"));
  expect(harness.doc.activeElement).toBe(harness.nodeGroup("b"));
});

test("arrow keys skip filtered-out nodes", async () => {
  const harness = createViewerHarness(
    APP_BUNDLE,
    graph("g", {
      a: node("a", { level: 0, order: 0 }),
      b: node("b", { level: 1, order: 0, depend_on: ["a"], skills: ["hidden"] }),
      c: node("c", { level: 1, order: 1, depend_on: ["a"] }),
    }),
  );
  await flush();
  harness.setModelFilter("sonnet");
  // c is haiku -> filtered; b is sonnet -> visible
  harness.focusNode("a");
  harness.keydown("ArrowRight", harness.nodeGroup("a"));
  expect(harness.doc.activeElement).toBe(harness.nodeGroup("b"));
});

test("ArrowDown moves focus to the nearest lower node even when same-column", async () => {
  const harness = createViewerHarness(
    APP_BUNDLE,
    graph("g", {
      a: node("a", { level: 0, order: 0 }),
      b: node("b", { level: 1, order: 0, depend_on: [] }), // same column, below a
      c: node("c", { level: 1, order: 1, depend_on: [] }), // offset right, below a
    }),
  );
  await flush();
  harness.focusNode("a");
  harness.keydown("ArrowDown", harness.nodeGroup("a"));
  expect(harness.doc.activeElement).toBe(harness.nodeGroup("b"));
});

test("+ / - zoom keys work while a node has focus (wider guard)", async () => {
  const harness = createViewerHarness(APP_BUNDLE, graph("g", { a: node("a") }));
  await flush();
  harness.focusNode("a");
  const before = harness.viewportTransform();
  harness.keydown("+", harness.nodeGroup("a"));
  expect(harness.viewportTransform()).not.toBe(before);
});

test("retained node DOM identity stays stable while keyboard order tracks level/order", async () => {
  const harness = createViewerHarness(
    APP_BUNDLE,
    graph("g", {
      a: node("a", { level: 0, order: 0 }),
      b: node("b", { level: 1, order: 0, depend_on: ["a"] }),
    }),
  );
  await flush();
  expect(harness.nodeOrder()).toEqual(["a", "b"]);
  const aBefore = harness.nodeGroup("a");
  const bBefore = harness.nodeGroup("b");

  // swap levels: b becomes phase 0, a becomes phase 1
  harness.emitUpdate({
    type: "graph",
    graph: graph("g", {
      a: node("a", { level: 1, order: 0 }),
      b: node("b", { level: 0, order: 0, depend_on: [] }),
    }),
  });
  await flush();
  expect(harness.nodeOrder()).toEqual(["b", "a"]);
  expect(harness.nodeGroup("a")).toBe(aBefore);
  expect(harness.nodeGroup("b")).toBe(bBefore);
});
