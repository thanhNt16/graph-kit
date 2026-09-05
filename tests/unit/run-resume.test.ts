import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendNode, endRun, startRun } from "../../src/memory/ledger.js";
import { deriveResumeGraph, reconcileRun, resumeRun, validateDerivedGraph } from "../../src/memory/resume.js";
import { GraphSchema } from "../../src/schemas/graph.schema.js";

const GRAPH = `apiVersion: graphkit.dev/v2
kind: Graph
metadata:
  name: demo
topology: custom
nodes:
  a:
    agent: scout
    objective: Do A
    evidence: [a-out]
  b:
    agent: task
    objective: Do B
    depend_on: [a]
    evidence: [b-out]
  c:
    agent: reviewer
    objective: Do C
    depend_on: [b]
`;
let cwd: string;
beforeEach(() => {
  cwd = join(tmpdir(), `gk-resume-${process.pid}-${Date.now()}`);
  mkdirSync(join(cwd, ".graphkit", "runs"), { recursive: true });
  mkdirSync(join(cwd, ".graphkit", "evidence"), { recursive: true });
  writeFileSync(join(cwd, "graph.yaml"), GRAPH);
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));
function writeEvidence(dir: string, key: string, text = "content\n") {
  writeFileSync(join(dir, ".graphkit", "evidence", `${key}.md`), text);
}
function traceOk(dir: string, node: string, evidence: string[]) {
  appendNode(dir, { node, wave: 0, agent: "x", model: null, status: "ok", evidence, duration_ms: 10, notes: null });
}
function traceFail(dir: string, node: string) {
  appendNode(dir, {
    node,
    wave: 0,
    agent: "x",
    model: null,
    status: "fail",
    evidence: [],
    duration_ms: 10,
    notes: null,
  });
}
describe("reconcileRun", () => {
  test("unknown run id throws RESUME_RUN_NOT_FOUND", () => {
    expect(() => reconcileRun(cwd, "20990101-000000-demo")).toThrow(/RESUME_RUN_NOT_FOUND/);
  });
  test("ok + evidence on disk = satisfied; fail = pending; untraced = pending", () => {
    const { id } = startRun(cwd, join(cwd, "graph.yaml"), "2026-09-04T10:00:00.000Z");
    writeEvidence(cwd, "a-out");
    traceOk(cwd, "a", ["a-out"]);
    traceFail(cwd, "b");
    endRun(cwd, "failed", "2026-09-04T10:05:00.000Z");
    const rec = reconcileRun(cwd, id);
    expect(rec.satisfied).toEqual(["a"]);
    expect(rec.pending).toEqual(["b", "c"]);
  });
  test("ok status but evidence file missing → pending", () => {
    const { id } = startRun(cwd, join(cwd, "graph.yaml"), "2026-09-04T10:00:00.000Z");
    traceOk(cwd, "a", ["a-out"]);
    endRun(cwd, "failed", "2026-09-04T10:05:00.000Z");
    expect(reconcileRun(cwd, id).pending).toContain("a");
  });
  test("last trace line wins (loop rounds)", () => {
    const { id } = startRun(cwd, join(cwd, "graph.yaml"), "2026-09-04T10:00:00.000Z");
    traceFail(cwd, "a");
    writeEvidence(cwd, "a-out");
    traceOk(cwd, "a", ["a-out"]);
    endRun(cwd, "failed", "2026-09-04T10:05:00.000Z");
    expect(reconcileRun(cwd, id).satisfied).toEqual(["a"]);
  });
  test("pending closure: dependents of pending are pending even if they passed", () => {
    const { id } = startRun(cwd, join(cwd, "graph.yaml"), "2026-09-04T10:00:00.000Z");
    traceFail(cwd, "a");
    writeEvidence(cwd, "b-out");
    traceOk(cwd, "b", ["b-out"]);
    endRun(cwd, "failed", "2026-09-04T10:05:00.000Z");
    expect(reconcileRun(cwd, id).pending).toEqual(["a", "b", "c"]);
    expect(reconcileRun(cwd, id).skipped).toEqual([]);
  });
  test("graph changed since run → RESUME_GRAPH_DRIFT", () => {
    const { id } = startRun(cwd, join(cwd, "graph.yaml"), "2026-09-04T10:00:00.000Z");
    endRun(cwd, "failed", "2026-09-04T10:05:00.000Z");
    writeFileSync(join(cwd, "graph.yaml"), GRAPH + "# drifted\n");
    expect(() => reconcileRun(cwd, id)).toThrow(/RESUME_GRAPH_DRIFT/);
    expect(() => reconcileRun(cwd, id, { force: true })).not.toThrow();
  });
  test("recorded graph file gone → RESUME_GRAPH_DRIFT", () => {
    const { id } = startRun(cwd, join(cwd, "graph.yaml"), "2026-09-04T10:00:00.000Z");
    endRun(cwd, "failed", "2026-09-04T10:05:00.000Z");
    rmSync(join(cwd, "graph.yaml"));
    expect(() => reconcileRun(cwd, id)).toThrow(/RESUME_GRAPH_DRIFT/);
  });
  test("--from-node selects node + transitive dependents regardless of satisfaction", () => {
    const { id } = startRun(cwd, join(cwd, "graph.yaml"), "2026-09-04T10:00:00.000Z");
    writeEvidence(cwd, "a-out");
    writeEvidence(cwd, "b-out");
    traceOk(cwd, "a", ["a-out"]);
    traceOk(cwd, "b", ["b-out"]);
    endRun(cwd, "merged", "2026-09-04T10:05:00.000Z");
    const rec = reconcileRun(cwd, id, { fromNode: "b" });
    expect(rec.pending).toEqual(["b", "c"]);
    expect(rec.satisfied).toEqual(["a"]);
  });
  test("legacy meta without graph tracking throws", () => {
    const { id, dir } = startRun(cwd, join(cwd, "graph.yaml"), "2026-09-04T10:00:00.000Z");
    writeFileSync(join(dir, "meta.json"), JSON.stringify({ id }));
    expect(() => reconcileRun(cwd, id)).toThrow(/RESUME_RUN_NOT_FOUND/);
  });
  test("fromNode not in graph → RESUME_BAD_FROM_NODE", () => {
    const { id } = startRun(cwd, join(cwd, "graph.yaml"), "2026-09-04T10:00:00.000Z");
    endRun(cwd, "failed", "2026-09-04T10:05:00.000Z");
    expect(() => reconcileRun(cwd, id, { fromNode: "zzz" })).toThrow(/RESUME_BAD_FROM_NODE/);
  });
});

describe("deriveResumeGraph", () => {
  test("pending-only nodes, depend_on stripped to pending set, satisfied dep evidence becomes refs", () => {
    const { id } = startRun(cwd, join(cwd, "graph.yaml"), "2026-09-04T10:00:00.000Z");
    writeEvidence(cwd, "a-out");
    traceOk(cwd, "a", ["a-out"]);
    traceFail(cwd, "b");
    endRun(cwd, "failed", "2026-09-04T10:05:00.000Z");
    const rec = reconcileRun(cwd, id);
    const derived = deriveResumeGraph(rec, id);
    expect(Object.keys(derived.nodes).sort()).toEqual(["b", "c"]);
    expect(derived.metadata.name).toBe("demo-resume");
    expect(derived.nodes.b!.depend_on).toEqual([]);
    expect(derived.nodes.b!.refs).toEqual([
      { path: ".graphkit/evidence/a-out.md", purpose: "resumed evidence from node a (run " + id + ")" },
    ]);
    expect(derived.nodes.c!.depend_on).toEqual(["b"]);
    expect(derived.topology).toBe("custom");
  });
  test("preserves node config verbatim (loop, advisor, fan_out, model, constraints)", () => {
    const graph = GRAPH.replace(
      "  b:\n    agent: task\n    objective: Do B\n",
      "  b:\n    agent: task\n    model: sonnet\n    objective: Do B\n    loop: { enabled: true, max_rounds: 4 }\n    advisor: { model: fable, after_failed_rounds: 2 }\n",
    );
    writeFileSync(join(cwd, "graph.yaml"), graph);
    const { id } = startRun(cwd, join(cwd, "graph.yaml"), "2026-09-04T10:00:00.000Z");
    traceFail(cwd, "a");
    endRun(cwd, "failed", "2026-09-04T10:05:00.000Z");
    const derived = deriveResumeGraph(reconcileRun(cwd, id), id);
    expect(derived.nodes.b!.loop).toEqual({
      enabled: true,
      stop_when: undefined,
      max_rounds: 4,
      exit_condition: undefined,
    });
    expect(derived.nodes.b!.advisor).toEqual({ model: "fable", after_failed_rounds: 2, max_calls: 1 });
  });
  test("derived graph passes GraphSchema", () => {
    const { id } = startRun(cwd, join(cwd, "graph.yaml"), "2026-09-04T10:00:00.000Z");
    traceFail(cwd, "a");
    endRun(cwd, "failed", "2026-09-04T10:05:00.000Z");
    expect(GraphSchema.safeParse(deriveResumeGraph(reconcileRun(cwd, id), id)).success).toBe(true);
  });
  test("fan_out.briefs_from → satisfied target: fan_out dropped, derived schema-valid", () => {
    const graph = GRAPH.replace("    depend_on: [a]\n", "    depend_on: [a]\n    fan_out: { briefs_from: a }\n");
    writeFileSync(join(cwd, "graph.yaml"), graph);
    const { id } = startRun(cwd, join(cwd, "graph.yaml"), "2026-09-04T10:00:00.000Z");
    writeEvidence(cwd, "a-out");
    traceOk(cwd, "a", ["a-out"]);
    traceFail(cwd, "b");
    endRun(cwd, "failed", "2026-09-04T10:05:00.000Z");
    const derived = deriveResumeGraph(reconcileRun(cwd, id), id);
    expect(derived.nodes.b!.fan_out).toBeUndefined();
    expect("fan_out" in derived.nodes.b!).toBe(false);
    expect(GraphSchema.safeParse(derived).success).toBe(true);
  });
  test("fan_out.briefs_from → pending target: fan_out preserved verbatim", () => {
    const graph = GRAPH.replace("    depend_on: [a]\n", "    depend_on: [a]\n    fan_out: { briefs_from: a }\n");
    writeFileSync(join(cwd, "graph.yaml"), graph);
    const { id } = startRun(cwd, join(cwd, "graph.yaml"), "2026-09-04T10:00:00.000Z");
    traceFail(cwd, "a");
    traceFail(cwd, "b");
    endRun(cwd, "failed", "2026-09-04T10:05:00.000Z");
    const derived = deriveResumeGraph(reconcileRun(cwd, id), id);
    expect(derived.nodes.b!.fan_out).toEqual({ briefs_from: "a", template: "{brief.body}" });
  });
  test("loops group split across boundary: nodes filtered to pending, gate_evidence pruned, emptied groups dropped", () => {
    const graph =
      GRAPH +
      "  d:\n    agent: scout\n    objective: Do D\n    evidence: [d-out]\n" +
      'loops:\n  - nodes: [a, b]\n    max_rounds: 3\n    gate_evidence: [a-out, b-out]\n  - nodes: [d]\n    max_rounds: 2\n    gate_evidence: [d-out]\n  - nodes: [c]\n    max_rounds: 2\n    stop_when: "no blockers"\n    gate_evidence: [c-ghost]\n';
    writeFileSync(join(cwd, "graph.yaml"), graph);
    const { id } = startRun(cwd, join(cwd, "graph.yaml"), "2026-09-04T10:00:00.000Z");
    writeEvidence(cwd, "a-out");
    writeEvidence(cwd, "d-out");
    traceOk(cwd, "a", ["a-out"]);
    traceFail(cwd, "b");
    traceOk(cwd, "d", ["d-out"]);
    endRun(cwd, "failed", "2026-09-04T10:05:00.000Z");
    const derived = deriveResumeGraph(reconcileRun(cwd, id), id);
    // group 1 [a,b]: a dropped → [b], a-out pruned; group 2 [d]: emptied → dropped;
    // group 3 [c]: c-ghost undeclared by kept member → gate_evidence field dropped, stop_when keeps group
    expect(derived.loops).toEqual([
      { nodes: ["b"], max_rounds: 3, gate_evidence: ["b-out"] },
      { nodes: ["c"], max_rounds: 2, stop_when: "no blockers" },
    ]);
    expect(GraphSchema.safeParse(derived).success).toBe(true);
  });
  test("evidence.required_keys pruned to keys produced by pending nodes (satisfied keys exist on disk)", () => {
    const graph = GRAPH + "evidence:\n  required_keys: [a-out, b-out]\n";
    writeFileSync(join(cwd, "graph.yaml"), graph);
    const { id } = startRun(cwd, join(cwd, "graph.yaml"), "2026-09-04T10:00:00.000Z");
    writeEvidence(cwd, "a-out");
    traceOk(cwd, "a", ["a-out"]);
    traceFail(cwd, "b");
    endRun(cwd, "failed", "2026-09-04T10:05:00.000Z");
    const derived = deriveResumeGraph(reconcileRun(cwd, id), id);
    expect(derived.evidence.required_keys).toEqual(["b-out"]);
    expect(GraphSchema.safeParse(derived).success).toBe(true);
  });
  test("repro C: eval-gate keeps a pending producer → resume succeeds, derived graph passes compile rules", () => {
    const graph =
      "apiVersion: graphkit.dev/v2\nkind: Graph\nmetadata:\n  name: gate\n" +
      "topology: custom\nevidence:\n  required_keys: [impl-out]\n" +
      "nodes:\n  impl:\n    agent: task\n    objective: Implement\n    evidence: [impl-out]\n" +
      "  gate:\n    agent: reviewer\n    objective: Evaluate\n    role: eval-gate\n    eval: {}\n    depend_on: [impl, research]\n" +
      "  research:\n    agent: scout\n    objective: Research\n";
    writeFileSync(join(cwd, "graph.yaml"), graph);
    const { id } = startRun(cwd, join(cwd, "graph.yaml"), "2026-09-04T10:00:00.000Z");
    writeEvidence(cwd, "impl-out");
    traceOk(cwd, "impl", ["impl-out"]);
    traceFail(cwd, "gate");
    endRun(cwd, "failed", "2026-09-04T10:05:00.000Z");
    const res = resumeRun(cwd, id);
    expect(res.resumed).toBe(true);
    expect(res.pending).toEqual(["gate", "research"]);
    const derived = deriveResumeGraph(reconcileRun(cwd, id), id);
    expect(derived.evidence.required_keys).toEqual([]); // impl-out replayed from disk, not re-produced
    expect(derived.nodes.gate!.depend_on).toEqual(["research"]); // eval-gate keeps a producer
    expect(() => validateDerivedGraph(derived)).not.toThrow();
  });
  test("repro C: eval-gate whose producers are all satisfied → RESUME_DERIVED_INVALID, nothing written", () => {
    const graph =
      "apiVersion: graphkit.dev/v2\nkind: Graph\nmetadata:\n  name: gate2\n" +
      "topology: custom\nevidence:\n  required_keys: [impl-out]\n" +
      "nodes:\n  impl:\n    agent: task\n    objective: Implement\n    evidence: [impl-out]\n" +
      "  gate:\n    agent: reviewer\n    objective: Evaluate\n    role: eval-gate\n    eval: {}\n    depend_on: [impl]\n";
    writeFileSync(join(cwd, "graph.yaml"), graph);
    const { id } = startRun(cwd, join(cwd, "graph.yaml"), "2026-09-04T10:00:00.000Z");
    writeEvidence(cwd, "impl-out");
    traceOk(cwd, "impl", ["impl-out"]);
    traceFail(cwd, "gate");
    endRun(cwd, "failed", "2026-09-04T10:05:00.000Z");
    expect(() => resumeRun(cwd, id)).toThrow(/RESUME_DERIVED_INVALID/);
    expect(existsSync(join(cwd, ".graphkit", "graphs"))).toBe(false);
    expect(existsSync(join(cwd, ".graphkit", "active"))).toBe(false);
  });
});

describe("validateDerivedGraph compile-rule mirror", () => {
  const base = GraphSchema.parse({
    apiVersion: "graphkit.dev/v2",
    kind: "Graph",
    metadata: { name: "demo" },
    topology: "custom",
    nodes: { b: { agent: "task", objective: "B", evidence: ["b-out"] } },
  });
  test("required key produced by no node → evidence-keys", () => {
    const bad = GraphSchema.parse({ ...base, evidence: { required_keys: ["b-out", "ghost"] } });
    expect(() => validateDerivedGraph(bad)).toThrow(
      /RESUME_DERIVED_INVALID.*evidence-keys — Required evidence key "ghost" is not produced by any node/,
    );
    expect(() =>
      validateDerivedGraph(GraphSchema.parse({ ...base, evidence: { required_keys: ["b-out"] } })),
    ).not.toThrow();
  });
  test("eval-gate with empty depend_on → eval-gate-depend_on; non-empty passes", () => {
    const empty = GraphSchema.parse({
      ...base,
      nodes: { b: { agent: "task", objective: "B", evidence: ["b-out"], role: "eval-gate", eval: {}, depend_on: [] } },
    });
    expect(() => validateDerivedGraph(empty)).toThrow(/RESUME_DERIVED_INVALID.*eval-gate-depend_on/);
    const kept = GraphSchema.parse({
      ...base,
      nodes: {
        impl: { agent: "task", objective: "I", evidence: ["impl-out"] },
        gate: { agent: "reviewer", objective: "G", role: "eval-gate", eval: {}, depend_on: ["impl"] },
      },
    });
    expect(() => validateDerivedGraph(kept)).not.toThrow();
  });
  test("memory-augmented with curator node dropped → memory-curator-node", () => {
    const bad = GraphSchema.parse({
      ...base,
      topology: "memory-augmented",
      topology_config: { memory: { curator_node: "curator" } },
    });
    expect(() => validateDerivedGraph(bad)).toThrow(/RESUME_DERIVED_INVALID.*memory-curator-node/);
    const good = GraphSchema.parse({
      ...base,
      topology: "memory-augmented",
      topology_config: { memory: { curator_node: "curator" } },
      nodes: { curator: { agent: "task", objective: "C" } },
    });
    expect(() => validateDerivedGraph(good)).not.toThrow();
  });
});

describe("resumeRun derived-graph gate", () => {
  test("dangling loop node → RESUME_DERIVED_INVALID", () => {
    const base = GraphSchema.parse({
      apiVersion: "graphkit.dev/v2",
      kind: "Graph",
      metadata: { name: "demo" },
      topology: "custom",
      nodes: { b: { agent: "task", objective: "B" } },
    });
    const bad = { ...base, loops: [{ nodes: ["a", "b"], max_rounds: 2, stop_when: "done" }] };
    expect(() => validateDerivedGraph(bad)).toThrow(/RESUME_DERIVED_INVALID.*loop node "a" does not exist/);
    expect(() => validateDerivedGraph(base)).not.toThrow();
  });
  test("gate_evidence key undeclared by loop members → RESUME_DERIVED_INVALID", () => {
    const base = GraphSchema.parse({
      apiVersion: "graphkit.dev/v2",
      kind: "Graph",
      metadata: { name: "demo" },
      topology: "custom",
      nodes: { b: { agent: "task", objective: "B", evidence: ["b-out"] } },
    });
    const bad = { ...base, loops: [{ nodes: ["b"], max_rounds: 2, gate_evidence: ["b-out", "ghost"] }] };
    expect(() => validateDerivedGraph(bad)).toThrow(/RESUME_DERIVED_INVALID.*"ghost" is not declared/);
  });
  test("active run → RUN_ACTIVE before any write", () => {
    const { id } = startRun(cwd, join(cwd, "graph.yaml"), "2026-09-04T10:00:00.000Z");
    traceFail(cwd, "a"); // run stays active (no endRun)
    expect(() => resumeRun(cwd, id)).toThrow(/RUN_ACTIVE/);
    expect(existsSync(join(cwd, ".graphkit", "graphs"))).toBe(false);
    expect(existsSync(join(cwd, ".graphkit", "active"))).toBe(false);
  });
  test("run-not-found resolves before RUN_ACTIVE", () => {
    startRun(cwd, join(cwd, "graph.yaml"), "2026-09-04T10:00:00.000Z");
    expect(() => resumeRun(cwd, "20990101-000000-demo")).toThrow(/RESUME_RUN_NOT_FOUND/);
  });
});
