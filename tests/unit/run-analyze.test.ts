import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cac } from "cac";
import { registerRunCommands } from "../../src/cli/commands/run.js";
import { analyzeRun } from "../../src/memory/analyze.js";
import type { AdvisorEvent, TraceLine } from "../../src/memory/ledger.js";
import type { JournalLine } from "../../src/memory/loops.js";

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const at = (offsetSec: number) => new Date(T0 + offsetSec * 1000).toISOString();
const line = (
  node: string,
  status: TraceLine["status"],
  offsetSec: number,
  duration_ms: number | null = null,
): TraceLine => ({
  at: at(offsetSec),
  node,
  wave: 0,
  agent: "a",
  model: "fable",
  status,
  evidence: [],
  duration_ms,
  notes: null,
});
const advisor = (node: string, offsetSec: number): AdvisorEvent => ({
  at: at(offsetSec),
  node,
  round: 1,
  tier: "fable",
  streak: null,
});

let cwd: string;
beforeEach(() => {
  cwd = join(tmpdir(), `gk-run-analyze-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(cwd, ".graphkit", "runs"), { recursive: true });
});
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function seedRun(
  id: string,
  opts: {
    started_at?: string;
    graph_path?: string;
    trace?: TraceLine[];
    advisors?: AdvisorEvent[];
    rounds?: JournalLine[][];
  } = {},
) {
  const dir = join(cwd, ".graphkit", "runs", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "meta.json"),
    JSON.stringify(
      { id, graph: "g", graph_path: opts.graph_path, graph_sha256: "x", started_at: opts.started_at ?? at(0) },
      null,
      2,
    ),
  );
  if (opts.trace) writeFileSync(join(dir, "trace.jsonl"), `${opts.trace.map((l) => JSON.stringify(l)).join("\n")}\n`);
  if (opts.advisors)
    writeFileSync(join(dir, "advisor.jsonl"), `${opts.advisors.map((e) => JSON.stringify(e)).join("\n")}\n`);
  if (opts.rounds) {
    mkdirSync(join(dir, "rounds"), { recursive: true });
    for (const [group, lines] of opts.rounds.entries())
      writeFileSync(join(dir, "rounds", `${group}.jsonl`), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  }
  return dir;
}

function runCli(args: string[]) {
  const cli = cac("gk");
  registerRunCommands(cli);
  const logs: string[] = [];
  const origLog = console.log;
  const origCwd = process.cwd();
  const origExit = process.exit;
  const exitCode = 0;
  console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
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

const journal = (round: number, fingerprint: string): JournalLine => ({
  round,
  at: at(round),
  fingerprint,
  up_to: round,
});

describe("analyzeRun telemetry", () => {
  test("computes node counts, escalation hit-rate, retries, and evidence-gated suggestions", () => {
    seedRun("20260101-000001-a", {
      trace: [
        line("a", "ok", 0.5),
        line("b", "fail", 1, 4000),
        line("b", "fail", 1.5, 4100),
        line("b", "fail", 2, 3900),
        line("c", "fail", 2.5),
        line("c", "ok", 3),
        line("d", "fail", 3.5),
        line("e", "challenge", 4),
      ],
      advisors: [advisor("c", 2.5), advisor("d", 3.5)],
    });
    const r = analyzeRun(cwd, "20260101-000001-a");
    expect(r.run_id).toBe("20260101-000001-a");
    expect(r.duration_ms).toBe(4000);
    expect(r.nodes).toEqual({ ok: 2, fail: 5, skipped: 0, challenge: 1 });
    expect(r.escalations).toEqual({ advisor_fired: 2, advisor_then_ok: 1 });
    expect(r.retries).toEqual({ b: 2, c: 1 });
    expect(r.suggestions).toEqual([
      "advisor escalation for d did not unblock; consider raising effort or timeout_ms",
      "repeated b failures at ~4s suggest a premise problem, not transient",
      "challenge raised on e but never adjudicated",
    ]);
  });

  test("challenge followed by a re-dispatch counts as adjudicated", () => {
    seedRun("20260101-000001-a", { trace: [line("f", "challenge", 1), line("f", "ok", 2)] });
    const r = analyzeRun(cwd, "20260101-000001-a");
    expect(r.suggestions).toEqual([]);
  });

  test("clean small run emits no suggestions (no-dissent prompt needs >10 nodes)", () => {
    seedRun("20260101-000001-a", { trace: [line("a", "ok", 1), line("b", "ok", 2), line("c", "ok", 3)] });
    expect(analyzeRun(cwd, "20260101-000001-a").suggestions).toEqual([]);
  });

  test("large clean run with zero dissent asks whether peers know premises are challengeable", () => {
    const trace = Array.from({ length: 11 }, (_, i) => line(`n${i}`, "ok", i + 1));
    seedRun("20260101-000001-a", { trace });
    const r = analyzeRun(cwd, "20260101-000001-a");
    expect(r.suggestions).toEqual([
      "no dissent observed across 11 node executions — are peers aware their premises are challengeable? (gk run node <id> --status challenge records dissent)",
    ]);
  });

  test("dissimilar failure durations do not trigger the premise suggestion", () => {
    seedRun("20260101-000001-a", {
      trace: [line("b", "fail", 1, 4000), line("b", "fail", 2, 4100), line("b", "fail", 3, 40000)],
    });
    const r = analyzeRun(cwd, "20260101-000001-a");
    expect(r.suggestions).toEqual([]);
  });

  test("loops: rounds, no-progress stalls, exhaustion via graph limits, eval-gate judging", () => {
    const graphPath = join(cwd, "graph.yaml");
    writeFileSync(
      graphPath,
      [
        "apiVersion: graphkit.dev/v2",
        "kind: Graph",
        "metadata:",
        "  name: t",
        "topology: diamond",
        "nodes:",
        "  g:",
        "    agent: a",
        "    objective: o",
        "    role: eval-gate",
        "loops:",
        "  - nodes: [g]",
        "    max_rounds: 5",
        "    no_progress_limit: 2",
        "    gate_evidence: [k]",
        "",
      ].join("\n"),
    );
    seedRun("20260101-000001-a", {
      graph_path: graphPath,
      trace: [line("g", "ok", 1)],
      rounds: [[journal(1, "X"), journal(2, "X")]],
    });
    const r = analyzeRun(cwd, "20260101-000001-a");
    expect(r.loops).toEqual({ rounds: 2, no_progress_stops: 1, exhausted: true, judged: 1, gate: "ok" });
  });

  test("progressing loop is not exhausted; unreadable graph degrades loops without failing", () => {
    seedRun("20260101-000001-a", {
      graph_path: join(cwd, "missing.yaml"),
      trace: [line("h", "fail", 1), line("h", "fail", 2)],
      rounds: [[journal(1, "X"), journal(2, "Y")]],
    });
    const r = analyzeRun(cwd, "20260101-000001-a");
    expect(r.loops).toEqual({ rounds: 2, no_progress_stops: 0, exhausted: false, judged: 0, gate: null });
  });
});

describe("gk run analyze CLI", () => {
  test("fails with NO_RUNS when nothing exists", () => {
    const { stdout, code } = runCli(["run", "analyze"]);
    const parsed = JSON.parse(stdout) as { status: string; error: { code: string } };
    expect(parsed.status).toBe("fail");
    expect(parsed.error.code).toBe("NO_RUNS");
    expect(code).toBe(1);
  });

  test("defaults to the active run, then the most recent run; explicit id wins", () => {
    seedRun("20260101-000001-a", { trace: [line("old", "ok", 1)] });
    seedRun("20260101-000002-b", { trace: [line("new", "ok", 1)] });
    expect(analyzeRun(cwd).run_id).toBe("20260101-000002-b");

    const active = join(cwd, ".graphkit", "runs", "20260101-000001-a");
    writeFileSync(join(cwd, ".graphkit", "runs", ".active"), active);
    expect(analyzeRun(cwd).run_id).toBe("20260101-000001-a");

    const { stdout, code } = runCli(["run", "analyze", "20260101-000002-b"]);
    const parsed = JSON.parse(stdout) as { status: string; data: { run_id: string } };
    expect(parsed.status).toBe("ok");
    expect(parsed.data.run_id).toBe("20260101-000002-b");
    expect(code).toBe(0);
  });

  test("unknown run id fails with RUN_NOT_FOUND", () => {
    const { stdout } = runCli(["run", "analyze", "20990101-000000-z"]);
    expect((JSON.parse(stdout) as { error: { code: string } }).error.code).toBe("RUN_NOT_FOUND");
  });

  test("challenge status is recordable and surfaces in analyze output", () => {
    const dir = seedRun("20260101-000001-a", { trace: [line("x", "fail", 1)] });
    writeFileSync(join(cwd, ".graphkit", "runs", ".active"), dir);
    const bad = JSON.parse(runCli(["run", "node", "x", "--status", "nope"]).stdout) as { error: { code: string } };
    expect(bad.error.code).toBe("BAD_STATUS");
    const good = JSON.parse(runCli(["run", "node", "x", "--status", "challenge"]).stdout) as { status: string };
    expect(good.status).toBe("ok");
    const analyzed = JSON.parse(runCli(["run", "analyze"]).stdout) as {
      data: { nodes: { challenge: number }; suggestions: string[] };
    };
    expect(analyzed.data.nodes.challenge).toBe(1);
    expect(analyzed.data.suggestions).toEqual(["challenge raised on x but never adjudicated"]);
  });
});
