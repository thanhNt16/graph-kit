import { describe, expect, test } from "bun:test";
import type { ViewerGraph } from "../../src/viewer/normalize.js";
import {
  emphasisIds,
  type Filters,
  injectAssetKeys,
  matchesSearch,
  passesFilters,
  retainedSelection,
  shouldFit,
  visibleNodeIds,
} from "../../src/viewer/view.js";

function node(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "x",
    agent: "Code Reviewer",
    model: "sonnet",
    objective: "do work",
    skills: [],
    tools: [],
    loop: null,
    depend_on: [],
    dependents: [],
    ...over,
  };
}

function graph(nodes: Record<string, ReturnType<typeof node>>): ViewerGraph {
  return {
    name: "g",
    topology: "diamond",
    nodeCount: Object.keys(nodes).length,
    edgeCount: 0,
    nodes: nodes as unknown as ViewerGraph["nodes"],
  };
}

const F: Filters = { model: "", agent: "", loop: false };

describe("matchesSearch", () => {
  test("no query matches everything", () => {
    expect(matchesSearch(node(), "")).toBe(true);
  });
  test("matches id, agent, objective, skills, tools (case-insensitive)", () => {
    const n = node({
      id: "root",
      agent: "Sweet Agent",
      objective: "PLAN the build",
      skills: ["graphify"],
      tools: ["Read"],
    });
    expect(matchesSearch(n, "root")).toBe(true);
    expect(matchesSearch(n, "sweet")).toBe(true);
    expect(matchesSearch(n, "plan")).toBe(true); // objective, case-insensitive
    expect(matchesSearch(n, "graphify")).toBe(true); // skill
    expect(matchesSearch(n, "read")).toBe(true); // tool
    expect(matchesSearch(n, "nosuch")).toBe(false);
  });
});

describe("passesFilters", () => {
  test("model filter", () => {
    expect(passesFilters(node({ model: "opus" }), { ...F, model: "opus" })).toBe(true);
    expect(passesFilters(node({ model: "sonnet" }), { ...F, model: "opus" })).toBe(false);
  });
  test("agent filter", () => {
    expect(passesFilters(node({ agent: "A" }), { ...F, agent: "A" })).toBe(true);
    expect(passesFilters(node({ agent: "B" }), { ...F, agent: "A" })).toBe(false);
  });
  test("loop filter", () => {
    expect(passesFilters(node(), { ...F, loop: true })).toBe(false);
    expect(passesFilters(node({ loop: { enabled: true } }), { ...F, loop: true })).toBe(true);
  });
});

describe("emphasisIds", () => {
  const g = graph({
    root: node({ id: "root", depend_on: [], dependents: ["worker"] }),
    worker: node({ id: "worker", depend_on: ["root"], dependents: [] }),
    other: node({ id: "other", depend_on: [], dependents: [] }),
  });

  test("empty when nothing focused", () => {
    expect(emphasisIds(g, null)).toBeNull();
  });
  test("empty when focus id no longer exists", () => {
    expect(emphasisIds(g, "ghost")).toBeNull();
  });
  test("focus + direct deps + dependents", () => {
    const s = emphasisIds(g, "worker");
    expect(s).not.toBeNull();
    expect([...(s as Set<string>).values()].sort()).toEqual(["root", "worker"]);
  });
  test("unrelated node not emphasized", () => {
    const s = emphasisIds(g, "other");
    expect([...(s as Set<string>).values()]).toEqual(["other"]);
  });
});

describe("retainedSelection", () => {
  test("keeps selection when node still exists", () => {
    expect(retainedSelection("root", graph({ root: node({ id: "root" }) }))).toBe("root");
  });
  test("clears selection when node gone", () => {
    expect(retainedSelection("ghost", graph({ root: node({ id: "root" }) }))).toBeNull();
  });
  test("clears null", () => {
    expect(retainedSelection(null, graph({ root: node({ id: "root" }) }))).toBeNull();
  });
});

describe("shouldFit", () => {
  test("fits only initial load", () => {
    expect(shouldFit(null)).toBe(true);
    expect(shouldFit(graph({ root: node() }))).toBe(false);
  });
});

describe("visibleNodeIds", () => {
  const g = graph({
    a: node({ id: "a", agent: "Agent Alpha" }),
    b: node({ id: "b", agent: "Agent Beta" }),
    c: node({ id: "c", agent: "Agent Gamma" }),
  });
  test("all visible with no query/filters", () => {
    expect(visibleNodeIds(g, "", F).size).toBe(3);
  });
  test("search narrows", () => {
    const s = visibleNodeIds(g, "alpha", F);
    expect([...s]).toEqual(["a"]);
  });
  test("model filter narrows", () => {
    const g2 = graph({ a: node({ id: "a", model: "opus" }), b: node({ id: "b", model: "sonnet" }) });
    const s = visibleNodeIds(g2, "", { ...F, model: "opus" });
    expect([...s]).toEqual(["a"]);
  });
});

describe("injectAssetKeys", () => {
  test("rewrites relative src/href to carry the key", () => {
    const html = `<link rel="stylesheet" href="./styles.css" /><script src="./dagre.js"></script><script src="./app.js"></script>`;
    const out = injectAssetKeys(html, "k123");
    expect(out).toContain('href="./styles.css?key=k123"');
    expect(out).toContain('src="./dagre.js?key=k123"');
    expect(out).toContain('src="./app.js?key=k123"');
  });
  test("uses & when the url already has a query", () => {
    const out = injectAssetKeys('<script src="./app.js?v=1"></script>', "k");
    expect(out).toContain('src="./app.js?v=1&key=k"');
  });
  test("leaves absolute/external urls untouched", () => {
    const out = injectAssetKeys('<a href="https://example.com/x">x</a><script src="//cdn/x.js"></script>', "k");
    expect(out).toContain('href="https://example.com/x"');
    expect(out).toContain('src="//cdn/x.js"');
    expect(out).not.toContain("key=k");
  });
});
