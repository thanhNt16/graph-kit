import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cac } from "cac";
import YAML from "yaml";
import { registerLearnCommand } from "../../src/cli/commands/learn.js";
import { promoteFailure } from "../../src/evidence/promote.js";
import { adoptProposal, evaluateProposal, listProposals, propose, revertProposal } from "../../src/learn/learn.js";
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
  name: learn-test
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
  cwd = join(tmpdir(), `gk-learn-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
        graph: "learn-test",
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
      graph: "learn-test",
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

const writeEvidence = (key: string, body = `# ${key}\n`) => {
  const dir = join(cwd, ".graphkit", "evidence");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${key}.md`), body);
};

function runCli(args: string[]) {
  const cli = cac("gk");
  registerLearnCommand(cli);
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

const readProposal = (id: string) =>
  YAML.parse(readFileSync(join(cwd, ".graphkit", "learn", `${id}.yaml`), "utf-8")) as Record<string, any>;
const writeProposal = (id: string, doc: Record<string, any>) =>
  writeFileSync(join(cwd, ".graphkit", "learn", `${id}.yaml`), YAML.stringify(doc));

describe("learn propose", () => {
  test("links the promoted case for the run", () => {
    seedRun("20260101-000001-a", { status: "blocked", trace: BLOCKED_TRACE });
    const promoted = promoteFailure(cwd, { run: "20260101-000001-a" });
    const result = propose(cwd, { run: "20260101-000001-a", note: "gate missed it" });
    expect(result.source_case).toBe(promoted.case_file);
    expect(result.warnings).toEqual([]);
    const doc = readProposal(result.id);
    expect(doc.status).toBe("proposed");
    expect(doc.source_run).toBe("20260101-000001-a");
    expect(doc.hypothesis).toBe("gate missed it");
    expect(doc.evaluation).toBeNull();
    expect(doc.adopted).toBeNull();
  });

  test("warns and leaves source_case null when nothing was promoted", () => {
    seedRun("20260101-000002-a", { status: "blocked", trace: BLOCKED_TRACE });
    const result = propose(cwd, { run: "20260101-000002-a" });
    expect(result.source_case).toBeNull();
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toContain("no promoted scenario");
    expect(readProposal(result.id).source_case).toBeNull();
  });
});

describe("learn evaluate", () => {
  test("records per-criterion verdicts against the recorded evidence dir", () => {
    seedRun("20260101-000003-a", { status: "blocked", trace: BLOCKED_TRACE });
    promoteFailure(cwd, { run: "20260101-000003-a" });
    const { id } = propose(cwd, { run: "20260101-000003-a" });
    writeEvidence("design"); // verdict still missing
    const result = evaluateProposal(cwd, id);
    expect(result.status).toBe("evaluated");
    expect(result.evidence_dir).toBe(".graphkit/evidence/");
    const verdicts = Object.fromEntries(result.verdicts.map((v) => [v.criterion, v.pass]));
    expect(verdicts.design).toBe(true);
    expect(verdicts.verdict).toBe(false);
    const doc = readProposal(id);
    expect(doc.status).toBe("evaluated");
    expect(doc.evaluation.verdicts.length).toBe(2);
    expect(doc.evaluation.after_fix).toBeNull();
    expect(doc.adopted).toBeNull();
  });

  test("records an empty verdict set when there is no source case", () => {
    seedRun("20260101-000004-a", { status: "blocked", trace: BLOCKED_TRACE });
    const { id } = propose(cwd, { run: "20260101-000004-a" });
    const result = evaluateProposal(cwd, id);
    expect(result.verdicts).toEqual([]);
    expect(result.warnings[0]).toContain("no source case");
  });
});

describe("learn adopt / reject / revert", () => {
  test("adopt refuses before evaluation and while criteria fail", () => {
    seedRun("20260101-000005-a", { status: "blocked", trace: BLOCKED_TRACE });
    promoteFailure(cwd, { run: "20260101-000005-a" });
    const { id } = propose(cwd, { run: "20260101-000005-a" });
    expect(() => adoptProposal(cwd, id)).toThrowError(/is proposed .* evaluate/);
    evaluateProposal(cwd, id); // design + verdict still missing → failing
    const doc = readProposal(id);
    doc.hypothesis = "when the gate misses freshness";
    doc.evidence = "run blocked with verdict evidence absent";
    writeProposal(id, doc);
    expect(() => adoptProposal(cwd, id)).toThrowError(/still fails 2 criterion/);
    expect(readProposal(id).status).toBe("evaluated");
  });

  test("adopt installs the proposed skill and revert removes it", () => {
    seedRun("20260101-000006-a", { status: "blocked", trace: BLOCKED_TRACE });
    promoteFailure(cwd, { run: "20260101-000006-a" });
    const { id } = propose(cwd, { run: "20260101-000006-a" });
    writeEvidence("design");
    writeEvidence("verdict");
    evaluateProposal(cwd, id);
    mkdirSync(join(cwd, "proposals"), { recursive: true });
    writeFileSync(join(cwd, "proposals", "missed-check.md"), "# missed-check\n\nCatch the failure earlier.\n");
    const doc = readProposal(id);
    doc.hypothesis = "use when the gate misses a criterion";
    doc.evidence = "run 20260101-000006-a blocked without verdict evidence";
    doc.proposal_kind = "skill";
    doc.proposes = { skill_path: "proposals/missed-check.md" };
    writeProposal(id, doc);

    const adopted = adoptProposal(cwd, id);
    expect(adopted.status).toBe("adopted");
    const installed = join(cwd, "kits", "_core", "skills", "missed-check", "SKILL.md");
    expect(existsSync(installed)).toBe(true);
    expect(readProposal(id).adopted.installed).toEqual(["kits/_core/skills/missed-check/SKILL.md"]);

    const reverted = revertProposal(cwd, id);
    expect(reverted.status).toBe("reverted");
    expect(reverted.removed).toEqual(["kits/_core/skills/missed-check/SKILL.md"]);
    expect(existsSync(installed)).toBe(false);
  });
});

describe("learn list + CLI surface", () => {
  test("list reports proposals with status", () => {
    seedRun("20260101-000007-a", { status: "blocked", trace: BLOCKED_TRACE });
    const { id } = propose(cwd, { run: "20260101-000007-a" });
    const rows = listProposals(cwd);
    expect(rows.length).toBe(1);
    expect(rows[0].id).toBe(id);
    expect(rows[0].status).toBe("proposed");
    const res = runCli(["learn", "list"]);
    expect(res.code).toBe(0);
    const env = JSON.parse(res.stdout) as { status: string; data: { proposals: { id: string }[] } };
    expect(env.status).toBe("ok");
    expect(env.data.proposals[0].id).toBe(id);
  });

  test("unknown subcommand fails with UNKNOWN_LEARN_SUBCOMMAND", () => {
    const res = runCli(["learn", "bogus"]);
    expect(res.code).not.toBe(0);
    expect(res.stdout).toContain("UNKNOWN_LEARN_SUBCOMMAND");
  });
});
