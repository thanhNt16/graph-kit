import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cac } from "cac";
import YAML from "yaml";
import { registerRunCommands } from "../../src/cli/commands/run.js";
import { validateGraph } from "../../src/compiler/validate.js";
import { GraphKitError } from "../../src/errors.js";
import { addEvidence } from "../../src/evidence/store.js";
import { appendNode, startRun } from "../../src/runs/ledger.js";
import { recordPoll, recordRound } from "../../src/runs/loops.js";
import { GraphSchema } from "../../src/schemas/graph.schema.js";

const HEADER = [
  "apiVersion: graphkit.dev/v2",
  "kind: Graph",
  "metadata:",
  "  name: kinds-graph",
  "topology: custom",
].join("\n");

function graphYaml(loopsBlock: string): string {
  return [
    HEADER,
    "nodes:",
    "  implement:",
    "    agent: haiku",
    "    objective: write code",
    "    evidence: [test-report]",
    "loops:",
    loopsBlock,
  ].join("\n");
}

function setup(name: string, yaml: string): string {
  const cwd = join(tmpdir(), `gk-loop-kinds-${name}-${process.pid}-${Date.now()}`);
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(cwd, "graph.yaml"), yaml);
  startRun(cwd, join(cwd, "graph.yaml"));
  return cwd;
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
}

/** Non-git tmpdirs fingerprint as {head:null,tree:null}, so any markerless
 *  artifact is "unknown" — which satisfies the non-stale check. Stale/fresh
 *  assertions need a real repo: git init + commit gives a live fingerprint. */
function setupGit(name: string, yaml: string): string {
  const cwd = setup(name, yaml);
  git(cwd, ["init", "-q"]);
  git(cwd, ["add", "-A"]);
  git(cwd, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]);
  return cwd;
}

function stampEvidence(cwd: string, key: string, node = "implement"): void {
  const graph = GraphSchema.parse(YAML.parse(readFileSync(join(cwd, "graph.yaml"), "utf-8")));
  const src = join(cwd, ".graphkit", "runs", "stamps", `${key}.md`);
  mkdirSync(join(cwd, ".graphkit", "runs", "stamps"), { recursive: true });
  writeFileSync(src, `body for ${key}\n`);
  addEvidence(cwd, graph, { file: src, key, node });
}

function failOnce(cwd: string, node = "implement"): void {
  appendNode(cwd, {
    node,
    wave: 1,
    agent: null,
    model: null,
    status: "fail",
    evidence: [],
    duration_ms: null,
    notes: null,
  });
}

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
  process.exitCode = 0;
  return { stdout: logs.join("\n"), code };
}

const baseDoc = (loops: unknown) => ({
  apiVersion: "graphkit.dev/v2",
  kind: "Graph",
  metadata: { name: "k" },
  topology: "custom",
  nodes: { a: { agent: "x", objective: "o" } },
  loops,
});

describe("loop kind schema", () => {
  test("kind defaults to judged and judged still requires an exit", () => {
    const okDoc = baseDoc([{ nodes: ["a"], max_rounds: 3, stop_when: "done" }]);
    const parsed = GraphSchema.safeParse(okDoc);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.loops![0].kind).toBe("judged");

    for (const doc of [
      baseDoc([{ nodes: ["a"], max_rounds: 3 }]),
      baseDoc([{ nodes: ["a"], max_rounds: 3, kind: "judged" }]),
    ]) {
      const r = GraphSchema.safeParse(doc);
      expect(r.success).toBe(false);
      if (!r.success) expect(r.error.issues.some((i) => i.message.includes("stop_when or gate_evidence"))).toBe(true);
    }
  });

  test("polling requires a poll block; counting requires exit_when", () => {
    expect(GraphSchema.safeParse(baseDoc([{ nodes: ["a"], max_rounds: 3, kind: "polling" }])).success).toBe(false);
    expect(GraphSchema.safeParse(baseDoc([{ nodes: ["a"], max_rounds: 3, kind: "counting" }])).success).toBe(false);
    const polled = GraphSchema.safeParse(
      baseDoc([{ nodes: ["a"], max_rounds: 3, kind: "polling", poll: { evidence_key: "deploy" } }]),
    );
    expect(polled.success).toBe(true);
    if (polled.success) {
      expect(polled.data.loops![0].poll).toEqual({
        evidence_key: "deploy",
        interval_ms: 5000,
        max_wait_ms: 600000,
      });
    }
    const counted = GraphSchema.safeParse(
      baseDoc([{ nodes: ["a"], max_rounds: 3, kind: "counting", exit_when: { rounds_eq: 2 } }]),
    );
    expect(counted.success).toBe(true);
  });

  test("empty exit_when and unknown kinds are rejected", () => {
    const empty = GraphSchema.safeParse(baseDoc([{ nodes: ["a"], max_rounds: 3, kind: "counting", exit_when: {} }]));
    expect(empty.success).toBe(false);
    if (!empty.success) expect(empty.error.issues.some((i) => i.message.includes("at least one predicate"))).toBe(true);
    expect(GraphSchema.safeParse(baseDoc([{ nodes: ["a"], max_rounds: 3, kind: "spinning" }])).success).toBe(false);
  });
});

describe("counting loop kind", () => {
  test("exits when every evidence_all_fresh key is satisfied", () => {
    const cwd = setup(
      "count-ev",
      graphYaml(
        "  - nodes: [implement]\n    max_rounds: 4\n    kind: counting\n    exit_when: { evidence_all_fresh: [test-report] }",
      ),
    );
    try {
      failOnce(cwd);
      const r1 = recordRound(cwd, 0);
      expect(r1.kind).toBe("counting");
      expect(r1.stop_reason).toBeNull();
      expect(r1.check).toMatchObject({ predicate: "exit_when", satisfied: false, all_fresh: false });

      mkdirSync(join(cwd, ".graphkit/evidence"), { recursive: true });
      writeFileSync(join(cwd, ".graphkit/evidence/test-report.md"), "all green\n");
      const r2 = recordRound(cwd, 0);
      expect(r2.stop_reason).toBe("condition_met");
      expect(r2.check).toMatchObject({ satisfied: true, all_fresh: true });
      expect((r2.check!.evidence as Record<string, string>)["test-report"]).toBe("unknown"); // no git → unknown
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("stale marker does not satisfy; a fresh re-stamp does", () => {
    const cwd = setupGit(
      "count-stale",
      graphYaml(
        "  - nodes: [implement]\n    max_rounds: 4\n    kind: counting\n    exit_when: { evidence_all_fresh: [test-report] }",
      ),
    );
    try {
      stampEvidence(cwd, "test-report");
      // Head moved past the stamp's fingerprint → marker is stale.
      git(cwd, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "bump"]);
      const r1 = recordRound(cwd, 0);
      expect((r1.check!.evidence as Record<string, string>)["test-report"]).toBe("stale");
      expect(r1.stop_reason).toBeNull();

      stampEvidence(cwd, "test-report"); // re-stamp against the new head
      const r2 = recordRound(cwd, 0);
      expect((r2.check!.evidence as Record<string, string>)["test-report"]).toBe("fresh");
      expect(r2.stop_reason).toBe("condition_met");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("rounds_eq exits deterministically without evidence", () => {
    const cwd = setup(
      "count-eq",
      graphYaml("  - nodes: [implement]\n    max_rounds: 4\n    kind: counting\n    exit_when: { rounds_eq: 2 }"),
    );
    try {
      failOnce(cwd);
      const r1 = recordRound(cwd, 0);
      expect(r1.stop_reason).toBeNull();
      failOnce(cwd);
      const r2 = recordRound(cwd, 0);
      expect(r2).toMatchObject({ round: 2, stop_reason: "condition_met" });
      expect(r2.check).toMatchObject({ rounds_eq: 2, satisfied: true });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("no_progress_limit still applies across kinds", () => {
    const cwd = setup(
      "count-np",
      graphYaml(
        "  - nodes: [implement]\n    max_rounds: 4\n    kind: counting\n    exit_when: { evidence_all_fresh: [test-report] }\n    no_progress_limit: 2",
      ),
    );
    try {
      failOnce(cwd);
      const r1 = recordRound(cwd, 0);
      expect(r1.stop_reason).toBeNull();
      failOnce(cwd);
      const r2 = recordRound(cwd, 0);
      expect(r2.stop_reason).toBe("no_progress");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("polling loop kind", () => {
  const POLL_YAML =
    "  - nodes: [implement]\n    max_rounds: 10\n    kind: polling\n    poll: { evidence_key: deploy-status, interval_ms: 100, max_wait_ms: 600000 }";

  test("satisfied when the marker lands", () => {
    const cwd = setup("poll-met", graphYaml(POLL_YAML));
    try {
      const p1 = recordPoll(cwd, 0);
      expect(p1.kind).toBe("polling");
      expect(p1.stop_reason).toBeNull();
      expect(p1.check).toMatchObject({ predicate: "poll", evidence_key: "deploy-status", satisfied: false });

      mkdirSync(join(cwd, ".graphkit/evidence"), { recursive: true });
      writeFileSync(join(cwd, ".graphkit/evidence/deploy-status.md"), "live\n");
      const p2 = recordPoll(cwd, 0);
      expect(p2.stop_reason).toBe("condition_met");
      expect(p2.check).toMatchObject({ satisfied: true, state: "unknown" });
      // Journal records kind + check for readers.
      const lines = readFileSync(join(cwd, ".graphkit/runs", p2.run, "rounds/0.jsonl"), "utf-8")
        .trim()
        .split("\n");
      const last = JSON.parse(lines[lines.length - 1]);
      expect(last.kind).toBe("polling");
      expect(last.check.predicate).toBe("poll");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("max_wait_ms exhaustion yields poll_timeout", () => {
    const cwd = setup("poll-wait", graphYaml(POLL_YAML));
    try {
      const p1 = recordPoll(cwd, 0, "2026-01-01T00:00:00.000Z");
      expect(p1.stop_reason).toBeNull();
      const p2 = recordPoll(cwd, 0, "2026-01-01T00:11:00.000Z"); // +660s > 600s
      expect(p2.stop_reason).toBe("poll_timeout");
      expect(p2.check).toMatchObject({ bound: "max_wait_ms", elapsed_ms: 660000 });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("max_rounds exhaustion yields poll_timeout", () => {
    const cwd = setup(
      "poll-rounds",
      graphYaml(
        "  - nodes: [implement]\n    max_rounds: 2\n    kind: polling\n    poll: { evidence_key: deploy-status }",
      ),
    );
    try {
      const p1 = recordPoll(cwd, 0);
      expect(p1.stop_reason).toBeNull();
      const p2 = recordPoll(cwd, 0);
      expect(p2.stop_reason).toBe("poll_timeout");
      expect(p2.check).toMatchObject({ bound: "max_rounds" });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("no_progress breaker fires before the poll clock", () => {
    const cwd = setup(
      "poll-np",
      graphYaml(
        "  - nodes: [implement]\n    max_rounds: 10\n    kind: polling\n    poll: { evidence_key: deploy-status }\n    no_progress_limit: 2",
      ),
    );
    try {
      recordPoll(cwd, 0);
      const p2 = recordPoll(cwd, 0);
      expect(p2.stop_reason).toBe("no_progress");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("recordPoll refuses non-polling groups; CLI surfaces it", () => {
    const cwd = setup("poll-kind", graphYaml("  - nodes: [implement]\n    max_rounds: 4\n    stop_when: done"));
    try {
      try {
        recordPoll(cwd, 0);
        throw new Error("expected LOOP_KIND_MISMATCH");
      } catch (e) {
        expect(e).toBeInstanceOf(GraphKitError);
        expect((e as GraphKitError).code).toBe("LOOP_KIND_MISMATCH");
      }
      const res = runCli(["run", "poll", "0"], cwd);
      expect(res.code).toBe(1);
      expect(JSON.parse(res.stdout).error.code).toBe("LOOP_KIND_MISMATCH");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("gk run poll drives a polling group and rejects bad args", () => {
    const cwd = setup("poll-cli", graphYaml(POLL_YAML));
    try {
      const res = runCli(["run", "poll", "0"], cwd);
      expect(res.code).toBe(0);
      const out = JSON.parse(res.stdout);
      expect(out.status).toBe("ok");
      expect(out.data.kind).toBe("polling");
      expect(out.data.check.predicate).toBe("poll");
      expect(JSON.parse(runCli(["run", "poll", "x"], cwd).stdout).error.code).toBe("BAD_ARG");
      expect(JSON.parse(runCli(["run", "poll"], cwd).stdout).error.code).toBe("MISSING_ARG");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("kind coherence findings (validate)", () => {
  const lint = (loopsBlock: string) => {
    const graph = GraphSchema.parse(YAML.parse(graphYaml(loopsBlock)));
    return validateGraph(graph, tmpdir());
  };

  test("warns on judged fields on mechanical kinds and missing poll key", () => {
    const withStop = lint(
      "  - nodes: [implement]\n    max_rounds: 4\n    kind: counting\n    stop_when: done\n    exit_when: { rounds_eq: 2 }",
    );
    expect(withStop.some((f) => f.check === "loop_kind_fields" && f.severity === "warn")).toBe(true);

    const noKey = lint("  - nodes: [implement]\n    max_rounds: 4\n    kind: polling\n    poll: { interval_ms: 100 }");
    expect(noKey.some((f) => f.check === "loop_poll_evidence_key" && f.severity === "warn")).toBe(true);
  });

  test("warns when a mechanical key is produced by no node", () => {
    const findings = lint(
      "  - nodes: [implement]\n    max_rounds: 4\n    kind: counting\n    exit_when: { evidence_all_fresh: [ghost-key] }",
    );
    expect(findings.some((f) => f.check === "loop_mechanical_evidence" && f.message.includes("ghost-key"))).toBe(true);
    // ...but not when the loop's own node produces it.
    const clean = lint(
      "  - nodes: [implement]\n    max_rounds: 4\n    kind: counting\n    exit_when: { evidence_all_fresh: [test-report] }",
    );
    expect(clean.some((f) => f.check === "loop_mechanical_evidence")).toBe(false);
  });
});
