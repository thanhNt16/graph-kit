import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cac } from "cac";
import { liveDispatchPids, registerRunCommands } from "../../src/cli/commands/run.js";
import {
  appendDispatch,
  appendNode,
  type DispatchLine,
  endRun,
  landNode,
  readTrace,
  startRun,
} from "../../src/memory/ledger.js";
import { reconcileRun, resumeRun } from "../../src/memory/resume.js";

const GRAPH_YAML =
  "apiVersion: graphkit.dev/v2\nkind: Graph\nmetadata:\n  name: demo\ntopology: custom\nnodes:\n  a:\n    agent: scout\n    objective: A\n  b:\n    agent: task\n    objective: B\n    depend_on: [a]\n";

function runCli(args: string[], cwd: string) {
  const cli = cac("gk");
  registerRunCommands(cli);
  const logs: string[] = [];
  const origLog = console.log;
  const origCwd = process.cwd();
  const origExit = process.exit;
  let exitCode = 0;
  console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  process.exit = (c?: number) => {
    exitCode = c ?? 1;
  };
  process.chdir(cwd);
  try {
    cli.parse(["node", "gk", ...args], { run: true });
  } finally {
    console.log = origLog;
    process.exit = origExit;
    process.chdir(origCwd);
  }
  const code = process.exitCode ? Number(process.exitCode) : exitCode;
  process.exitCode = 0; // fail() paths set process.exitCode=1 — reset so bun:test exits 0
  return { stdout: logs.join("\n"), code };
}

const dispatchLine = (pid: number | null): DispatchLine => ({
  at: "2026-09-28T00:00:00.000Z",
  node: "a",
  attempt: null,
  via: "task",
  pid,
});

function traceOk(dir: string, node: string, evidence: string[]) {
  appendNode(dir, { node, wave: 0, agent: "x", model: null, status: "ok", evidence, duration_ms: 10, notes: null });
}

describe("phantom node guards (UNKNOWN_NODE)", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = join(tmpdir(), `gk-guards-node-${process.pid}-${Date.now()}`);
    mkdirSync(join(cwd, ".graphkit", "runs"), { recursive: true });
    writeFileSync(join(cwd, "graph.yaml"), GRAPH_YAML);
    runCli(["run", "start"], cwd);
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  test("run node rejects an id absent from the active run's graph", () => {
    const out = JSON.parse(runCli(["run", "node", "zz", "--status", "ok"], cwd).stdout) as {
      status: string;
      error: { code: string; message: string; details?: { available: string[] } };
    };
    expect(out.status).toBe("fail");
    expect(out.error.code).toBe("UNKNOWN_NODE");
    expect(out.error.message).toContain("node 'zz' not in graph");
    expect(out.error.message).toContain(join(cwd, "graph.yaml"));
    expect(out.error.details?.available).toEqual(["a", "b"]);
    expect(runCli(["run", "node", "zz", "--status", "ok"], cwd).code).toBe(1);
  });

  test("run land rejects an unknown id before touching the ledger", () => {
    const out = JSON.parse(runCli(["run", "land", "zz", "--commit", "abc123"], cwd).stdout) as {
      status: string;
      error: { code: string };
    };
    expect(out.status).toBe("fail");
    expect(out.error.code).toBe("UNKNOWN_NODE");
  });

  test("run dispatch rejects an unknown id", () => {
    const out = JSON.parse(runCli(["run", "dispatch", "zz"], cwd).stdout) as {
      status: string;
      error: { code: string };
    };
    expect(out.status).toBe("fail");
    expect(out.error.code).toBe("UNKNOWN_NODE");
  });

  test("known ids still trace, and --graph resolves against the given file", () => {
    expect(JSON.parse(runCli(["run", "node", "a", "--status", "ok"], cwd).stdout).status).toBe("ok");
    const alt = join(cwd, "alt.yaml");
    writeFileSync(alt, GRAPH_YAML);
    expect(JSON.parse(runCli(["run", "node", "a", "--status", "ok", "--graph", alt], cwd).stdout).status).toBe("ok");
    // Rename the node AND its depend_on references: renaming only the node orphans b's
    // dependency and SCHEMA_INVALID fires before the UNKNOWN_NODE guard under test.
    writeFileSync(alt, GRAPH_YAML.replace("  a:\n", "  only:\n").replace("depend_on: [a]", "depend_on: [only]"));
    expect(JSON.parse(runCli(["run", "node", "a", "--status", "ok", "--graph", alt], cwd).stdout).error.code).toBe(
      "UNKNOWN_NODE",
    );
  });

  test("legacy runs without a recorded graph skip validation instead of guessing", () => {
    const dir = join(cwd, ".graphkit", "runs");
    const active = readFileSync(join(dir, ".active"), "utf-8").trim();
    const meta = JSON.parse(readFileSync(join(active, "meta.json"), "utf-8")) as Record<string, unknown>;
    delete meta.graph_path;
    delete meta.graph_sha256;
    writeFileSync(join(active, "meta.json"), JSON.stringify(meta, null, 2));
    // One-resolver contract: a resolvable root would now be trusted. Strip it so
    // nothing resolves (NO_ACTIVE_GRAPH) and the node command skips validation.
    rmSync(join(cwd, "graph.yaml"));
    expect(JSON.parse(runCli(["run", "node", "zz", "--status", "ok"], cwd).stdout).status).toBe("ok");
  });
});

describe("dispatch pid hygiene", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = join(tmpdir(), `gk-guards-pid-${process.pid}-${Date.now()}`);
    mkdirSync(join(cwd, ".graphkit", "runs"), { recursive: true });
    writeFileSync(join(cwd, "graph.yaml"), GRAPH_YAML);
    startRun(cwd, join(cwd, "graph.yaml"), "2026-09-04T10:00:00.000Z");
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  test("appendDispatch rejects pid <= 0 and non-integers with BAD_PID", () => {
    for (const pid of [0, -3, 1.5, Number("nope")]) {
      expect(() => appendDispatch(cwd, { node: "a", attempt: null, via: "task", pid })).toThrow(/BAD_PID/);
    }
    expect(() => appendDispatch(cwd, { node: "a", attempt: null, via: "task", pid: 4242 })).not.toThrow();
    expect(() => appendDispatch(cwd, { node: "a", attempt: null, via: "task", pid: null })).not.toThrow();
  });

  test("the dispatch CLI surfaces BAD_PID for junk --pid values", () => {
    // Dash-prefixed values ("-1") never reach the handler: cac's checkUnknownOptions
    // rejects them as unknown flags at parse time. appendDispatch has no upper bound,
    // so only non-positive / non-integer / non-numeric junk surfaces BAD_PID here.
    for (const pid of ["0", "1.5", "abc"]) {
      const out = JSON.parse(runCli(["run", "dispatch", "a", "--pid", pid], cwd).stdout) as {
        status: string;
        error: { code: string };
      };
      expect(out.status).toBe("fail");
      expect(out.error.code).toBe("BAD_PID");
    }
  });
});

describe("take liveness (EPERM alive, ESRCH dead)", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = join(tmpdir(), `gk-guards-take-${process.pid}-${Date.now()}`);
    mkdirSync(join(cwd, ".graphkit", "runs"), { recursive: true });
    writeFileSync(join(cwd, "graph.yaml"), GRAPH_YAML);
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  test("liveDispatchPids counts unsignalable pids as alive and skips junk", () => {
    const dispatches = [dispatchLine(100), dispatchLine(200), dispatchLine(0), dispatchLine(-5), dispatchLine(null)];
    // Injected checker: 100 behaves like an EPERM target (alive, unpermitted), 200 like ESRCH.
    expect(liveDispatchPids(dispatches, (pid) => pid === 100)).toEqual([100]);
  });

  test("real kernel: pid 1 is alive (EPERM as non-root, success as root), a reaped pid is dead", () => {
    expect(liveDispatchPids([dispatchLine(1)])).toEqual([1]);
    const dead = Bun.spawnSync(["true"]).pid; // already exited: ESRCH
    expect(liveDispatchPids([dispatchLine(dead)])).toEqual([]);
    expect(liveDispatchPids([dispatchLine(process.pid)])).toEqual([]); // own pid excluded
  });

  test("take refuses takeover while a live foreign pid is recorded", () => {
    const r = startRun(cwd, join(cwd, "graph.yaml"), "2026-09-04T10:00:00.000Z");
    runCli(["run", "dispatch", "a", "--pid", "1"], cwd); // pid 1: alive on every unix, EPERM for non-root
    const take = JSON.parse(runCli(["run", "take", "--from", r.id], cwd).stdout) as {
      status: string;
      error: { code: string; message: string };
    };
    expect(take.status).toBe("fail");
    expect(take.error.code).toBe("TAKEOVER_BLOCKED");
    expect(take.error.message).toContain("1");
  });

  test("take ignores non-positive and unparseable pids in stored intents", () => {
    const r = startRun(cwd, join(cwd, "graph.yaml"), "2026-09-04T10:00:00.000Z");
    // Legacy junk appendDispatch now rejects at write time; seed the file directly.
    appendFileSync(
      join(r.dir, "dispatch.jsonl"),
      `${JSON.stringify(dispatchLine(0))}\n${JSON.stringify(dispatchLine(-7))}\n`,
    );
    const take = JSON.parse(runCli(["run", "take", "--from", r.id], cwd).stdout) as { status: string };
    expect(take.status).toBe("ok");
  });
});

describe("land guards", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = join(tmpdir(), `gk-guards-land-${process.pid}-${Date.now()}`);
    mkdirSync(join(cwd, ".graphkit", "runs"), { recursive: true });
    writeFileSync(join(cwd, "graph.yaml"), GRAPH_YAML);
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  test("landNode refuses when the node's LATEST trace is fail, even with an earlier ok", () => {
    const { id } = startRun(cwd, join(cwd, "graph.yaml"), "2026-09-04T10:00:00.000Z");
    traceOk(cwd, "a", []);
    appendNode(cwd, {
      node: "a",
      wave: 1,
      agent: null,
      model: null,
      status: "fail",
      evidence: [],
      duration_ms: 1,
      notes: null,
    });
    expect(() => landNode(cwd, "a", "abc123")).toThrow(/LAND_NOT_OK/);
    expect(() => landNode(cwd, "a", "abc123")).toThrow(/"fail", not ok/);
    // A later ok round makes the node landable again.
    traceOk(cwd, "a", []);
    landNode(cwd, "a", "abc123");
    expect(readTrace(cwd, id).at(-1)?.landed).toMatchObject({ commit: "abc123" });
  });

  test("landNode validates the commit is a hex sha (BAD_COMMIT)", () => {
    startRun(cwd, join(cwd, "graph.yaml"), "2026-09-04T10:00:00.000Z");
    traceOk(cwd, "a", []);
    for (const bad of ["zzzz", "abc", "nodeA-wt", "g".repeat(41)]) {
      expect(() => landNode(cwd, "a", bad)).toThrow(/BAD_COMMIT/);
    }
    // 4-char short sha and full 40-char sha are both accepted.
    expect(() => landNode(cwd, "a", "1234")).not.toThrow();
    expect(() => landNode(cwd, "a", "1234567890abcdef1234567890abcdef12345678")).not.toThrow();
  });

  test("the land CLI surfaces BAD_COMMIT as an envelope", () => {
    startRun(cwd, join(cwd, "graph.yaml"), "2026-09-04T10:00:00.000Z");
    runCli(["run", "node", "a", "--status", "ok"], cwd);
    const out = JSON.parse(runCli(["run", "land", "a", "--commit", "nothex!"], cwd).stdout) as {
      status: string;
      error: { code: string };
    };
    expect(out.status).toBe("fail");
    expect(out.error.code).toBe("BAD_COMMIT");
    expect(runCli(["run", "land", "a", "--commit", "nothex!"], cwd).code).toBe(1);
  });
});

describe("take reconciliation payload", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = join(tmpdir(), `gk-guards-foreign-${process.pid}-${Date.now()}`);
    mkdirSync(join(cwd, ".graphkit", "runs"), { recursive: true });
    mkdirSync(join(cwd, ".graphkit", "evidence"), { recursive: true });
    writeFileSync(join(cwd, "graph.yaml"), GRAPH_YAML);
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  function writeMarker(key: string, runId: string) {
    const fm = [`key: ${key}`, `run_id: ${runId}`, "node: x"].join("\n");
    writeFileSync(join(cwd, ".graphkit", "evidence", `${key}.md`), `---\n${fm}\n---\n\ncontent\n`);
  }

  test("take reports foreign_evidence instead of dropping it", () => {
    const { id: other } = startRun(cwd, join(cwd, "graph.yaml"), "2026-09-04T08:00:00.000Z");
    endRun(cwd, "failed", "2026-09-04T08:05:00.000Z");
    const { id } = startRun(cwd, join(cwd, "graph.yaml"), "2026-09-04T10:00:00.000Z");
    writeMarker("a-out", other);
    traceOk(cwd, "a", ["a-out"]);
    const take = JSON.parse(runCli(["run", "take", "--from", id], cwd).stdout) as {
      status: string;
      data: { foreign_evidence: Array<{ node: string; key: string; marker_run_id: string }> };
    };
    expect(take.status).toBe("ok");
    expect(take.data.foreign_evidence).toEqual([{ node: "a", key: "a-out", marker_run_id: other }]);
  });
});

describe("run start graph resolution", () => {
  let cwd: string;
  beforeEach(() => {
    // realpath the fixture cwd: process.cwd() canonicalizes symlinks on macOS
    // (/var/... → /private/var/...), so meta.json stores the canonical path.
    cwd = realpathSync(mkdirSync(join(tmpdir(), `gk-guards-start-${process.pid}-${Date.now()}`), { recursive: true })!);
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  function seedSessionGraph(id: string) {
    mkdirSync(join(cwd, ".graphkit", "graphs"), { recursive: true });
    writeFileSync(join(cwd, ".graphkit", "graphs", `${id}.yaml`), GRAPH_YAML);
    writeFileSync(join(cwd, ".graphkit", "active"), id);
  }

  function startedMetaGraphPath(args: string[]): string {
    const started = JSON.parse(runCli(args, cwd).stdout) as { status: string; data: { dir: string } };
    expect(started.status).toBe("ok");
    const meta = JSON.parse(readFileSync(join(started.data.dir, "meta.json"), "utf-8")) as { graph_path: string };
    return meta.graph_path;
  }

  test("falls back to the session's active graph when graph.yaml is absent", () => {
    seedSessionGraph("2026-09-28-sessgraph");
    expect(startedMetaGraphPath(["run", "start"])).toBe(join(cwd, ".graphkit", "graphs", "2026-09-28-sessgraph.yaml"));
  });

  test("session pointer beats ./graph.yaml (SB F2); explicit --graph wins over both", () => {
    seedSessionGraph("2026-09-28-sessgraph");
    writeFileSync(join(cwd, "graph.yaml"), GRAPH_YAML);
    expect(startedMetaGraphPath(["run", "start"])).toBe(
      join(cwd, ".graphkit", "graphs", "2026-09-28-sessgraph.yaml"),
    );
    endRun(cwd, "failed", "2026-09-04T10:05:00.000Z");
    const alt = join(cwd, "alt.yaml");
    writeFileSync(alt, GRAPH_YAML);
    expect(startedMetaGraphPath(["run", "start", "--graph", alt])).toBe(alt);
  });

  test("dangling session pointer fails with ACTIVE_POINTER_DANGLING", () => {
    seedSessionGraph("2026-09-28-gone");
    rmSync(join(cwd, ".graphkit", "graphs", "2026-09-28-gone.yaml"));
    const out = JSON.parse(runCli(["run", "start"], cwd).stdout) as {
      status: string;
      error: { code: string; message: string };
    };
    expect(out.status).toBe("fail");
    expect(out.error.code).toBe("ACTIVE_POINTER_DANGLING");
    expect(out.error.message).toContain("2026-09-28-gone");
  });

  test("no graph.yaml, no pointer, no active run fails with NO_ACTIVE_GRAPH", () => {
    const out = JSON.parse(runCli(["run", "start"], cwd).stdout) as { status: string; error: { code: string } };
    expect(out.status).toBe("fail");
    expect(out.error.code).toBe("NO_ACTIVE_GRAPH");
  });
});

describe("resume graph + reason guards", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = join(tmpdir(), `gk-guards-resume-${process.pid}-${Date.now()}`);
    mkdirSync(join(cwd, ".graphkit", "runs"), { recursive: true });
    mkdirSync(join(cwd, ".graphkit", "evidence"), { recursive: true });
    writeFileSync(join(cwd, "graph.yaml"), GRAPH_YAML);
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  test("deleted recorded graph: drift guard without --force, coded GRAPH_FILE_NOT_FOUND with it", () => {
    const { id } = startRun(cwd, join(cwd, "graph.yaml"), "2026-09-04T10:00:00.000Z");
    endRun(cwd, "failed", "2026-09-04T10:05:00.000Z");
    rmSync(join(cwd, "graph.yaml"));
    expect(() => reconcileRun(cwd, id)).toThrow(/RESUME_GRAPH_DRIFT/);
    expect(() => reconcileRun(cwd, id, { force: true })).toThrow(/GRAPH_FILE_NOT_FOUND/);
    expect(() => reconcileRun(cwd, id, { force: true })).toThrow(/take --from/);
  });

  test("skip reason is accurate when a node passed without declaring evidence", () => {
    const { id } = startRun(cwd, join(cwd, "graph.yaml"), "2026-09-04T10:00:00.000Z");
    traceOk(cwd, "a", []); // ok, no --evidence
    writeFileSync(join(cwd, ".graphkit", "evidence", "b-out.md"), "content\n");
    traceOk(cwd, "b", ["b-out"]);
    endRun(cwd, "failed", "2026-09-04T10:05:00.000Z");
    const out = resumeRun(cwd, id, { dryRun: true });
    expect(out.skipped).toContainEqual({ node: "a", reason: "passed (no evidence declared)" });
    expect(out.skipped).toContainEqual({ node: "b", reason: "passed with evidence on disk" });
  });
});
