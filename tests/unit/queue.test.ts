import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cac } from "cac";
import { registerQueueCommand } from "../../src/cli/commands/queue.js";
import type { GraphKitError } from "../../src/errors.js";
import { addTask, claimTask, doneTask, failTask, queueDir, queueStatus, readItem } from "../../src/queue/store.js";

function runCli(args: string[], cwd: string) {
  const origCwd = process.cwd();
  process.chdir(cwd);
  const cli = cac("gk");
  registerQueueCommand(cli);
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  let exitCode = 0;
  let code = 0;
  const origExit = process.exit;
  process.exit = (c?: number) => {
    exitCode = c ?? 1;
  };
  let error: Error | undefined;
  try {
    cli.parse(["node", "gk", ...args], { run: true });
  } catch (e) {
    error = e as Error;
  } finally {
    console.log = origLog;
    process.exit = origExit;
    process.chdir(origCwd);
    code = exitCode || ((process.exitCode as number | undefined) ?? 0);
    process.exitCode = 0;
  }
  return { stdout: logs.join("\n"), code, error };
}

const TASK_A = { id: "task-a", objective: "build the API", acceptance_criteria: ["api-works"], depends_on: [] };
const TASK_B = {
  id: "task-b",
  objective: "build the UI",
  acceptance_criteria: ["ui-works"],
  depends_on: ["task-a"],
};

describe("queue store", () => {
  let tmp: string;
  let dir: string;

  beforeEach(() => {
    tmp = join(tmpdir(), `gk-queue-${process.pid}-${Date.now()}`);
    mkdirSync(tmp, { recursive: true });
    dir = queueDir(tmp);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("add writes one YAML per task, auto-ids when absent, dedups id and content", () => {
    const a = addTask(dir, TASK_A);
    expect(readItem(dir, "task-a").state).toBe("queued");
    expect(a.acceptance_criteria).toEqual(["api-works"]);

    const auto = addTask(dir, { objective: "unnamed task", depends_on: [] });
    expect(auto.id).toMatch(/^task-\d+-[0-9a-f]{6}$/);

    // same id while live → QUEUE_DUPLICATE
    try {
      addTask(dir, TASK_A);
      expect.unreachable();
    } catch (e) {
      expect((e as GraphKitError).code).toBe("QUEUE_DUPLICATE");
    }
    // same work contract under a different id → QUEUE_DUPLICATE
    try {
      addTask(dir, { ...TASK_A, id: "task-a-copy" });
      expect.unreachable();
    } catch (e) {
      expect((e as GraphKitError).code).toBe("QUEUE_DUPLICATE");
    }
  });

  test("add rejects depends_on pointing at unknown ids", () => {
    try {
      addTask(dir, { id: "orphan", objective: "x", depends_on: ["ghost-1", "ghost-2"] });
      expect.unreachable();
    } catch (e) {
      expect((e as GraphKitError).code).toBe("QUEUE_UNKNOWN_DEP");
      expect((e as GraphKitError).details?.unknown).toEqual(["ghost-1", "ghost-2"]);
    }
  });

  test("claim takes the oldest claimable item and respects dependency order", () => {
    addTask(dir, TASK_A);
    addTask(dir, TASK_B); // blocked on task-a
    addTask(dir, { id: "task-c", objective: "independent", depends_on: [] });

    // task-b is dep-blocked; oldest claimable is task-a
    const first = claimTask(dir, "worker-1");
    expect(first?.id).toBe("task-a");
    expect(first?.state).toBe("claimed");
    expect(first?.claimed_by).toBe("worker-1");
    expect(readItem(dir, "task-a").state).toBe("claimed");

    // task-b is still blocked (task-a claimed, not done) → task-c wins,
    // proving a blocked head never starves later ready work
    const second = claimTask(dir, "worker-2");
    expect(second?.id).toBe("task-c");
    expect(second?.id).not.toBe(first?.id);

    // task-b remains unclaimable until task-a is done
    expect(claimTask(dir, "worker-3")).toBeNull();
    doneTask(dir, "task-a");
    const third = claimTask(dir, "worker-3");
    expect(third?.id).toBe("task-b");
  });

  test("claim on an empty queue is ok:null, not an error", () => {
    expect(claimTask(dir, "worker-1")).toBeNull();
    const res = runCli(["queue", "claim"], tmp);
    expect(res.code).toBe(0);
    expect(JSON.parse(res.stdout).data.claimed).toBeNull();
  });

  test("done requires claimed; fail marks terminal; both carry a note", () => {
    addTask(dir, TASK_A);
    try {
      doneTask(dir, "task-a");
      expect.unreachable();
    } catch (e) {
      expect((e as GraphKitError).code).toBe("QUEUE_NOT_CLAIMED");
    }
    claimTask(dir, "w");
    const done = doneTask(dir, "task-a", { note: "shipped", evidence: ["api-works"] });
    expect(done.state).toBe("done");
    expect(done.note).toBe("shipped");
    expect(done.evidence).toEqual(["api-works"]);

    // done is terminal — no second transition
    try {
      failTask(dir, "task-a");
      expect.unreachable();
    } catch (e) {
      expect((e as GraphKitError).code).toBe("QUEUE_INVALID_STATE");
    }

    addTask(dir, { id: "task-f", objective: "doomed", depends_on: [] });
    const failed = failTask(dir, "task-f", { note: "oops" });
    expect(failed.state).toBe("failed");
    expect(failed.note).toBe("oops");
    expect(queueStatus(dir).blocked.map((b) => b.id)).toContain("task-f");
  });

  test("a failed task may be re-added (dedup only covers live states)", () => {
    addTask(dir, TASK_A);
    failTask(dir, "task-a");
    const readded = addTask(dir, TASK_A);
    expect(readded.state).toBe("queued");
  });

  test("status reports counts, the item table, and blockers", () => {
    addTask(dir, TASK_A);
    addTask(dir, TASK_B);
    claimTask(dir, "w1");
    const status = queueStatus(dir);
    expect(status.counts).toMatchObject({ queued: 1, claimed: 1, done: 0, failed: 0, total: 2 });
    const rowB = status.items.find((r) => r.id === "task-b");
    expect(rowB?.deps_blocked).toBe(true);
    const rowA = status.items.find((r) => r.id === "task-a");
    expect(rowA?.claimer).toBe("w1");
    expect(rowA?.deps_blocked).toBe(false);
  });

  test("two sequential claims over a live queue get different items", () => {
    addTask(dir, { id: "t1", objective: "one", depends_on: [] });
    addTask(dir, { id: "t2", objective: "two", depends_on: [] });
    const first = claimTask(dir, "w1");
    const second = claimTask(dir, "w2");
    expect(first?.id).toBe("t1");
    expect(second?.id).toBe("t2");
    expect(claimTask(dir, "w3")).toBeNull();
  });
});

describe("gk queue CLI", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = join(tmpdir(), `gk-queue-cli-${process.pid}-${Date.now()}`);
    mkdirSync(tmp, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("add → claim → done → list → status over the CLI surface", () => {
    writeFileSync(
      join(tmp, "task.yaml"),
      `id: cli-task
objective: wire the intake
acceptance_criteria: [intake-works]
depends_on: []
`,
    );
    const add = runCli(["queue", "add", join(tmp, "task.yaml")], tmp);
    expect(add.code).toBe(0);
    expect(JSON.parse(add.stdout).data.item.state).toBe("queued");

    const claim = runCli(["queue", "claim", "--node", "worker-9"], tmp);
    expect(claim.code).toBe(0);
    expect(JSON.parse(claim.stdout).data.claimed.id).toBe("cli-task");

    const done = runCli(["queue", "done", "cli-task", "--note", "ok", "--evidence", "intake-works"], tmp);
    expect(done.code).toBe(0);
    expect(JSON.parse(done.stdout).data.item.state).toBe("done");

    const listed = JSON.parse(runCli(["queue", "list", "--state", "done"], tmp).stdout);
    expect(listed.data.items.map((i: { id: string }) => i.id)).toEqual(["cli-task"]);

    const status = JSON.parse(runCli(["queue", "status"], tmp).stdout);
    expect(status.data.counts.done).toBe(1);
  });

  test("duplicate add fails QUEUE_DUPLICATE with exit 1", () => {
    writeFileSync(join(tmp, "t.yaml"), `id: dup\nobjective: x\n`);
    expect(runCli(["queue", "add", join(tmp, "t.yaml")], tmp).code).toBe(0);
    const second = runCli(["queue", "add", join(tmp, "t.yaml")], tmp);
    expect(second.code).toBe(1);
    expect(JSON.parse(second.stdout).error.code).toBe("QUEUE_DUPLICATE");
  });

  test("unknown-dep add fails QUEUE_UNKNOWN_DEP with exit 1", () => {
    writeFileSync(join(tmp, "t.yaml"), `objective: x\ndepends_on: [nope]\n`);
    const r = runCli(["queue", "add", join(tmp, "t.yaml")], tmp);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout).error.code).toBe("QUEUE_UNKNOWN_DEP");
  });

  test("done on an unclaimed task fails QUEUE_NOT_CLAIMED", () => {
    writeFileSync(join(tmp, "t.yaml"), `id: unclaimed\nobjective: x\n`);
    runCli(["queue", "add", join(tmp, "t.yaml")], tmp);
    const r = runCli(["queue", "done", "unclaimed"], tmp);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout).error.code).toBe("QUEUE_NOT_CLAIMED");
  });

  test("unknown subcommand fails UNKNOWN_QUEUE_SUBCOMMAND", () => {
    const r = runCli(["queue", "bogus"], tmp);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout).error.code).toBe("UNKNOWN_QUEUE_SUBCOMMAND");
  });

  test("writes are atomic: no tmp sibling survives in items/", () => {
    writeFileSync(join(tmp, "t.yaml"), `id: atomic\nobjective: x\n`);
    runCli(["queue", "add", join(tmp, "t.yaml")], tmp);
    const items = readdirSync(join(tmp, ".graphkit", "queue", "items"));
    expect(items.filter((f) => f.includes(".tmp-"))).toEqual([]);
  });
});
