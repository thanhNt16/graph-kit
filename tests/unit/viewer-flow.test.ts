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
const APP_BUNDLE = readFileSync(join(here, "../../claude/viewer/app.js"), "utf8");

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
