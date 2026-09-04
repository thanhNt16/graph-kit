import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cac } from "cac";
import { CLI_COMMANDS } from "../../src/cli/command-registry.js";
import { registerRunCommands } from "../../src/cli/commands/run.js";
import { readAdvisorEvents } from "../../src/memory/ledger.js";

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
    process.exitCode = 0; // fail() sets process.exitCode=1 — reset so bun:test exits 0
  }
  return { stdout: logs.join("\n"), code: exitCode };
}

describe("gk run CLI", () => {
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
      // 1. Initial status -> inactive
      const initialStatus = JSON.parse(runCli(["run", "status"], cwd).stdout);
      expect(initialStatus).toEqual({ status: "ok", data: { active: null, advisor_events: 0 } });

      // 2. Start run without graph file fails with GRAPH_NOT_FOUND
      const startFail = JSON.parse(runCli(["run", "start"], cwd).stdout);
      expect(startFail.status).toBe("fail");
      expect(startFail.error.code).toBe("GRAPH_NOT_FOUND");
      // 3. Start valid run with graph.yaml
      writeFileSync(join(cwd, "graph.yaml"), "metadata:\n  name: test-graph\n");
      const startOk = JSON.parse(runCli(["run", "start"], cwd).stdout);
      expect(startOk.status).toBe("ok");
      expect(startOk.data.id).toMatch(/test-graph$/);

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
      expect(finalStatus).toEqual({ status: "ok", data: { active: null, advisor_events: 0 } });
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
      expect(res.stdout).toContain("Subcommands: start node end status");
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
      expect(before).toEqual({ status: "ok", data: { active: expect.any(String), advisor_events: 0 } });
      runCli(["run", "node", "exec", "--advisor-fired", "1"], cwd);
      const after = JSON.parse(runCli(["run", "status"], cwd).stdout);
      expect(after.status).toBe("ok");
      expect(after.data.advisor_events).toBe(1);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
