// tests/unit/patterns.test.ts
import { describe, expect, test } from "bun:test";
import { extractPatterns, patternSalience } from "../../src/memory/patterns.js";
import type { RunIndexLine, TraceLine } from "../../src/memory/ledger.js";

const NOW = "2026-09-03T00:00:00.000Z";

function run(id: string, graph: string, sha: string, keys: string[], at = "2026-09-01T00:00:00.000Z"): RunIndexLine {
  return { id, graph, graph_sha256: sha, started_at: at, ended_at: at, status: "merged", node_count: 0, failures: 0, evidence_keys: keys };
}
function node(n: string, status: "ok" | "fail" = "ok", evidence: string[] = [], at = "2026-09-01T00:00:00.000Z"): TraceLine {
  return { at, node: n, wave: 0, agent: "a", model: "sonnet", status, evidence, duration_ms: 1, notes: null };
}

describe("pattern extraction", () => {
  test("node-sequence needs 3 runs of the same adjacent pair", () => {
    const runs = ["r1", "r2", "r3"].map((id) => run(id, "g", "sha", []));
    const traces = new Map(runs.map((r) => [r.id, [node("plan"), node("build"), node("verify")]]));
    const pats = extractPatterns(runs, traces, NOW).filter((p) => p.kind === "node-sequence");
    const labels = pats.map((p) => p.label);
    expect(labels).toContain("plan → build");
    expect(labels).toContain("plan → build → verify");
  });

  test("a pair seen in only 2 runs is not a pattern", () => {
    const runs = ["r1", "r2"].map((id) => run(id, "g", "sha", []));
    const traces = new Map(runs.map((r) => [r.id, [node("plan"), node("build")]]));
    expect(extractPatterns(runs, traces, NOW).filter((p) => p.kind === "node-sequence")).toHaveLength(0);
  });

  test("evidence keys co-produced in 3 runs become a cooccurrence pattern", () => {
    const runs = ["r1", "r2", "r3"].map((id) => run(id, "g", `sha-${id}`, ["audit", "risk"]));
    const traces = new Map(runs.map((r) => [r.id, [node("a", "ok", ["audit"]), node("b", "ok", ["risk"])]]));
    const pats = extractPatterns(runs, traces, NOW).filter((p) => p.kind === "evidence-cooccurrence");
    expect(pats.map((p) => p.label)).toEqual(["audit + risk"]);
  });

  test("same node failing twice is a failure-recurrence pattern", () => {
    const runs = ["r1", "r2"].map((id) => run(id, "g", `sha-${id}`, []));
    const traces = new Map(runs.map((r) => [r.id, [node("flaky", "fail")]]));
    const pats = extractPatterns(runs, traces, NOW).filter((p) => p.kind === "failure-recurrence");
    expect(pats[0]?.label).toBe("flaky");
    expect(pats[0]?.count).toBe(2);
  });

  test("two failures in one run is not a recurrence; across two runs is", () => {
    const one = ["r1"].map((id) => run(id, "g", `sha-${id}`, []));
    const retry = [node("flaky", "fail"), node("flaky", "fail")];
    expect(extractPatterns(one, new Map([["r1", retry]]), NOW).filter((p) => p.kind === "failure-recurrence")).toHaveLength(0);
    const two = ["r1", "r2"].map((id) => run(id, "g", `sha-${id}`, []));
    const traces = new Map(two.map((r) => [r.id, [node("flaky", "fail")]]));
    const pats = extractPatterns(two, traces, NOW).filter((p) => p.kind === "failure-recurrence");
    expect(pats[0]?.label).toBe("flaky");
    expect(pats[0]?.runs).toEqual(["r1", "r2"]);
  });

  test("same graph sha run 3 times is graph-reuse", () => {
    const runs = ["r1", "r2", "r3"].map((id) => run(id, "audit-pr", "same-sha", []));
    const pats = extractPatterns(runs, new Map(), NOW).filter((p) => p.kind === "graph-reuse");
    expect(pats[0]?.label).toBe("audit-pr");
    expect(pats[0]?.count).toBe(3);
  });

  test("signatures are stable across runs of the extractor", () => {
    const runs = ["r1", "r2", "r3"].map((id) => run(id, "g", "sha", []));
    const traces = new Map(runs.map((r) => [r.id, [node("plan"), node("build")]]));
    const a = extractPatterns(runs, traces, NOW).map((p) => p.signature);
    const b = extractPatterns(runs, traces, NOW).map((p) => p.signature);
    expect(a).toEqual(b);
  });

  test("salience decays with a 14-day half-life", () => {
    const fresh = patternSalience(4, NOW, NOW);
    const old = patternSalience(4, "2026-08-20T00:00:00.000Z", NOW);
    expect(fresh).toBeCloseTo(4, 5);
    expect(old).toBeLessThan(fresh);
    expect(old).toBeGreaterThan(0);
  });
});
