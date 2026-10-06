import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  activeRun,
  activeRunPointer,
  appendAdvisor,
  appendDispatch,
  appendNode,
  endRun,
  landNode,
  readAdvisorEvents,
  readDispatches,
  readRunIndex,
  readTrace,
  startRun,
} from "../../src/memory/ledger.js";
import { GraphKitError } from "../../src/errors.js";

// Task 2 contract: ledger failures are GraphKitError — codes are the API,
// messages are prose. Assert the code, not the wording.
function expectGkCode(fn: () => unknown, code: string) {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(GraphKitError);
    expect((e as GraphKitError).code).toBe(code);
    return;
  }
  throw new Error(`expected GraphKitError "${code}", but the call resolved`);
}

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
    expectGkCode(() => startRun(cwd, join(cwd, "graph.yaml"), "2026-09-03T11:00:00.000Z"), "RUN_ACTIVE");
  });

  test("node append without active run fails", () => {
    expectGkCode(
      () =>
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
      "NO_ACTIVE_RUN",
    );
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
    expectGkCode(
      () =>
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
      "NO_ACTIVE_RUN",
    );
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
    expectGkCode(() => appendAdvisor(cwd, { node: "x", round: 1, tier: "fable", streak: 1 }), "NO_ACTIVE_RUN");
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

  test("appendDispatch writes dispatch.jsonl; readDispatches round-trips", () => {
    const { id } = startRun(cwd, join(cwd, "graph.yaml"), "2026-09-28T10:00:00.000Z");
    appendDispatch(cwd, { node: "build", attempt: 1, via: "task", pid: null });
    appendDispatch(cwd, { node: "build", attempt: 2, via: "extension", pid: 4242 });
    const rows = readDispatches(cwd, id);
    expect(rows.map((r) => r.attempt)).toEqual([1, 2]);
    expect(rows[1].via).toBe("extension");
  });

  test("appendDispatch without active run fails", () => {
    expectGkCode(() => appendDispatch(cwd, { node: "x", attempt: null, via: "task", pid: null }), "NO_ACTIVE_RUN");
  });

  test("readDispatches on a run with no dispatches returns []", () => {
    const { id } = startRun(cwd, join(cwd, "graph.yaml"), "2026-09-28T10:00:00.000Z");
    expect(readDispatches(cwd, id)).toEqual([]);
  });

  test("landNode stamps landed on the node's ok line", () => {
    const { id } = startRun(cwd, join(cwd, "graph.yaml"), "2026-09-28T10:00:00.000Z");
    appendNode(cwd, {
      node: "build",
      wave: 0,
      agent: null,
      model: null,
      status: "ok",
      evidence: ["k"],
      duration_ms: 1,
      notes: null,
    });
    landNode(cwd, "build", "abc123");
    const last = readTrace(cwd, id).at(-1)!;
    expect(last.landed?.commit).toBe("abc123");
  });

  test("landNode rejects a node with no ok trace line", () => {
    startRun(cwd, join(cwd, "graph.yaml"), "2026-09-28T10:00:00.000Z");
    appendNode(cwd, {
      node: "audit",
      wave: 0,
      agent: null,
      model: null,
      status: "fail",
      evidence: [],
      duration_ms: 1,
      notes: null,
    });
    expectGkCode(() => landNode(cwd, "audit", "abc123"), "LAND_NOT_OK");
    expectGkCode(() => landNode(cwd, "ghost", "abc123"), "LAND_NOT_OK");
  });

  test("second startRun while .active exists fails atomically (EEXIST path)", () => {
    startRun(cwd, join(cwd, "graph.yaml"), "2026-09-28T10:00:00.000Z");
    // Simulate a crash: .active left behind, dir exists
    expectGkCode(() => startRun(cwd, join(cwd, "graph.yaml"), "2026-09-28T11:00:00.000Z"), "RUN_ACTIVE");
  });
  test("startRun clears a dangling .active pointer instead of deadlocking", () => {
    const { dir } = startRun(cwd, join(cwd, "graph.yaml"), "2026-09-03T10:00:00.000Z");
    rmSync(dir, { recursive: true, force: true }); // .active survives, target dir gone
    // Pre-fix this threw RUN_ACTIVE at "(unreadable .active)".
    const started = startRun(cwd, join(cwd, "graph.yaml"), "2026-09-03T11:00:00.000Z");
    expect(activeRun(cwd)).toBe(started.dir);
  });

  test("activeRunPointer distinguishes a dangling pointer from no run", () => {
    expect(activeRunPointer(cwd)).toBeNull();
    const { dir, id } = startRun(cwd, join(cwd, "graph.yaml"), "2026-09-03T10:00:00.000Z");
    expect(activeRunPointer(cwd)).toEqual({ dir, dangling: false });
    rmSync(dir, { recursive: true, force: true });
    expect(activeRunPointer(cwd)).toEqual({ dir, dangling: true });
    expect(basename(activeRunPointer(cwd)!.dir)).toBe(id); // names the dead run
    expect(activeRun(cwd)).toBeNull();
  });
});
