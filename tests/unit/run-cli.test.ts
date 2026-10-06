import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cac } from "cac";
import YAML from "yaml";
import { registerRunCommands } from "../../src/cli/commands/run.js";
import { GraphKitError } from "../../src/errors.js";

import { appendNode, endRun, readAdvisorEvents, readTrace, stampTakeover, startRun } from "../../src/memory/ledger.js";

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

describe("gk run CLI", () => {
  test("registers a single `run` command with subcommand dispatch", () => {
    const cli = cac("gk");
    registerRunCommands(cli);
    expect(cli.commands.map((c) => c.name)).toContain("run");
  });

  test("executes run start, status, node, end lifecycle", () => {
    const cwd = join(tmpdir(), `gk-run-cli-${process.pid}-${Date.now()}`);
    mkdirSync(cwd, { recursive: true });
    try {
      // 1. Initial status -> inactive
      const initialStatus = JSON.parse(runCli(["run", "status"], cwd).stdout);
      expect(initialStatus).toEqual({
        status: "ok",
        data: { active: null, active_age_ms: null, advisor_events: 0, resumes_chain: [] },
      });

      // 2. Start run without anything resolvable fails with NO_ACTIVE_GRAPH
      const startFail = JSON.parse(runCli(["run", "start"], cwd).stdout);
      expect(startFail.status).toBe("fail");
      expect(startFail.error.code).toBe("NO_ACTIVE_GRAPH");
      // 3. Start valid run with graph.yaml
      writeFileSync(
        join(cwd, "graph.yaml"),
        "apiVersion: graphkit.dev/v2\nkind: Graph\nmetadata:\n  name: test-graph\ntopology: custom\nnodes:\n  review:\n    agent: code-reviewer\n    objective: review changes\n",
      );
      const startOk = JSON.parse(runCli(["run", "start"], cwd).stdout);
      expect(startOk.status).toBe("ok");
      expect(startOk.data.id).toMatch(/test-graph$/);
      const metaFile = JSON.parse(readFileSync(join(startOk.data.dir, "meta.json"), "utf-8"));
      expect(metaFile.fingerprint).toEqual({ head: null, tree: null }); // tmp cwd is not a git repo

      // 4. Status returns active run directory
      const activeStatus = JSON.parse(runCli(["run", "status"], cwd).stdout);
      expect(activeStatus.status).toBe("ok");
      expect(activeStatus.data.active).toBe(startOk.data.dir);

      // 5. Node requires node id
      const missingNode = JSON.parse(runCli(["run", "node", "--status", "ok"], cwd).stdout);
      expect(missingNode.status).toBe("fail");
      expect(missingNode.error.code).toBe("MISSING_ARG");

      // 6. Node requires status ok|fail
      const badNodeStatus = JSON.parse(runCli(["run", "node", "review"], cwd).stdout);
      expect(badNodeStatus.status).toBe("fail");
      expect(badNodeStatus.error.code).toBe("BAD_STATUS");

      // 7. Node append succeeds
      const nodeOk = JSON.parse(
        runCli(
          [
            "run",
            "node",
            "review",
            "--status",
            "ok",
            "--wave",
            "1",
            "--agent",
            "reviewer",
            "--model",
            "claude-3-7",
            "--evidence",
            "cov,lint",
            "--duration-ms",
            "1500",
            "--notes",
            "all passed",
          ],
          cwd,
        ).stdout,
      );
      expect(nodeOk.status).toBe("ok");
      expect(nodeOk.data.run).toBe(startOk.data.id);
      expect(nodeOk.data.node).toBe("review");

      // 8. End run requires valid status
      const badEndStatus = JSON.parse(runCli(["run", "end", "--status", "invalid"], cwd).stdout);
      expect(badEndStatus.status).toBe("fail");
      expect(badEndStatus.error.code).toBe("BAD_STATUS");

      // 9. End run succeeds
      const endOk = JSON.parse(runCli(["run", "end", "--status", "merged"], cwd).stdout);
      expect(endOk.status).toBe("ok");
      expect(endOk.data.status).toBe("merged");
      expect(endOk.data.node_count).toBe(1);
      expect(endOk.data.failures).toBe(0);
      expect(endOk.data.evidence_keys).toEqual(["cov", "lint"]);

      // 10. Status returns null after end
      const finalStatus = JSON.parse(runCli(["run", "status"], cwd).stdout);
      expect(finalStatus).toEqual({
        status: "ok",
        data: { active: null, active_age_ms: null, advisor_events: 0, resumes_chain: [] },
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("handles unknown subcommand", () => {
    const cwd = join(tmpdir(), `gk-run-unknown-${process.pid}-${Date.now()}`);
    mkdirSync(cwd, { recursive: true });
    try {
      const res = JSON.parse(runCli(["run", "foo"], cwd).stdout);
      expect(res.status).toBe("fail");
      expect(res.error.code).toBe("UNKNOWN_RUN_SUBCOMMAND");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("handles no subcommand help", () => {
    const cwd = join(tmpdir(), `gk-run-none-${process.pid}-${Date.now()}`);
    mkdirSync(cwd, { recursive: true });
    try {
      const res = runCli(["run"], cwd);
      expect(res.stdout).toContain("gk run — run ledger commands");
      expect(res.stdout).toContain("dispatch  <node> --via task|extension [--pid N] [--attempt N]");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("run node --advisor-fired records event with tier from graph", () => {
    const cwd = join(tmpdir(), `gk-run-advisor-${process.pid}-${Date.now()}`);
    mkdirSync(cwd, { recursive: true });
    try {
      writeFileSync(
        join(cwd, "graph.yaml"),
        [
          "apiVersion: graphkit.dev/v2",
          "kind: Graph",
          "metadata:",
          "  name: advisor-graph",
          "topology: diamond",
          "nodes:",
          "  exec:",
          "    agent: haiku",
          "    objective: do the thing",
          "    loop: { enabled: true }",
          "    advisor: { model: opus }",
        ].join("\n"),
      );
      const start = JSON.parse(runCli(["run", "start"], cwd).stdout);
      expect(start.status).toBe("ok");
      const fired = JSON.parse(runCli(["run", "node", "exec", "--advisor-fired", "2", "--streak", "2"], cwd).stdout);
      expect(fired.status).toBe("ok");
      expect(fired.data.event).toEqual({ at: expect.any(String), node: "exec", round: 2, tier: "opus", streak: 2 });
      expect(readAdvisorEvents(cwd, start.data.id)).toEqual([
        { at: expect.any(String), node: "exec", round: 2, tier: "opus", streak: 2 },
      ]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("run node --advisor-fired on node without advisor fails BAD_ADVISOR", () => {
    const cwd = join(tmpdir(), `gk-run-noadv-${process.pid}-${Date.now()}`);
    mkdirSync(cwd, { recursive: true });
    try {
      writeFileSync(
        join(cwd, "graph.yaml"),
        [
          "apiVersion: graphkit.dev/v2",
          "kind: Graph",
          "metadata:",
          "  name: plain-graph",
          "topology: diamond",
          "nodes:",
          "  plain:",
          "    agent: haiku",
          "    objective: do the thing",
        ].join("\n"),
      );
      JSON.parse(runCli(["run", "start"], cwd).stdout);
      const fired = JSON.parse(runCli(["run", "node", "plain", "--advisor-fired", "1"], cwd).stdout);
      expect(fired.status).toBe("fail");
      expect(fired.error.code).toBe("BAD_ADVISOR");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("run node --advisor-fired on graph with unknown key fails SCHEMA_INVALID", () => {
    const cwd = join(tmpdir(), `gk-run-badkey-${process.pid}-${Date.now()}`);
    mkdirSync(cwd, { recursive: true });
    try {
      writeFileSync(
        join(cwd, "graph.yaml"),
        [
          "apiVersion: graphkit.dev/v2",
          "kind: Graph",
          "metadata:",
          "  name: typo-graph",
          "polic_ref: true",
          "topology: diamond",
          "nodes:",
          "  exec:",
          "    agent: haiku",
          "    objective: do the thing",
          "    advisor: { model: opus }",
        ].join("\n"),
      );
      const fired = JSON.parse(runCli(["run", "node", "exec", "--advisor-fired", "1"], cwd).stdout);
      expect(fired.status).toBe("fail");
      expect(fired.error.code).toBe("SCHEMA_INVALID");
      // Task 2 envelope: the offending key lives in details.issues, not the message.
      expect(JSON.stringify(fired.error.details.issues)).toContain("polic_ref");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("run status includes advisor_events count", () => {
    const cwd = join(tmpdir(), `gk-run-status-${process.pid}-${Date.now()}`);
    mkdirSync(cwd, { recursive: true });
    try {
      writeFileSync(
        join(cwd, "graph.yaml"),
        [
          "apiVersion: graphkit.dev/v2",
          "kind: Graph",
          "metadata:",
          "  name: count-graph",
          "topology: diamond",
          "nodes:",
          "  exec:",
          "    agent: haiku",
          "    objective: do the thing",
          "    loop: { enabled: true }",
          "    advisor: { model: opus }",
        ].join("\n"),
      );
      JSON.parse(runCli(["run", "start"], cwd).stdout);
      const before = JSON.parse(runCli(["run", "status"], cwd).stdout);
      expect(before).toEqual({
        status: "ok",
        data: {
          active: expect.any(String),
          active_age_ms: expect.any(Number),
          advisor_events: 0,
          resumes_chain: [expect.any(String)],
        },
      });
      runCli(["run", "node", "exec", "--advisor-fired", "1"], cwd);
      const after = JSON.parse(runCli(["run", "status"], cwd).stdout);
      expect(after.status).toBe("ok");
      expect(after.data.advisor_events).toBe(1);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("run node --advisor-fired rejects non-integer and non-positive --streak", () => {
    const cwd = join(tmpdir(), `gk-run-streak-${process.pid}-${Date.now()}`);
    mkdirSync(cwd, { recursive: true });
    try {
      writeFileSync(
        join(cwd, "graph.yaml"),
        [
          "apiVersion: graphkit.dev/v2",
          "kind: Graph",
          "metadata:",
          "  name: streak-graph",
          "topology: diamond",
          "nodes:",
          "  exec:",
          "    agent: haiku",
          "    objective: do the thing",
          "    loop: { enabled: true }",
          "    advisor: { model: opus }",
        ].join("\n"),
      );
      JSON.parse(runCli(["run", "start"], cwd).stdout);
      for (const bad of ["abc", "0", "1.5"]) {
        const res = JSON.parse(runCli(["run", "node", "exec", "--advisor-fired", "1", "--streak", bad], cwd).stdout);
        expect(res.status).toBe("fail");
        expect(res.error.code).toBe("BAD_ADVISOR");
        expect(res.error.message).toContain("--streak requires an integer >= 1");
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("run node --advisor-fired derives tier from the active run's recorded graph", () => {
    const cwd = join(tmpdir(), `gk-run-recorded-${process.pid}-${Date.now()}`);
    mkdirSync(cwd, { recursive: true });
    try {
      // cwd/graph.yaml carries a DIFFERENT tier: if the CLI read it instead of the
      // run's recorded alt.yaml, the assertion on tier: "sonnet" would fail.
      writeFileSync(join(cwd, "graph.yaml"), "metadata:\n  name: main-graph\ntopology: diamond\n");
      writeFileSync(
        join(cwd, "alt.yaml"),
        [
          "apiVersion: graphkit.dev/v2",
          "kind: Graph",
          "metadata:",
          "  name: alt-graph",
          "topology: diamond",
          "nodes:",
          "  exec:",
          "    agent: haiku",
          "    objective: do the thing",
          "    loop: { enabled: true }",
          "    advisor: { model: sonnet }",
        ].join("\n"),
      );
      const start = JSON.parse(runCli(["run", "start", "--graph", "alt.yaml"], cwd).stdout);
      expect(start.status).toBe("ok");
      const fired = JSON.parse(runCli(["run", "node", "exec", "--advisor-fired", "1"], cwd).stdout);
      expect(fired.status).toBe("ok");
      expect(fired.data.event).toEqual({
        at: expect.any(String),
        node: "exec",
        round: 1,
        tier: "sonnet",
        streak: null,
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("run status reports the resumes chain", () => {
    const cwd = join(tmpdir(), `gk-run-resume-status-${process.pid}-${Date.now()}`);
    mkdirSync(cwd, { recursive: true });
    try {
      writeFileSync(join(cwd, "graph.yaml"), "metadata:\n  name: demo\ntopology: diamond\n");
      const r1 = JSON.parse(runCli(["run", "start"], cwd).stdout).data;
      runCli(["run", "end", "--status", "failed"], cwd);
      const { startRun } = require("../../src/memory/ledger.js");
      startRun(cwd, join(cwd, "graph.yaml"), "2026-09-04T11:00:00.000Z", r1.id);
      const parsed = JSON.parse(runCli(["run", "status", "--json"], cwd).stdout);
      expect(parsed.status).toBe("ok");
      expect(parsed.data.resumes_chain).toEqual(["20260904-110000-demo", r1.id]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("run round records rounds and reports no_progress exhaustion", () => {
    const cwd = join(tmpdir(), `gk-run-round-${process.pid}-${Date.now()}`);
    mkdirSync(cwd, { recursive: true });
    try {
      writeFileSync(
        join(cwd, "graph.yaml"),
        [
          "apiVersion: graphkit.dev/v2",
          "kind: Graph",
          "metadata:",
          "  name: round-graph",
          "topology: diamond",
          "nodes:",
          "  implement:",
          "    agent: haiku",
          "    objective: write code",
          "  test:",
          "    agent: haiku",
          "    objective: run tests",
          "loops:",
          "  - nodes: [implement, test]",
          "    max_rounds: 4",
          "    stop_when: tests pass",
          "    no_progress_limit: 2",
        ].join("\n"),
      );
      JSON.parse(runCli(["run", "start"], cwd).stdout);
      for (let i = 0; i < 2; i++) {
        runCli(["run", "node", "implement", "--status", "fail"], cwd);
        runCli(["run", "node", "test", "--status", "fail"], cwd);
      }
      const r1 = JSON.parse(runCli(["run", "round", "0"], cwd).stdout);
      expect(r1.status).toBe("ok");
      expect(r1.data).toMatchObject({ round: 1, repeated: 1, no_progress_exhausted: false, stop_reason: null });
      runCli(["run", "node", "implement", "--status", "fail"], cwd);
      runCli(["run", "node", "test", "--status", "fail"], cwd);
      const r2 = JSON.parse(runCli(["run", "round", "0"], cwd).stdout);
      expect(r2.data).toMatchObject({ round: 2, repeated: 2, no_progress_exhausted: true, stop_reason: "no_progress" });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("run round rejects bad group index", () => {
    const cwd = join(tmpdir(), `gk-run-round-bad-${process.pid}-${Date.now()}`);
    mkdirSync(cwd, { recursive: true });
    try {
      JSON.parse(runCli(["run", "start"], cwd).stdout);
      const res = runCli(["run", "round", "x"], cwd);
      expect(res.code).toBe(1);
      expect(JSON.parse(res.stdout).error.code).toBe("BAD_ARG");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("run resume CLI", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = join(tmpdir(), `gk-resume-${process.pid}-${Date.now()}`);
    mkdirSync(join(cwd, ".graphkit", "runs"), { recursive: true });
    mkdirSync(join(cwd, ".graphkit", "evidence"), { recursive: true });
    mkdirSync(join(cwd, ".graphkit", "graphs"), { recursive: true });
    writeFileSync(
      join(cwd, "graph.yaml"),
      `apiVersion: graphkit.dev/v2\nkind: Graph\nmetadata:\n  name: demo\ntopology: custom\nnodes:\n  a:\n    agent: scout\n    objective: A\n    evidence: [a-out]\n  b:\n    agent: task\n    objective: B\n    depend_on: [a]\n  c:\n    agent: reviewer\n    objective: C\n    depend_on: [b]\n`,
    );
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  test("failed run derives session graph and reports pending", () => {
    writeFileSync(join(cwd, ".graphkit", "evidence", "a-out.md"), "ok\n");
    const r = startRun(cwd, join(cwd, "graph.yaml"));
    appendNode(cwd, {
      node: "a",
      wave: 0,
      agent: "x",
      model: null,
      status: "ok",
      evidence: ["a-out"],
      duration_ms: 1,
      notes: null,
    });
    appendNode(cwd, {
      node: "b",
      wave: 0,
      agent: "x",
      model: null,
      status: "fail",
      evidence: [],
      duration_ms: 1,
      notes: null,
    });
    endRun(cwd, "failed");
    const res = runCli(["run", "resume", r.id], cwd);
    expect(res.code).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out.status).toBe("ok");
    expect(out.data.resumed).toBe(true);
    expect(out.data.pending).toEqual(["b", "c"]);
    expect(out.data.session.path).toContain("-demo-resume.yaml");
    // derived graph on disk: pending-only + refs
    const derived = YAML.parse(readFileSync(out.data.session.path, "utf-8"));
    expect(Object.keys(derived.nodes).sort()).toEqual(["b", "c"]);
    expect(derived.nodes.b.refs[0].path).toBe(".graphkit/evidence/a-out.md");
    // session store activated + child run active with provenance
    expect(readFileSync(join(cwd, ".graphkit", "active"), "utf-8").trim()).toBe(out.data.session.id);
    expect(readFileSync(join(cwd, ".graphkit", "runs", out.data.run.id, "meta.json"), "utf-8")).toContain(r.id);
  });
  test("--dry-run writes nothing", () => {
    const r = startRun(cwd, join(cwd, "graph.yaml"));
    appendNode(cwd, {
      node: "a",
      wave: 0,
      agent: "x",
      model: null,
      status: "fail",
      evidence: [],
      duration_ms: 1,
      notes: null,
    });
    endRun(cwd, "failed");
    const before = readdirSync(join(cwd, ".graphkit", "graphs"));
    const out = JSON.parse(runCli(["run", "resume", r.id, "--dry-run"], cwd).stdout);
    expect(out.data.resumed).toBe(false);
    expect(out.data.reason).toBe("DRY_RUN");
    expect(readdirSync(join(cwd, ".graphkit", "graphs"))).toEqual(before);
  });
  test("nothing pending is informational", () => {
    const r = startRun(cwd, join(cwd, "graph.yaml"));
    for (const node of ["a", "b", "c"])
      appendNode(cwd, {
        node,
        wave: 0,
        agent: "x",
        model: null,
        status: "ok",
        evidence: [],
        duration_ms: 1,
        notes: null,
      });
    endRun(cwd, "merged");
    const out = JSON.parse(runCli(["run", "resume", r.id], cwd).stdout);
    expect(out.data.resumed).toBe(false);
    expect(out.data.reason).toBe("NOTHING_TO_RESUME");
  });
  test("graph drift exits failure envelope", () => {
    const r = startRun(cwd, join(cwd, "graph.yaml"));
    endRun(cwd, "failed");
    appendFileSync(join(cwd, "graph.yaml"), "# drift\n");
    const out = JSON.parse(runCli(["run", "resume", r.id], cwd).stdout);
    expect(out.error.code).toBe("RESUME_GRAPH_DRIFT");
    expect(runCli(["run", "resume", r.id], cwd).code).toBe(1);
  });
});

describe("run dispatch/land/take CLI", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = join(tmpdir(), `gk-take-${process.pid}-${Date.now()}`);
    mkdirSync(join(cwd, ".graphkit", "runs"), { recursive: true });
    writeFileSync(
      join(cwd, "graph.yaml"),
      "apiVersion: graphkit.dev/v2\nkind: Graph\nmetadata:\n  name: demo\ntopology: custom\nnodes:\n  a:\n    agent: scout\n    objective: A\n  b:\n    agent: task\n    objective: B\n    depend_on: [a]\n",
    );
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  const activeFile = () => join(cwd, ".graphkit", "runs", ".active");

  test("run dispatch records intent and surfaces in take output", () => {
    const r = startRun(cwd, join(cwd, "graph.yaml"));
    const out = JSON.parse(runCli(["run", "dispatch", "a", "--via", "task"], cwd).stdout);
    expect(out.status).toBe("ok");
    expect(out.data).toEqual({ run: r.id, node: "a" });
    const rows = readFileSync(join(r.dir, "dispatch.jsonl"), "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ node: "a", attempt: null, via: "task", pid: null });
    // A dispatched node with no trace line reconciles as unresolved on takeover.
    const take = JSON.parse(runCli(["run", "take", "--from", r.id], cwd).stdout);
    expect(take.status).toBe("ok");
    expect(take.data.taken_from).toBe(r.id);
    expect(take.data.unresolved).toEqual(["a"]);
    expect(take.data.active_cleared).toBe(true);
    expect(existsSync(activeFile())).toBe(false);
  });

  test("run land requires --commit and an ok trace line", () => {
    startRun(cwd, join(cwd, "graph.yaml"));
    expect(JSON.parse(runCli(["run", "land", "a"], cwd).stdout).error.code).toBe("MISSING_ARG");
    expect(JSON.parse(runCli(["run", "land", "a", "--commit", "abc123"], cwd).stdout).error.code).toBe("LAND_NOT_OK");
    runCli(["run", "node", "a", "--status", "ok"], cwd);
    const landed = JSON.parse(runCli(["run", "land", "a", "--commit", "abc123"], cwd).stdout);
    expect(landed.status).toBe("ok");
    expect(readTrace(cwd, landed.data.run).at(-1)?.landed).toMatchObject({ commit: "abc123" });
  });

  test("run take clears stale .active and stamps takes_over on the next start", () => {
    const dead = Bun.spawnSync(["true"]).pid; // already exited: liveness check sees it as gone
    const r1 = startRun(cwd, join(cwd, "graph.yaml"));
    runCli(["run", "dispatch", "a", "--pid", String(dead)], cwd);
    const take = JSON.parse(runCli(["run", "take", "--from", r1.id], cwd).stdout);
    expect(take.status).toBe("ok");
    expect(existsSync(activeFile())).toBe(false);
    // The next started run inherits the takeover as provenance in its meta.
    const r2 = JSON.parse(runCli(["run", "start"], cwd).stdout).data;
    expect(JSON.parse(readFileSync(join(r2.dir, "meta.json"), "utf-8")).takes_over).toBe(r1.id);
  });

  test("startRun keeps the .takeover stamp when the start fails RUN_ACTIVE", () => {
    startRun(cwd, join(cwd, "graph.yaml")); // blocks any further start
    const stamp = join(cwd, ".graphkit", "runs", ".takeover");
    stampTakeover(cwd, "20260101-000000-old");
    // Task 2 envelope: the code is a structured GraphKitError field now.
    try {
      startRun(cwd, join(cwd, "graph.yaml"));
      throw new Error("expected RUN_ACTIVE");
    } catch (e) {
      expect(e).toBeInstanceOf(GraphKitError);
      expect((e as GraphKitError).code).toBe("RUN_ACTIVE");
    }
    expect(readFileSync(stamp, "utf-8").trim()).toBe("20260101-000000-old");
    // A later successful start still consumes the surviving stamp.
    endRun(cwd, "failed");
    const r = startRun(cwd, join(cwd, "graph.yaml"));
    expect(JSON.parse(readFileSync(join(r.dir, "meta.json"), "utf-8")).takes_over).toBe("20260101-000000-old");
    expect(existsSync(stamp)).toBe(false);
  });

  test("run take refuses while dispatch pids are alive", () => {
    const r = startRun(cwd, join(cwd, "graph.yaml"));
    const sleeper = Bun.spawn(["sleep", "30"]); // foreign live pid: not the harness's own
    try {
      runCli(["run", "dispatch", "a", "--pid", String(sleeper.pid)], cwd);
      const take = JSON.parse(runCli(["run", "take", "--from", r.id], cwd).stdout);
      expect(take.error.code).toBe("TAKEOVER_BLOCKED");
      expect(runCli(["run", "take", "--from", r.id], cwd).code).toBe(1);
      expect(existsSync(activeFile())).toBe(true);
    } finally {
      sleeper.kill();
    }
  });

  test("run take tolerates .active pointing at a different run", () => {
    const r1 = startRun(cwd, join(cwd, "graph.yaml"));
    endRun(cwd, "failed");
    const r2 = startRun(cwd, join(cwd, "graph.yaml"));
    const take = JSON.parse(runCli(["run", "take", "--from", r1.id], cwd).stdout);
    expect(take.status).toBe("ok");
    expect(take.data.active_cleared).toBe(false);
    expect(take.data.active).toBe(r2.id);
    expect(existsSync(activeFile())).toBe(true);
  });

  test("node --attempt writes attempt field", () => {
    startRun(cwd, join(cwd, "graph.yaml"));
    const out = JSON.parse(runCli(["run", "node", "a", "--status", "ok", "--attempt", "2"], cwd).stdout);
    expect(out.status).toBe("ok");
    expect(readTrace(cwd, out.data.run).at(-1)?.attempt).toBe(2);
  });

  test("run end reports orphaned worktrees/branches (quiet [] off-repo)", () => {
    startRun(cwd, join(cwd, "graph.yaml"));
    const out = JSON.parse(runCli(["run", "end", "--status", "merged"], cwd).stdout);
    expect(out.status).toBe("ok");
    // The fixture cwd is not a git repo: the best-effort scan must fail soft,
    // but the SKILL contract promises both fields on every end payload.
    expect(out.data.orphaned_worktrees).toEqual([]);
    expect(out.data.orphaned_branches).toEqual([]);
  });

  test("run dispatch rejects --via outside task|extension", () => {
    startRun(cwd, join(cwd, "graph.yaml"));
    const out = runCli(["run", "dispatch", "a", "--via", "wave"], cwd);
    expect(out.code).toBe(1);
    expect(JSON.parse(out.stdout).error.code).toBe("BAD_VIA");
  });

  test("take --from a dangling .active clears the pointer with nothing to reconcile", () => {
    const r = startRun(cwd, join(cwd, "graph.yaml"));
    rmSync(r.dir, { recursive: true, force: true }); // run dir gone, .active stale
    const take = JSON.parse(runCli(["run", "take", "--from", r.id], cwd).stdout);
    expect(take.status).toBe("ok");
    expect(take.data.taken_from).toBe(r.id);
    expect(take.data.dangling).toBe(true);
    expect(take.data.active_cleared).toBe(true);
    expect(take.data.unresolved).toEqual([]);
    expect(take.data.foreign_evidence).toEqual([]);
    expect(take.data.note).toContain(r.id);
    expect(existsSync(activeFile())).toBe(false);
    // The deadlock is gone: a fresh start succeeds without `rm .active`.
    expect(() => startRun(cwd, join(cwd, "graph.yaml"))).not.toThrow();
  });

  test("take --from a bogus id still fails RESUME_RUN_NOT_FOUND", () => {
    const out = runCli(["run", "take", "--from", "20990101-000000-bogus"], cwd);
    expect(out.code).toBe(1);
    const body = JSON.parse(out.stdout);
    expect(body.error.code).toBe("RESUME_RUN_NOT_FOUND");
  });

  test("run status surfaces a dangling .active pointer", () => {
    const deadDir = join(cwd, ".graphkit", "runs", "20260101-000000-dead");
    writeFileSync(activeFile(), deadDir);
    const status = JSON.parse(runCli(["run", "status"], cwd).stdout);
    expect(status.status).toBe("ok");
    expect(status.data.active).toBeNull();
    expect(status.data.dangling).toBe(true);
    expect(status.data.dangling_run).toBe("20260101-000000-dead");
  });
});
