import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activeRun,
  appendAdvisor,
  appendNode,
  endRun,
  readAdvisorEvents,
  readRunIndex,
  readTrace,
  startRun,
} from "../../src/memory/ledger.js";

describe("run ledger", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = join(tmpdir(), `gk-ledger-${process.pid}-${Date.now()}`);
    mkdirSync(join(cwd, ".graphkit", "runs"), { recursive: true });
    writeFileSync(join(cwd, "graph.yaml"), "metadata:\n  name: demo\ntopology: diamond\n");
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  test("start writes .active, run.md, and empty trace", () => {
    const { id, dir } = startRun(cwd, join(cwd, "graph.yaml"), "2026-09-03T10:00:00.000Z");
    expect(id).toBe("20260903-100000-demo");
    expect(existsSync(join(dir, "run.md"))).toBe(true);
    expect(existsSync(join(dir, "trace.jsonl"))).toBe(true);
    expect(activeRun(cwd)).toBe(dir);
    expect(readFileSync(join(dir, "run.md"), "utf-8")).toContain("# Run 20260903-100000-demo");
  });

  test("second start while active fails", () => {
    startRun(cwd, join(cwd, "graph.yaml"), "2026-09-03T10:00:00.000Z");
    expect(() => startRun(cwd, join(cwd, "graph.yaml"), "2026-09-03T11:00:00.000Z")).toThrow(/RUN_ACTIVE/);
  });

  test("node append without active run fails", () => {
    expect(() =>
      appendNode(cwd, {
        node: "audit",
        wave: 0,
        agent: "code-reviewer",
        model: "sonnet",
        status: "ok",
        evidence: ["audit"],
        duration_ms: 1200,
        notes: null,
      }),
    ).toThrow(/NO_ACTIVE_RUN/);
  });

  test("same timestamp gets a unique id and preserves both traces", () => {
    const timestamp = "2026-09-03T10:00:00.000Z";
    const first = startRun(cwd, join(cwd, "graph.yaml"), timestamp);
    endRun(cwd, "merged", timestamp);
    const second = startRun(cwd, join(cwd, "graph.yaml"), timestamp);
    expect(second.id).toBe(`${first.id}-2`);
    expect(existsSync(join(first.dir, "trace.jsonl"))).toBe(true);
    expect(existsSync(join(second.dir, "trace.jsonl"))).toBe(true);
  });

  test("vanished active directory is treated as no active run", () => {
    const { dir } = startRun(cwd, join(cwd, "graph.yaml"), "2026-09-03T10:00:00.000Z");
    rmSync(dir, { recursive: true, force: true });
    expect(activeRun(cwd)).toBeNull();
    expect(() =>
      appendNode(cwd, {
        node: "x",
        wave: 0,
        agent: null,
        model: null,
        status: "ok",
        evidence: [],
        duration_ms: null,
        notes: null,
      }),
    ).toThrow(/NO_ACTIVE_RUN/);
  });

  test("sanitizes graph names before creating run directories", () => {
    writeFileSync(join(cwd, "graph.yaml"), "metadata:\n  name: ../escaped\ntopology: diamond\n");
    const { id, dir } = startRun(cwd, join(cwd, "graph.yaml"), "2026-09-03T10:00:00.000Z");
    expect(id).not.toContain("../");
    expect(dir.startsWith(join(cwd, ".graphkit", "runs"))).toBe(true);
  });

  test("start → node ×2 → end produces one index line and a readable trace", () => {
    const { id, dir } = startRun(cwd, join(cwd, "graph.yaml"), "2026-09-03T10:00:00.000Z");
    appendNode(
      cwd,
      { node: "a", wave: 0, agent: "x", model: "sonnet", status: "ok", evidence: ["k1"], duration_ms: 10, notes: null },
      "2026-09-03T10:00:01.000Z",
    );
    appendNode(
      cwd,
      { node: "b", wave: 1, agent: "y", model: "opus", status: "fail", evidence: [], duration_ms: 20, notes: "boom" },
      "2026-09-03T10:00:02.000Z",
    );
    const summary = endRun(cwd, "blocked", "2026-09-03T10:05:00.000Z");
    expect(summary.id).toBe(id);
    expect(summary.node_count).toBe(2);
    expect(summary.failures).toBe(1);
    expect(summary.evidence_keys).toEqual(["k1"]);
    expect(activeRun(cwd)).toBeNull();
    expect(readRunIndex(cwd)).toHaveLength(1);
    expect(readTrace(cwd, id).map((t) => t.node)).toEqual(["a", "b"]);
    expect(readFileSync(join(dir, "run.md"), "utf-8")).toContain("- `b` fail");
  });

  test("appendAdvisor writes advisor.jsonl and round-trips", () => {
    const { id } = startRun(cwd, join(cwd, "graph.yaml"), "2026-09-03T10:00:00.000Z");
    const result = appendAdvisor(cwd, { node: "exec", round: 2, tier: "fable", streak: 2 }, "2026-09-03T10:05:00.000Z");
    expect(result.run).toBe(id);
    expect(readAdvisorEvents(cwd, id)).toEqual([
      { at: "2026-09-03T10:05:00.000Z", node: "exec", round: 2, tier: "fable", streak: 2 },
    ]);
  });

  test("appendAdvisor without active run fails", () => {
    expect(() => appendAdvisor(cwd, { node: "x", round: 1, tier: "fable", streak: 1 })).toThrow(/NO_ACTIVE_RUN/);
  });

  test("readAdvisorEvents returns [] when missing", () => {
    expect(readAdvisorEvents(cwd, "nonexistent")).toEqual([]);
  });

  test("readAdvisorEvents ignores corrupt JSONL lines and returns valid events", () => {
    const { id, dir } = startRun(cwd, join(cwd, "graph.yaml"), "2026-09-03T10:00:00.000Z");
    writeFileSync(
      join(dir, "advisor.jsonl"),
      '{"at":"2026-09-03T10:05:00.000Z","node":"exec","round":1,"tier":"fable","streak":1}\n{corrupted line\n{"at":"2026-09-03T10:06:00.000Z","node":"exec","round":2,"tier":"fable","streak":2}\n',
    );
    expect(readAdvisorEvents(cwd, id)).toEqual([
      { at: "2026-09-03T10:05:00.000Z", node: "exec", round: 1, tier: "fable", streak: 1 },
      { at: "2026-09-03T10:06:00.000Z", node: "exec", round: 2, tier: "fable", streak: 2 },
    ]);
  });

  test("startRun with resumes records provenance in meta.json and run.md", () => {
    const first = startRun(cwd, join(cwd, "graph.yaml"), "2026-09-04T10:00:00.000Z");
    endRun(cwd, "failed", "2026-09-04T10:05:00.000Z");
    const second = startRun(cwd, join(cwd, "graph.yaml"), "2026-09-04T11:00:00.000Z", first.id);
    const meta = JSON.parse(readFileSync(join(second.dir, "meta.json"), "utf-8"));
    expect(meta.resumes).toBe(first.id);
    expect(readFileSync(join(second.dir, "run.md"), "utf-8")).toContain(`- resumes: ${first.id}`);
  });
});
