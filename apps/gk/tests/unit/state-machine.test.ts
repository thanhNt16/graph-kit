import { describe, expect, test } from "bun:test";
import { selectTransition } from "../../src/runtime/state-machine.js";
import type { Run, Workflow } from "../../src/schemas.js";

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    run_id: "r",
    status: "running",
    current_nodes: [],
    pending_items: [],
    in_flight: {},
    iteration: 0,
    failures: 0,
    verdict: null,
    ...overrides,
  };
}

function makeWorkflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    apiVersion: "graphkit.dev/v1alpha1",
    kind: "Workflow",
    metadata: { name: "wf" },
    inputs: {},
    limits: {},
    nodes: {},
    start: "a",
    edges: [],
    terminal: [],
    ...overrides,
  };
}

describe("selectTransition", () => {
  test("sequential edge", () => {
    const wf = makeWorkflow({
      nodes: { a: { id: "a", type: "command", command: ["true"] }, b: { id: "b", type: "command", command: ["true"] } },
      edges: [{ from: "a", to: "b" }],
    });
    expect(selectTransition({ workflow: wf, run: makeRun(), scope: {}, completed: "a" })).toEqual({ next: ["b"] });
  });

  test("conditional edge picks matching branch", () => {
    const wf = makeWorkflow({
      nodes: {
        a: { id: "a", type: "router", routes: [] },
        b: { id: "b", type: "command", command: ["true"] },
        c: { id: "c", type: "command", command: ["true"] },
      },
      edges: [
        { from: "a", to: "b", when: "state.x == 1" },
        { from: "a", to: "c" },
      ],
    });
    expect(selectTransition({ workflow: wf, run: makeRun(), scope: { state: { x: 1 } }, completed: "a" })).toEqual({
      next: ["b"],
    });
    expect(selectTransition({ workflow: wf, run: makeRun(), scope: { state: { x: 9 } }, completed: "a" })).toEqual({
      next: ["c"],
    });
  });

  test("on_error fallback", () => {
    const wf = makeWorkflow({
      nodes: { a: { id: "a", type: "command", command: ["true"] }, b: { id: "b", type: "command", command: ["true"] } },
      edges: [{ from: "a", to: "b", on_error: "b" }],
    });
    expect(selectTransition({ workflow: wf, run: makeRun(), scope: {}, failed: "a" })).toEqual({ next: ["b"] });
  });

  test("bounded retry reroutes to same node", () => {
    const wf = makeWorkflow({
      nodes: { a: { id: "a", type: "command", command: ["true"] } },
      edges: [{ from: "a", to: "a", retry: { max: 3, on: ["failed"] } }],
    });
    const decision = selectTransition({
      workflow: wf,
      run: makeRun({ failures: 1 }),
      scope: {},
      failed: "a",
      verdict: "failed",
    });
    expect(decision).toEqual({ next: ["a"], retry: true });
  });

  test("terminal verdict", () => {
    const wf = makeWorkflow({
      nodes: { a: { id: "a", type: "command", command: ["true"] } },
      terminal: [{ node: "a", verdict: "passed" }],
    });
    expect(selectTransition({ workflow: wf, run: makeRun(), scope: {}, completed: "a" })).toEqual({
      terminal: true,
      verdict: "passed",
    });
  });

  test("refuses to advance past terminal verdict", () => {
    const wf = makeWorkflow({
      nodes: { a: { id: "a", type: "command", command: ["true"] }, b: { id: "b", type: "command", command: ["true"] } },
      edges: [{ from: "a", to: "b" }],
      terminal: [{ node: "a", verdict: "passed" }],
    });
    const run = makeRun({ verdict: "passed" });
    expect(selectTransition({ workflow: wf, run, scope: {}, completed: "a" })).toEqual({
      terminal: true,
      verdict: "passed",
    });
  });

  test("fanout edge routes to multiple targets", () => {
    const wf = makeWorkflow({
      nodes: {
        a: { id: "a", type: "fanout", from: "items", max_workers: 2 },
        b: { id: "b", type: "command", command: ["true"] },
        c: { id: "c", type: "command", command: ["true"] },
      },
      edges: [{ from: "a", to: ["b", "c"] }],
    });
    expect(selectTransition({ workflow: wf, run: makeRun(), scope: {}, completed: "a" })).toEqual({ next: ["b", "c"] });
  });
});
