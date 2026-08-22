import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ViewerGraph } from "../../src/viewer/normalize.js";
import { createViewerHarness, flush, type FakeEl } from "../helpers/fake-dom.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const APP_BUNDLE = readFileSync(join(here, "../../kits/claude/viewer/app.js"), "utf8");

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

  test("dragging a node re-routes its incident edges (endpoint translate)", async () => {
    const harness = createViewerHarness(
      APP_BUNDLE,
      graph({
        from: node("from", "x", "sonnet"),
        mid: node("mid", "y", "sonnet", { depend_on: ["from"] }),
        to: node("to", "z", "sonnet", { depend_on: ["mid"] }),
      }),
    );
    await flush();
    const incidentBefore = harness.edge("from", "mid")?.getAttribute("d");
    expect(incidentBefore).toBeTruthy();
    const nonIncidentBefore = harness.edge("mid", "to")?.getAttribute("d");
    expect(nonIncidentBefore).toBeTruthy();

    harness.dragNode("from", 40, 30);
    const incidentAfter = harness.edge("from", "mid")?.getAttribute("d");
    const nonIncidentAfter = harness.edge("mid", "to")?.getAttribute("d");
    expect(incidentAfter).not.toBe(incidentBefore);
    expect(nonIncidentAfter).toBe(nonIncidentBefore);
  });

  test("dragging a target node re-routes all incident edges (both branches)", async () => {
    const harness = createViewerHarness(
      APP_BUNDLE,
      graph({
        a: node("a", "x", "sonnet"),
        mid: node("mid", "y", "sonnet", { depend_on: ["a"] }),
        b: node("b", "z", "sonnet", { depend_on: ["mid"] }),
      }),
    );
    await flush();
    const inAsBefore = harness.edge("a", "mid")?.getAttribute("d");
    const inBBefore = harness.edge("mid", "b")?.getAttribute("d");
    expect(inAsBefore).toBeTruthy();
    expect(inBBefore).toBeTruthy();

    harness.dragNode("mid", 20, 10);
    // mid is the target (w) of a->mid and the source (v) of mid->b
    expect(harness.edge("a", "mid")?.getAttribute("d")).not.toBe(inAsBefore);
    expect(harness.edge("mid", "b")?.getAttribute("d")).not.toBe(inBBefore);
  });

  test("re-route is dropped when a new graph is applied (drag state ephemeral)", async () => {
    const harness = createViewerHarness(
      APP_BUNDLE,
      graph({
        from: node("from", "x", "sonnet"),
        mid: node("mid", "y", "sonnet", { depend_on: ["from"] }),
      }),
    );
    await flush();
    const before = harness.edge("from", "mid")?.getAttribute("d");
    harness.dragNode("from", 40, 30);
    expect(harness.edge("from", "mid")?.getAttribute("d")).not.toBe(before);
    // a fresh graph repaint re-lays-out from scratch — the nudge never persists
    harness.emitUpdate({
      type: "graph",
      graph: graph({
        from: node("from", "x", "sonnet"),
        mid: node("mid", "y", "sonnet", { depend_on: ["from"] }),
      }),
    });
    await flush();
    expect(harness.edge("from", "mid")?.getAttribute("d")).toBe(before);
  });

  test("multi-mousemove drag re-routes edges by the full delta exactly once", async () => {
    const deps = {
      from: node("from", "x", "sonnet"),
      mid: node("mid", "y", "sonnet", { depend_on: ["from"] }),
    };
    const single = createViewerHarness(APP_BUNDLE, graph(deps));
    await flush();
    single.dragNode("from", 40, 30);
    // leading "M x,y" is the dragged endpoint
    const singleXY = single.edge("from", "mid")!.getAttribute("d")!.match(/^M ([\d.]+),([\d.]+)/)!;
    const sx = Number(singleXY[1]);
    const sy = Number(singleXY[2]);

    const steps = createViewerHarness(APP_BUNDLE, graph(deps));
    await flush();
    steps.dragNodeSteps("from", 40, 30, 2);
    const stepsXY = steps.edge("from", "mid")!.getAttribute("d")!.match(/^M ([\d.]+),([\d.]+)/)!;
    const tx = Number(stepsXY[1]);
    const ty = Number(stepsXY[2]);
    // two 20px-moves must equal one 40px-move — the edge endpoint must not
    // compound the cumulative dx per event (regression: rerouteIncidentEdges
    // ADDED the cumulative dx to edge.points, overshooting on every event
    // after the first; a 2-move drag across the same total would land well
    // past the single-move position — far beyond float tolerance).
    expect(Math.abs(tx - sx)).toBeLessThan(1e-6);
    expect(Math.abs(ty - sy)).toBeLessThan(1e-6);
  });

  test("every visible edge has an edge-hit ribbon with pointer-events + aria-hidden", async () => {
    const harness = createViewerHarness(
      APP_BUNDLE,
      graph({ a: node("a", "x", "sonnet"), b: node("b", "y", "opus", { depend_on: ["a"] }) }),
    );
    await flush();
    const path = harness.edge("a", "b");
    expect(path).not.toBeNull();
    const hits = harness.doc.ids.canvas.querySelectorAll("path.edge-hit");
    const hit = hits.find(
      (h) => h.getAttribute("data-from") === "a" && h.getAttribute("data-to") === "b",
    );
    expect(hit).not.toBeNull();
    expect((hit as FakeEl).getAttribute("pointer-events")).toBe("stroke");
    expect((hit as FakeEl).getAttribute("aria-hidden")).toBe("true");
    expect(hit?.getAttribute("d")).toBe(path?.getAttribute("d"));
  });
});
