import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { appendNode, startRun } from "../../src/memory/ledger.js";
import { recordRound } from "../../src/memory/loops.js";
import { GraphSchema } from "../../src/schemas/graph.schema.js";

const GRAPH = [
  "apiVersion: graphkit.dev/v2",
  "kind: Graph",
  "metadata:",
  "  name: loop-graph",
  "topology: diamond",
  "outputs:",
  "  evidence_dir: .graphkit/evidence/",
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
].join("\n");

function setup(name: string): string {
  const cwd = join(tmpdir(), `gk-loops-${name}-${process.pid}-${Date.now()}`);
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(cwd, "graph.yaml"), GRAPH);
  startRun(cwd, join(cwd, "graph.yaml"));
  return cwd;
}

describe("recordRound", () => {
  test("no_progress exhausts on identical failing rounds", () => {
    const cwd = setup("np");
    try {
      // Round 1: both nodes fail, evidence unchanged (missing both rounds).
      appendNode(cwd, {
        node: "implement",
        wave: 1,
        agent: null,
        model: null,
        status: "fail",
        evidence: [],
        duration_ms: null,
        notes: null,
      });
      appendNode(cwd, {
        node: "test",
        wave: 1,
        agent: null,
        model: null,
        status: "fail",
        evidence: [],
        duration_ms: null,
        notes: null,
      });
      const r1 = recordRound(cwd, 0);
      expect(r1).toMatchObject({ round: 1, repeated: 1, no_progress_exhausted: false, stop_reason: null });

      // Round 2: byte-identical state → same fingerprint, limit 2 → exhaust.
      appendNode(cwd, {
        node: "implement",
        wave: 1,
        agent: null,
        model: null,
        status: "fail",
        evidence: [],
        duration_ms: null,
        notes: null,
      });
      appendNode(cwd, {
        node: "test",
        wave: 1,
        agent: null,
        model: null,
        status: "fail",
        evidence: [],
        duration_ms: null,
        notes: null,
      });
      const r2 = recordRound(cwd, 0);
      expect(r2).toMatchObject({ round: 2, repeated: 2, no_progress_exhausted: true, stop_reason: "no_progress" });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("status change breaks the streak and resets repeated", () => {
    const cwd = setup("streak");
    try {
      appendNode(cwd, {
        node: "implement",
        wave: 1,
        agent: null,
        model: null,
        status: "fail",
        evidence: [],
        duration_ms: null,
        notes: null,
      });
      appendNode(cwd, {
        node: "test",
        wave: 1,
        agent: null,
        model: null,
        status: "fail",
        evidence: [],
        duration_ms: null,
        notes: null,
      });
      recordRound(cwd, 0);
      // Same statuses but one node now writes an evidence key (content differs) → progress.
      appendNode(cwd, {
        node: "implement",
        wave: 1,
        agent: null,
        model: null,
        status: "ok",
        evidence: ["test-report"],
        duration_ms: null,
        notes: null,
      });
      mkdirSync(join(cwd, ".graphkit/evidence"), { recursive: true });
      writeFileSync(join(cwd, ".graphkit/evidence/test-report.md"), "all green\n");
      appendNode(cwd, {
        node: "test",
        wave: 1,
        agent: null,
        model: null,
        status: "fail",
        evidence: [],
        duration_ms: null,
        notes: null,
      });
      const r2 = recordRound(cwd, 0);
      expect(r2).toMatchObject({ round: 2, repeated: 1, no_progress_exhausted: false, stop_reason: null });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("identical evidence bytes but fresh ok status is still no-progress only when statuses match", () => {
    const cwd = setup("bytes");
    try {
      appendNode(cwd, {
        node: "implement",
        wave: 1,
        agent: null,
        model: null,
        status: "ok",
        evidence: ["test-report"],
        duration_ms: null,
        notes: null,
      });
      mkdirSync(join(cwd, ".graphkit/evidence"), { recursive: true });
      appendFileSync(join(cwd, ".graphkit/evidence/test-report.md"), "failing\n");
      appendNode(cwd, {
        node: "test",
        wave: 1,
        agent: null,
        model: null,
        status: "fail",
        evidence: [],
        duration_ms: null,
        notes: null,
      });
      const r1 = recordRound(cwd, 0);
      expect(r1.no_progress_exhausted).toBe(false);

      appendNode(cwd, {
        node: "implement",
        wave: 1,
        agent: null,
        model: null,
        status: "ok",
        evidence: ["test-report"],
        duration_ms: null,
        notes: null,
      });
      appendNode(cwd, {
        node: "test",
        wave: 1,
        agent: null,
        model: null,
        status: "fail",
        evidence: [],
        duration_ms: null,
        notes: null,
      });
      const r2 = recordRound(cwd, 0);
      // Same statuses + same evidence bytes → identical fingerprint despite "ok".
      expect(r2.repeated).toBe(2);
      expect(r2.stop_reason).toBe("no_progress");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("max_rounds reported when budget exhausted without no-progress", () => {
    const cwd = setup("max");
    try {
      for (let round = 1; round <= 4; round++) {
        appendNode(cwd, {
          node: "implement",
          wave: 1,
          agent: null,
          model: null,
          status: "ok",
          evidence: ["test-report"],
          duration_ms: null,
          notes: null,
        });
        mkdirSync(join(cwd, ".graphkit/evidence"), { recursive: true });
        // Evidence content changes each round → genuine progress.
        appendFileSync(join(cwd, ".graphkit/evidence/test-report.md"), `round ${round}\n`);
        appendNode(cwd, {
          node: "test",
          wave: 1,
          agent: null,
          model: null,
          status: "fail",
          evidence: [],
          duration_ms: null,
          notes: null,
        });
        const r = recordRound(cwd, 0);
        if (round < 4) expect(r.stop_reason).toBeNull();
        else expect(r).toMatchObject({ round: 4, stop_reason: "max_rounds" });
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("no limit configured → never exhausts on no-progress", () => {
    const cwd = join(tmpdir(), `gk-loops-nolimit-${process.pid}-${Date.now()}`);
    mkdirSync(cwd, { recursive: true });
    try {
      writeFileSync(
        join(cwd, "graph.yaml"),
        GRAPH.split("\n")
          .filter((l) => !l.includes("no_progress_limit"))
          .join("\n"),
      );
      startRun(cwd, join(cwd, "graph.yaml"));
      appendNode(cwd, {
        node: "implement",
        wave: 1,
        agent: null,
        model: null,
        status: "fail",
        evidence: [],
        duration_ms: null,
        notes: null,
      });
      appendNode(cwd, {
        node: "test",
        wave: 1,
        agent: null,
        model: null,
        status: "fail",
        evidence: [],
        duration_ms: null,
        notes: null,
      });
      recordRound(cwd, 0);
      appendNode(cwd, {
        node: "implement",
        wave: 1,
        agent: null,
        model: null,
        status: "fail",
        evidence: [],
        duration_ms: null,
        notes: null,
      });
      appendNode(cwd, {
        node: "test",
        wave: 1,
        agent: null,
        model: null,
        status: "fail",
        evidence: [],
        duration_ms: null,
        notes: null,
      });
      const r2 = recordRound(cwd, 0);
      expect(r2.no_progress_exhausted).toBe(false);
      expect(r2.stop_reason).toBeNull();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("missing group or run fails with typed errors", () => {
    const cwd = setup("errors");
    try {
      expect(() => recordRound(cwd, 3)).toThrow(/^LOOP_GROUP_MISSING:/);
      const orphan = join(tmpdir(), `gk-loops-orphan-${process.pid}-${Date.now()}`);
      mkdirSync(orphan, { recursive: true });
      expect(() => recordRound(orphan, 0)).toThrow(/^NO_ACTIVE_RUN:/);
      rmSync(orphan, { recursive: true, force: true });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("journal survives process restarts via up_to cursor", () => {
    const cwd = setup("journal");
    try {
      appendNode(cwd, {
        node: "implement",
        wave: 1,
        agent: null,
        model: null,
        status: "fail",
        evidence: [],
        duration_ms: null,
        notes: null,
      });
      appendNode(cwd, {
        node: "test",
        wave: 1,
        agent: null,
        model: null,
        status: "fail",
        evidence: [],
        duration_ms: null,
        notes: null,
      });
      recordRound(cwd, 0);
      // Simulate restart: fresh trace lines for round 2 (journal's up_to excludes round 1 lines).
      appendNode(cwd, {
        node: "implement",
        wave: 1,
        agent: null,
        model: null,
        status: "fail",
        evidence: [],
        duration_ms: null,
        notes: null,
      });
      appendNode(cwd, {
        node: "test",
        wave: 1,
        agent: null,
        model: null,
        status: "fail",
        evidence: [],
        duration_ms: null,
        notes: null,
      });
      const r2 = recordRound(cwd, 0);
      expect(r2.round).toBe(2);
      const journal = readFileSync(join(cwd, ".graphkit/runs", r2.run, "rounds/0.jsonl"), "utf-8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
      expect(journal).toHaveLength(2);
      expect(journal[1].up_to).toBe(4);
      expect(journal[1].fingerprint).toBe(journal[0].fingerprint);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("no_progress_limit schema", () => {
  test("accepts >= 2 and rejects 1", () => {
    const base = YAML.parse(GRAPH) as { loops: { no_progress_limit?: number }[] };
    expect(GraphSchema.safeParse(base).success).toBe(true);
    expect(GraphSchema.safeParse({ ...base, loops: [{ ...base.loops[0], no_progress_limit: 1 }] }).success).toBe(false);
  });
});
