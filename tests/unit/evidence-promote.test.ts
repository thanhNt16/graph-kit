import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cac } from "cac";
import YAML from "yaml";
import { registerEvidenceCommand } from "../../src/cli/commands/evidence.js";
import { loadCriteria } from "../../src/evidence/criteria.js";
import { promoteFailure } from "../../src/evidence/promote.js";
import type { TraceLine } from "../../src/runs/ledger.js";

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const at = (offsetSec: number) => new Date(T0 + offsetSec * 1000).toISOString();
const line = (node: string, status: TraceLine["status"], offsetSec: number, evidence: string[] = []): TraceLine => ({
  at: at(offsetSec),
  node,
  wave: 0,
  agent: "a",
  model: "fable",
  status,
  evidence,
  duration_ms: 100,
  notes: null,
});

const GRAPH = `apiVersion: graphkit.dev/v2
kind: Graph
metadata:
  name: promote-test
topology: diamond
nodes:
  builder:
    agent: implementer
    objective: Build the thing and report back.
    depend_on: []
    evidence: [design]
  evaluator:
    agent: qa-engineer
    role: eval-gate
    objective: Grade strictly.
    depend_on: [builder]
    evidence: [verdict]
evidence:
  required_keys: [design, verdict]
  criteria: [verdict]
`;

let cwd: string;
beforeEach(() => {
  cwd = join(tmpdir(), `gk-promote-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(cwd, ".graphkit", "runs"), { recursive: true });
  writeFileSync(join(cwd, "graph.yaml"), GRAPH);
});
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function seedRun(id: string, opts: { status?: "merged" | "blocked" | "failed"; trace?: TraceLine[] } = {}) {
  const dir = join(cwd, ".graphkit", "runs", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "meta.json"),
    JSON.stringify(
      {
        id,
        graph: "promote-test",
        graph_path: join(cwd, "graph.yaml"),
        graph_sha256: "x",
        started_at: at(0),
        ended_at: at(9),
      },
      null,
      2,
    ),
  );
  writeFileSync(join(dir, "trace.jsonl"), `${(opts.trace ?? []).map((l) => JSON.stringify(l)).join("\n")}\n`);
  writeFileSync(
    join(cwd, ".graphkit", "runs", "index.jsonl"),
    `${JSON.stringify({
      id,
      graph: "promote-test",
      graph_sha256: "x",
      started_at: at(0),
      ended_at: at(9),
      status: opts.status ?? "blocked",
      node_count: (opts.trace ?? []).length,
      failures: (opts.trace ?? []).filter((t) => t.status === "fail").length,
      evidence_keys: [],
    })}\n`,
  );
}

const BLOCKED_TRACE = [line("builder", "ok", 1, ["design"]), line("evaluator", "fail", 2, [])];

function runCli(args: string[]) {
  const cli = cac("gk");
  registerEvidenceCommand(cli);
  const logs: string[] = [];
  const origLog = console.log;
  const origCwd = process.cwd();
  console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  process.chdir(cwd);
  try {
    cli.parse(["node", "gk", ...args], { run: true });
  } finally {
    console.log = origLog;
    process.chdir(origCwd);
  }
  const code = process.exitCode ? Number(process.exitCode) : 0;
  process.exitCode = 0;
  return { stdout: logs.join("\n"), code };
}

describe("evidence promote", () => {
  test("promotes a blocked run into a loadable scenario fixture", () => {
    seedRun("20260101-000001-a", { status: "blocked", trace: BLOCKED_TRACE });
    const result = promoteFailure(cwd, { run: "20260101-000001-a" });
    expect(result.case_file).toBe(join("scenarios", "promoted", "20260101-000001-a-evaluator", "case.yaml"));
    expect(existsSync(join(cwd, result.case_file))).toBe(true);
    const doc = YAML.parse(readFileSync(join(cwd, result.case_file), "utf-8"));
    expect(doc.expected_verdict).toBe("BLOCK");
    expect(doc.category).toBe("regression");
    expect(doc.promoted_from.run_id).toBe("20260101-000001-a");
    expect(doc.promoted_from.node).toBe("evaluator"); // last failed eval-gate node
    expect(doc.failed_criteria).toEqual(["design", "verdict"]); // both keys absent from evidence dir
    expect(doc.node_statuses.evaluator).toBe("fail");
    expect(doc.node_statuses.builder).toBe("ok");
    expect(doc.input.required_keys).toEqual(["design", "verdict"]);
    expect(result.git_hint).toContain("git add");
  });

  test("exits non-zero on a clean/passed run — nothing to promote", () => {
    seedRun("20260101-000002-a", {
      status: "merged",
      trace: [line("builder", "ok", 1, ["design"]), line("evaluator", "ok", 2, ["verdict"])],
    });
    // Satisfy the evidence contract so the replayed gate merges.
    const evDir = join(cwd, ".graphkit", "evidence");
    mkdirSync(evDir, { recursive: true });
    writeFileSync(join(evDir, "design.md"), "# design\n");
    writeFileSync(join(evDir, "verdict.md"), "# verdict\n");
    expect(() => promoteFailure(cwd, { run: "20260101-000002-a" })).toThrowError(/no blocking verdict/);
    const res = runCli(["evidence", "promote", "--run", "20260101-000002-a"]);
    expect(res.code).not.toBe(0);
    expect(res.stdout).toContain("NOTHING_TO_PROMOTE");
  });

  test("--out redirects the scenario dir", () => {
    seedRun("20260101-000003-a", { status: "blocked", trace: BLOCKED_TRACE });
    const result = promoteFailure(cwd, { run: "20260101-000003-a", out: "fixtures/regressions" });
    expect(result.case_file).toBe(join("fixtures", "regressions", "20260101-000003-a-evaluator", "case.yaml"));
    expect(existsSync(join(cwd, result.case_file))).toBe(true);
  });

  test("--node overrides which node the scenario pins", () => {
    seedRun("20260101-000004-a", { status: "blocked", trace: BLOCKED_TRACE });
    const result = promoteFailure(cwd, { run: "20260101-000004-a", node: "builder" });
    const doc = YAML.parse(readFileSync(join(cwd, result.case_file), "utf-8"));
    expect(doc.promoted_from.node).toBe("builder");
    expect(doc.input.objective).toBe("Build the thing and report back.");
  });

  test("--holdout emits a sealed criterion the criteria loader accepts", () => {
    seedRun("20260101-000005-a", { status: "blocked", trace: BLOCKED_TRACE });
    const result = promoteFailure(cwd, { run: "20260101-000005-a", holdout: true });
    expect(result.holdout_file).toBe(join("criteria", "evaluator-regression-20260101-000005-a.holdout.md"));
    const criteria = loadCriteria(cwd, ["evaluator-regression-20260101-000005-a"]);
    const c = criteria.get("evaluator-regression-20260101-000005-a");
    expect(c).toBeDefined();
    expect(c!.holdout).toBe(true);
    expect(c!.kind).toBe("report");
    expect(c!.description).toContain("20260101-000005-a");
    expect(c!.description).toContain("REGRESSES");
  });

  test("unknown run id fails", () => {
    expect(() => promoteFailure(cwd, { run: "20260101-999999-nope" })).toThrowError(/no run/);
  });
});
