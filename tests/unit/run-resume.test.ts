import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendNode, endRun, startRun } from "../../src/memory/ledger.js";
import { deriveResumeGraph, reconcileRun } from "../../src/memory/resume.js";
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
beforeEach(() => { cwd = join(tmpdir(), `gk-resume-${process.pid}-${Date.now()}`); mkdirSync(join(cwd, ".graphkit", "runs"), { recursive: true }); mkdirSync(join(cwd, ".graphkit", "evidence"), { recursive: true }); writeFileSync(join(cwd, "graph.yaml"), GRAPH); });
afterEach(() => rmSync(cwd, { recursive: true, force: true }));
function writeEvidence(dir: string, key: string, text = "content\n") { writeFileSync(join(dir, ".graphkit", "evidence", `${key}.md`), text); }
function traceOk(dir: string, node: string, evidence: string[]) { appendNode(dir, { node, wave: 0, agent: "x", model: null, status: "ok", evidence, duration_ms: 10, notes: null }); }
function traceFail(dir: string, node: string) { appendNode(dir, { node, wave: 0, agent: "x", model: null, status: "fail", evidence: [], duration_ms: 10, notes: null }); }
describe("reconcileRun", () => {
 test("unknown run id throws RESUME_RUN_NOT_FOUND", () => { expect(() => reconcileRun(cwd, "20990101-000000-demo")).toThrow(/RESUME_RUN_NOT_FOUND/); });
 test("ok + evidence on disk = satisfied; fail = pending; untraced = pending", () => { const { id } = startRun(cwd, join(cwd, "graph.yaml"), "2026-09-04T10:00:00.000Z"); writeEvidence(cwd, "a-out"); traceOk(cwd, "a", ["a-out"]); traceFail(cwd, "b"); endRun(cwd, "failed", "2026-09-04T10:05:00.000Z"); const rec = reconcileRun(cwd, id); expect(rec.satisfied).toEqual(["a"]); expect(rec.pending).toEqual(["b", "c"]); });
 test("ok status but evidence file missing → pending", () => { const { id } = startRun(cwd, join(cwd, "graph.yaml"), "2026-09-04T10:00:00.000Z"); traceOk(cwd, "a", ["a-out"]); endRun(cwd, "failed", "2026-09-04T10:05:00.000Z"); expect(reconcileRun(cwd, id).pending).toContain("a"); });
 test("last trace line wins (loop rounds)", () => { const { id } = startRun(cwd, join(cwd, "graph.yaml"), "2026-09-04T10:00:00.000Z"); traceFail(cwd, "a"); writeEvidence(cwd, "a-out"); traceOk(cwd, "a", ["a-out"]); endRun(cwd, "failed", "2026-09-04T10:05:00.000Z"); expect(reconcileRun(cwd, id).satisfied).toEqual(["a"]); });
 test("pending closure: dependents of pending are pending even if they passed", () => { const { id } = startRun(cwd, join(cwd, "graph.yaml"), "2026-09-04T10:00:00.000Z"); traceFail(cwd, "a"); writeEvidence(cwd, "b-out"); traceOk(cwd, "b", ["b-out"]); endRun(cwd, "failed", "2026-09-04T10:05:00.000Z"); expect(reconcileRun(cwd, id).pending).toEqual(["a", "b", "c"]); expect(reconcileRun(cwd, id).skipped).toEqual([]); });
 test("graph changed since run → RESUME_GRAPH_DRIFT", () => { const { id } = startRun(cwd, join(cwd, "graph.yaml"), "2026-09-04T10:00:00.000Z"); endRun(cwd, "failed", "2026-09-04T10:05:00.000Z"); writeFileSync(join(cwd, "graph.yaml"), GRAPH + "# drifted\n"); expect(() => reconcileRun(cwd, id)).toThrow(/RESUME_GRAPH_DRIFT/); expect(() => reconcileRun(cwd, id, { force: true })).not.toThrow(); });
 test("recorded graph file gone → RESUME_GRAPH_DRIFT", () => { const { id } = startRun(cwd, join(cwd, "graph.yaml"), "2026-09-04T10:00:00.000Z"); endRun(cwd, "failed", "2026-09-04T10:05:00.000Z"); rmSync(join(cwd, "graph.yaml")); expect(() => reconcileRun(cwd, id)).toThrow(/RESUME_GRAPH_DRIFT/); });
 test("--from-node selects node + transitive dependents regardless of satisfaction", () => { const { id } = startRun(cwd, join(cwd, "graph.yaml"), "2026-09-04T10:00:00.000Z"); writeEvidence(cwd, "a-out"); writeEvidence(cwd, "b-out"); traceOk(cwd, "a", ["a-out"]); traceOk(cwd, "b", ["b-out"]); endRun(cwd, "merged", "2026-09-04T10:05:00.000Z"); const rec = reconcileRun(cwd, id, { fromNode: "b" }); expect(rec.pending).toEqual(["b", "c"]); expect(rec.satisfied).toEqual(["a"]); });
 test("legacy meta without graph tracking throws", () => { const { id, dir } = startRun(cwd, join(cwd, "graph.yaml"), "2026-09-04T10:00:00.000Z"); writeFileSync(join(dir, "meta.json"), JSON.stringify({ id })); expect(() => reconcileRun(cwd, id)).toThrow(/RESUME_RUN_NOT_FOUND/); });
 test("fromNode not in graph → RESUME_BAD_FROM_NODE", () => { const { id } = startRun(cwd, join(cwd, "graph.yaml"), "2026-09-04T10:00:00.000Z"); endRun(cwd, "failed", "2026-09-04T10:05:00.000Z"); expect(() => reconcileRun(cwd, id, { fromNode: "zzz" })).toThrow(/RESUME_BAD_FROM_NODE/); });
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
    expect(derived.nodes.b!.refs).toEqual([{ path: ".graphkit/evidence/a-out.md", purpose: "resumed evidence from node a (run " + id + ")" }]);
    expect(derived.nodes.c!.depend_on).toEqual(["b"]);
    expect(derived.topology).toBe("custom");
  });
  test("preserves node config verbatim (loop, advisor, fan_out, model, constraints)", () => {
    const graph = GRAPH.replace("  b:\n    agent: task\n    objective: Do B\n", "  b:\n    agent: task\n    model: sonnet\n    objective: Do B\n    loop: { enabled: true, max_rounds: 4 }\n    advisor: { model: fable, after_failed_rounds: 2 }\n");
    writeFileSync(join(cwd, "graph.yaml"), graph);
    const { id } = startRun(cwd, join(cwd, "graph.yaml"), "2026-09-04T10:00:00.000Z");
    traceFail(cwd, "a"); endRun(cwd, "failed", "2026-09-04T10:05:00.000Z");
    const derived = deriveResumeGraph(reconcileRun(cwd, id), id);
    expect(derived.nodes.b!.loop).toEqual({ enabled: true, stop_when: undefined, max_rounds: 4, exit_condition: undefined });
    expect(derived.nodes.b!.advisor).toEqual({ model: "fable", after_failed_rounds: 2, max_calls: 1 });
  });
  test("derived graph passes GraphSchema", () => {
    const { id } = startRun(cwd, join(cwd, "graph.yaml"), "2026-09-04T10:00:00.000Z");
    traceFail(cwd, "a"); endRun(cwd, "failed", "2026-09-04T10:05:00.000Z");
    expect(GraphSchema.safeParse(deriveResumeGraph(reconcileRun(cwd, id), id)).success).toBe(true);
  });
});
