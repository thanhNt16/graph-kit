import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cac } from "cac";
import YAML from "yaml";
import { CLI_COMMANDS } from "../../src/cli/command-registry.js";
import { registerRunCommands } from "../../src/cli/commands/run.js";
import { appendNode, endRun, readAdvisorEvents, startRun } from "../../src/memory/ledger.js";
import { createCliHarness } from "../helpers/cli-harness.js";

describe("gk run CLI", () => {
  afterEach(() => {
    process.exitCode = 0; // fail() paths set process.exitCode=1 — reset so bun:test exits 0
  });
  test("registers a single `run` command with subcommand dispatch", () => {
    const cli = cac("gk");
    registerRunCommands(cli);
    expect(cli.commands.map((c) => c.name)).toContain("run");
  });
  test("command registry lists all run subcommands", () => {
    const paths = CLI_COMMANDS.map((c) => c.path);
    expect(paths).toContain("run start");
    expect(paths).toContain("run node");
    expect(paths).toContain("run end");
    expect(paths).toContain("run status");
  });

  test("executes run start, status, node, end lifecycle", () => {
    const cwd = join(tmpdir(), `gk-run-cli-${process.pid}-${Date.now()}`);
    mkdirSync(cwd, { recursive: true });
    try {
      // 1. Initial status -> inactive (--json: the machine envelope)
      const initialStatus = JSON.parse(
        createCliHarness(registerRunCommands, { cwd }).run(["run", "status", "--json"]).stdout,
      );
      expect(initialStatus).toEqual({ status: "ok", data: { active: null, advisor_events: 0, resumes_chain: [] } });

      // 2. Start run without graph file fails with GRAPH_NOT_FOUND
      const startFail = JSON.parse(
        createCliHarness(registerRunCommands, { cwd }).run(["run", "start", "--json"]).stdout,
      );
      expect(startFail.status).toBe("fail");
      expect(startFail.error.code).toBe("GRAPH_NOT_FOUND");
      // 3. Start valid run with graph.yaml
      writeFileSync(join(cwd, "graph.yaml"), "metadata:\n  name: test-graph\n");
      const startOk = JSON.parse(createCliHarness(registerRunCommands, { cwd }).run(["run", "start", "--json"]).stdout);
      expect(startOk.status).toBe("ok");
      expect(startOk.data.id).toMatch(/test-graph$/);
      const metaFile = JSON.parse(readFileSync(join(startOk.data.dir, "meta.json"), "utf-8"));
      expect(metaFile.fingerprint).toEqual({ head: null, tree: null }); // tmp cwd is not a git repo

      // 4. Status returns active run directory
      const activeStatus = JSON.parse(
        createCliHarness(registerRunCommands, { cwd }).run(["run", "status", "--json"]).stdout,
      );
      expect(activeStatus.status).toBe("ok");
      expect(activeStatus.data.active).toBe(startOk.data.dir);

      // 5. Node requires node id
      const missingNode = JSON.parse(
        createCliHarness(registerRunCommands, { cwd }).run(["run", "node", "--status", "ok", "--json"]).stdout,
      );
      expect(missingNode.status).toBe("fail");
      expect(missingNode.error.code).toBe("MISSING_ARG");

      // 6. Node requires status ok|fail
      const badNodeStatus = JSON.parse(
        createCliHarness(registerRunCommands, { cwd }).run(["run", "node", "review", "--json"]).stdout,
      );
      expect(badNodeStatus.status).toBe("fail");
      expect(badNodeStatus.error.code).toBe("BAD_STATUS");

      // 7. Node append succeeds
      const nodeOk = JSON.parse(
        createCliHarness(registerRunCommands, { cwd }).run([
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
          "--json",
          "--notes",
          "all passed",
        ]).stdout,
      );
      expect(nodeOk.status).toBe("ok");
      expect(nodeOk.data.run).toBe(startOk.data.id);
      expect(nodeOk.data.node).toBe("review");

      // 8. End run requires valid status
      const badEndStatus = JSON.parse(
        createCliHarness(registerRunCommands, { cwd }).run(["run", "end", "--status", "invalid", "--json"]).stdout,
      );
      expect(badEndStatus.status).toBe("fail");
      expect(badEndStatus.error.code).toBe("BAD_STATUS");

      // 9. End run succeeds
      const endOk = JSON.parse(
        createCliHarness(registerRunCommands, { cwd }).run(["run", "end", "--status", "merged", "--json"]).stdout,
      );
      expect(endOk.status).toBe("ok");
      expect(endOk.data.status).toBe("merged");
      expect(endOk.data.node_count).toBe(1);
      expect(endOk.data.failures).toBe(0);
      expect(endOk.data.evidence_keys).toEqual(["cov", "lint"]);

      // 10. Status returns null after end
      const finalStatus = JSON.parse(
        createCliHarness(registerRunCommands, { cwd }).run(["run", "status", "--json"]).stdout,
      );
      expect(finalStatus).toEqual({ status: "ok", data: { active: null, advisor_events: 0, resumes_chain: [] } });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("run status default output is human-readable (run id, graph, round, verdict chain); --json prints the envelope", () => {
    const cwd = join(tmpdir(), `gk-run-human-${process.pid}-${Date.now()}`);
    mkdirSync(cwd, { recursive: true });
    try {
      writeFileSync(
        join(cwd, "graph.yaml"),
        [
          "apiVersion: graphkit.dev/v2",
          "kind: Graph",
          "metadata:",
          "  name: human-graph",
          "topology: diamond",
          "nodes:",
          "  exec:",
          "    agent: haiku",
          "    objective: do the thing",
          "    loop: { enabled: true }",
          "    advisor: { model: opus }",
        ].join("\n"),
      );
      // inactive: plain human notice, not JSON
      const inactive = createCliHarness(registerRunCommands, { cwd }).run(["run", "status"]).stdout;
      expect(() => JSON.parse(inactive)).toThrow();
      expect(inactive).toContain("no active run");

      const start = JSON.parse(createCliHarness(registerRunCommands, { cwd }).run(["run", "start", "--json"]).stdout);
      createCliHarness(registerRunCommands, { cwd }).run([
        "run",
        "node",
        "exec",
        "--status",
        "ok",
        "--wave",
        "1",
        "--evidence",
        "cov",
      ]);
      const human = createCliHarness(registerRunCommands, { cwd }).run(["run", "status"]).stdout;
      expect(() => JSON.parse(human)).toThrow(); // default output is not JSON
      expect(human).toContain(start.data.id); // run id
      expect(human).toContain("graph: human-graph");
      expect(human).toContain("round:"); // progress marker
      expect(human).toContain("1 ok / 0 failed / 1 traced");
      expect(human).toContain("evidence: 1 keys");
      expect(human).toContain(`verdict chain: ${start.data.id}`);

      // --json keeps today's envelope shape byte-for-byte
      const js = JSON.parse(createCliHarness(registerRunCommands, { cwd }).run(["run", "status", "--json"]).stdout);
      expect(js).toEqual({
        status: "ok",
        data: { active: start.data.dir, advisor_events: 0, resumes_chain: [start.data.id] },
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("handles unknown subcommand", () => {
    const cwd = join(tmpdir(), `gk-run-unknown-${process.pid}-${Date.now()}`);
    mkdirSync(cwd, { recursive: true });
    try {
      const res = JSON.parse(createCliHarness(registerRunCommands, { cwd }).run(["run", "foo"]).stdout);
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
      const res = createCliHarness(registerRunCommands, { cwd }).run(["run"]);
      expect(res.stdout).toContain("gk run — run ledger commands");
      expect(res.stdout).toContain("Subcommands: start node end list status resume");
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
      const start = JSON.parse(createCliHarness(registerRunCommands, { cwd }).run(["run", "start", "--json"]).stdout);
      expect(start.status).toBe("ok");
      const fired = JSON.parse(
        createCliHarness(registerRunCommands, { cwd }).run([
          "run",
          "node",
          "exec",
          "--advisor-fired",
          "2",
          "--streak",
          "2",
          "--json",
        ]).stdout,
      );
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
      JSON.parse(createCliHarness(registerRunCommands, { cwd }).run(["run", "start", "--json"]).stdout);
      const fired = JSON.parse(
        createCliHarness(registerRunCommands, { cwd }).run(["run", "node", "plain", "--advisor-fired", "1", "--json"])
          .stdout,
      );
      expect(fired.status).toBe("fail");
      expect(fired.error.code).toBe("BAD_ADVISOR");
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
      JSON.parse(createCliHarness(registerRunCommands, { cwd }).run(["run", "start", "--json"]).stdout);
      const before = JSON.parse(createCliHarness(registerRunCommands, { cwd }).run(["run", "status", "--json"]).stdout);
      expect(before).toEqual({
        status: "ok",
        data: { active: expect.any(String), advisor_events: 0, resumes_chain: [expect.any(String)] },
      });
      createCliHarness(registerRunCommands, { cwd }).run(["run", "node", "exec", "--advisor-fired", "1"]);
      const after = JSON.parse(createCliHarness(registerRunCommands, { cwd }).run(["run", "status", "--json"]).stdout);
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
      JSON.parse(createCliHarness(registerRunCommands, { cwd }).run(["run", "start", "--json"]).stdout);
      for (const bad of ["abc", "0", "1.5"]) {
        const res = JSON.parse(
          createCliHarness(registerRunCommands, { cwd }).run([
            "run",
            "node",
            "exec",
            "--advisor-fired",
            "1",
            "--streak",
            bad,
            "--json",
          ]).stdout,
        );
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
      const start = JSON.parse(
        createCliHarness(registerRunCommands, { cwd }).run(["run", "start", "--graph", "alt.yaml", "--json"]).stdout,
      );
      expect(start.status).toBe("ok");
      const fired = JSON.parse(
        createCliHarness(registerRunCommands, { cwd }).run(["run", "node", "exec", "--advisor-fired", "1", "--json"])
          .stdout,
      );
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
      const r1 = JSON.parse(createCliHarness(registerRunCommands, { cwd }).run(["run", "start", "--json"]).stdout).data;
      createCliHarness(registerRunCommands, { cwd }).run(["run", "end", "--status", "failed"]);
      const { startRun } = require("../../src/memory/ledger.js");
      startRun(cwd, join(cwd, "graph.yaml"), "2026-09-04T11:00:00.000Z", r1.id);
      const parsed = JSON.parse(createCliHarness(registerRunCommands, { cwd }).run(["run", "status", "--json"]).stdout);
      expect(parsed.status).toBe("ok");
      expect(parsed.data.resumes_chain).toEqual(["20260904-110000-demo", r1.id]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("run resume CLI", () => {
  let cwd: string;
  beforeEach(() => {
    process.exitCode = 0; // assert exitCode as a plain number, even before any fail()
    cwd = join(tmpdir(), `gk-resume-${process.pid}-${Date.now()}`);
    mkdirSync(join(cwd, ".graphkit", "runs"), { recursive: true });
    mkdirSync(join(cwd, ".graphkit", "evidence"), { recursive: true });
    mkdirSync(join(cwd, ".graphkit", "graphs"), { recursive: true });
    writeFileSync(
      join(cwd, "graph.yaml"),
      `apiVersion: graphkit.dev/v2\nkind: Graph\nmetadata:\n  name: demo\ntopology: custom\nnodes:\n  a:\n    agent: scout\n    objective: A\n    evidence: [a-out]\n  b:\n    agent: task\n    objective: B\n    depend_on: [a]\n  c:\n    agent: reviewer\n    objective: C\n    depend_on: [b]\n`,
    );
  });
  afterEach(() => {
    process.exitCode = 0; // fail() paths set process.exitCode=1 — reset so bun:test exits 0
    rmSync(cwd, { recursive: true, force: true });
  });

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
    const res = createCliHarness(registerRunCommands, { cwd }).run(["run", "resume", r.id]);
    expect(res.exitCode).toBe(0);
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
    const out = JSON.parse(
      createCliHarness(registerRunCommands, { cwd }).run(["run", "resume", r.id, "--dry-run"]).stdout,
    );
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
    const out = JSON.parse(createCliHarness(registerRunCommands, { cwd }).run(["run", "resume", r.id]).stdout);
    expect(out.data.resumed).toBe(false);
    expect(out.data.reason).toBe("NOTHING_TO_RESUME");
  });
  test("graph drift exits failure envelope", () => {
    const r = startRun(cwd, join(cwd, "graph.yaml"));
    endRun(cwd, "failed");
    appendFileSync(join(cwd, "graph.yaml"), "# drift\n");
    const out = JSON.parse(createCliHarness(registerRunCommands, { cwd }).run(["run", "resume", r.id]).stdout);
    expect(out.error.code).toBe("RESUME_GRAPH_DRIFT");
    expect(createCliHarness(registerRunCommands, { cwd }).run(["run", "resume", r.id]).exitCode).toBe(1);
  });
});

// Round 4: run list (the resume front door) + run status <id>.
describe("gk run list / run status <id> (round 4)", () => {
  let cwd: string;
  beforeEach(() => {
    process.exitCode = 0; // assert exitCode as a plain number, even before any fail()
    cwd = join(tmpdir(), `gk-run-list-${process.pid}-${Date.now()}`);
    mkdirSync(join(cwd, ".graphkit", "runs"), { recursive: true });
    writeFileSync(join(cwd, "graph.yaml"), "metadata:\n  name: demo\ntopology: diamond\n");
  });
  afterEach(() => {
    process.exitCode = 0; // fail() paths set process.exitCode=1 — reset so bun:test exits 0
    rmSync(cwd, { recursive: true, force: true });
  });

  test("list merges index entries with dir-only runs (ended / running / interrupted)", () => {
    startRun(cwd, join(cwd, "graph.yaml"), "2026-09-03T10:00:00.000Z");
    endRun(cwd, "merged", "2026-09-03T11:00:00.000Z");
    // interrupted: dir + meta, never ended, not active
    startRun(cwd, join(cwd, "graph.yaml"), "2026-09-03T12:00:00.000Z");
    rmSync(join(cwd, ".graphkit", "runs", ".active")); // dir-only run → "interrupted"

    const json = JSON.parse(createCliHarness(registerRunCommands, { cwd }).run(["run", "list", "--json"]).stdout);
    expect(json.status).toBe("ok");
    expect(json.data.total).toBe(2);
    expect(json.data.runs[0].id).toBe("20260903-120000-demo"); // newest first
    expect(json.data.runs[0].status).toBe("interrupted");
    expect(json.data.runs[1].status).toBe("merged");

    // a live run shows as running
    startRun(cwd, join(cwd, "graph.yaml"), "2026-09-03T13:00:00.000Z");
    const live = JSON.parse(createCliHarness(registerRunCommands, { cwd }).run(["run", "list", "--json"]).stdout);
    expect(live.data.runs[0].status).toBe("running");
    const human = createCliHarness(registerRunCommands, { cwd }).run(["run", "list"]).stdout;
    expect(human).toContain("running");
    expect(human).toContain("interrupted");
    expect(human).toContain("`gk run resume");
  });

  test("run status <id> renders a past run; unknown id → RUN_NOT_FOUND envelope", () => {
    const r = startRun(cwd, join(cwd, "graph.yaml"), "2026-09-03T10:00:00.000Z");
    appendNode(cwd, {
      node: "a",
      wave: 0,
      agent: null,
      model: null,
      status: "ok",
      evidence: [],
      duration_ms: 1,
      notes: null,
    });
    endRun(cwd, "merged");
    const human = createCliHarness(registerRunCommands, { cwd }).run(["run", "status", r.id]);
    expect(human.stdout).toContain(`run: ${r.id}`);
    expect(human.stdout).toContain("nodes: 1 ok");
    const json = JSON.parse(
      createCliHarness(registerRunCommands, { cwd }).run(["run", "status", r.id, "--json"]).stdout,
    );
    expect(json.status).toBe("ok");
    expect(json.data.active).toContain(r.id);
    const miss = createCliHarness(registerRunCommands, { cwd }).run(["run", "status", "no-such-run", "--json"]);
    expect(JSON.parse(miss.stdout).error.code).toBe("RUN_NOT_FOUND");
    expect(miss.exitCode).toBe(1);
  });
});
