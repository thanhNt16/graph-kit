import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cac } from "cac";
import YAML from "yaml";
import { registerGraphCommands } from "../../src/cli/commands/graph.js";
import { registerRunCommands } from "../../src/cli/commands/run.js";
import { appendNode, endRun, startRun } from "../../src/runs/ledger.js";

function runCli(register: (cli: ReturnType<typeof cac>) => void, args: string[], cwd: string) {
  const cli = cac("gk");
  register(cli);
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
  } catch (e) {
    logs.push(String(e));
  } finally {
    console.log = origLog;
    process.exit = origExit;
    process.chdir(origCwd);
  }
  const code = process.exitCode ? Number(process.exitCode) : exitCode;
  process.exitCode = 0; // fail() paths set process.exitCode=1 — reset so bun:test exits 0
  return { stdout: logs.join("\n"), code };
}

const runCli_ = (args: string[], cwd: string) => runCli(registerRunCommands, args, cwd);
const graphCli = (args: string[], cwd: string) => runCli(registerGraphCommands, args, cwd);

const GRAPH = `apiVersion: graphkit.dev/v2
kind: Graph
metadata:
  name: demo
topology: custom
nodes:
  a:
    agent: scout
    objective: A
    evidence: [a-out]
  b:
    agent: scout
    objective: B
    depend_on: [a]
`;

describe("gk run progress", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = join(tmpdir(), `gk-progress-${process.pid}-${Date.now()}`);
    mkdirSync(join(cwd, ".claude", "agents"), { recursive: true });
    writeFileSync(join(cwd, ".claude", "agents", "scout.md"), "# Scout\n");
    writeFileSync(join(cwd, "graph.yaml"), GRAPH);
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  test("startRun creates progress.md with a header", () => {
    const r = startRun(cwd, join(cwd, "graph.yaml"));
    const text = readFileSync(join(r.dir, "progress.md"), "utf-8");
    expect(text).toContain(`# Progress — run ${r.id}`);
    expect(text).toContain("- graph: demo");
    expect(text).toContain("- started_at:");
  });

  test("appends timestamped lines, with and without --node", () => {
    const r = startRun(cwd, join(cwd, "graph.yaml"));
    const a1 = JSON.parse(runCli_(["run", "progress", r.id, "scaffold done", "--node", "a"], cwd).stdout);
    expect(a1.status).toBe("ok");
    const a2 = JSON.parse(runCli_(["run", "progress", r.id, "free note"], cwd).stdout);
    expect(a2.status).toBe("ok");
    const text = readFileSync(join(r.dir, "progress.md"), "utf-8");
    expect(text).toMatch(/- \[\d{4}-\d{2}-\d{2}T[^\]]+\] \(a\) scaffold done\n/);
    expect(text).toMatch(/- \[\d{4}-\d{2}-\d{2}T[^\]]+\] free note\n/);
  });

  test("no note prints the file; --tail prints last N lines", () => {
    const r = startRun(cwd, join(cwd, "graph.yaml"));
    runCli_(["run", "progress", r.id, "one"], cwd);
    runCli_(["run", "progress", r.id, "two"], cwd);
    const whole = runCli_(["run", "progress", r.id], cwd).stdout;
    expect(whole).toContain("# Progress — run");
    expect(whole).toContain("] one");
    expect(whole).toContain("] two");
    const tail = runCli_(["run", "progress", r.id, "--tail", "1"], cwd).stdout;
    expect(tail).toContain("] two");
    expect(tail).not.toContain("] one");
    expect(tail).not.toContain("# Progress");
  });

  test("bogus run id fails RESUME_RUN_NOT_FOUND; missing id fails MISSING_ARG", () => {
    const bad = JSON.parse(runCli_(["run", "progress", "20990101-000000-nope", "x"], cwd).stdout);
    expect(bad.status).toBe("fail");
    expect(bad.error.code).toBe("RESUME_RUN_NOT_FOUND");
    const missing = JSON.parse(runCli_(["run", "progress"], cwd).stdout);
    expect(missing.status).toBe("fail");
    expect(missing.error.code).toBe("MISSING_ARG");
  });

  test("waves payload injects the active run's tail as ## Progress so far", () => {
    const r = startRun(cwd, join(cwd, "graph.yaml"));
    runCli_(["run", "progress", r.id, "scaffold done", "--node", "a"], cwd);
    const out = JSON.parse(graphCli(["graph", "waves", "graph.yaml"], cwd).stdout);
    expect(out.status).toBe("ok");
    for (const w of out.data.waves)
      for (const n of w.nodes) {
        expect(n.objective).toContain("## Progress so far");
        expect(n.objective).toContain("(a) scaffold done");
      }
  });

  test("progress_tail: 0 disables the injection", () => {
    writeFileSync(join(cwd, "graph.yaml"), `${GRAPH}progress_tail: 0\n`);
    const r = startRun(cwd, join(cwd, "graph.yaml"));
    runCli_(["run", "progress", r.id, "hidden note"], cwd);
    const out = JSON.parse(graphCli(["graph", "waves", "graph.yaml"], cwd).stdout);
    expect(out.status).toBe("ok");
    for (const w of out.data.waves) for (const n of w.nodes) expect(n.objective).not.toContain("Progress so far");
  });

  test("resume keeps the parent file and carries its tail into derived objectives", () => {
    const r = startRun(cwd, join(cwd, "graph.yaml"));
    mkdirSync(join(cwd, ".graphkit", "evidence"), { recursive: true });
    writeFileSync(join(cwd, ".graphkit", "evidence", "a-out.md"), "done\n");
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
    runCli_(["run", "progress", r.id, "a shipped its evidence", "--node", "a"], cwd);
    endRun(cwd, "failed");
    const res = JSON.parse(runCli_(["run", "resume", r.id], cwd).stdout);
    expect(res.status).toBe("ok");
    expect(res.data.resumed).toBe(true);
    // Parent progress.md untouched; child run gets its own fresh file.
    expect(readFileSync(join(cwd, ".graphkit", "runs", r.id, "progress.md"), "utf-8")).toContain(
      "a shipped its evidence",
    );
    const child = readFileSync(join(cwd, ".graphkit", "runs", res.data.run.id, "progress.md"), "utf-8");
    expect(child).toContain(`# Progress — run ${res.data.run.id}`);
    expect(child).not.toContain("a shipped its evidence");
    // Derived objectives carry the parent's tail.
    const derived = YAML.parse(readFileSync(res.data.session.path, "utf-8"));
    expect(derived.nodes.b.objective).toContain("## Progress so far");
    expect(derived.nodes.b.objective).toContain("(a) a shipped its evidence");
  });
});
