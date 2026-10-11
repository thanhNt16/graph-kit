import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { GraphKitError } from "../../src/errors.js";
import { appendNode, startRun } from "../../src/runs/ledger.js";
import { normalizeFailureText, recordRound, signatureSimilarity } from "../../src/runs/loops.js";
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

const GRAPH_SIM = `${GRAPH}\n    no_progress_similarity: 0.85`;

function setup(name: string, graph = GRAPH): string {
  const cwd = join(tmpdir(), `gk-loops-${name}-${process.pid}-${Date.now()}`);
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(cwd, "graph.yaml"), graph);
  startRun(cwd, join(cwd, "graph.yaml"));
  return cwd;
}

/** One round of both nodes failing, with `implement` producing the given
 * test-report evidence bytes (or none when null). */
function failRound(cwd: string, evidence: string | null) {
  if (evidence != null) {
    mkdirSync(join(cwd, ".graphkit/evidence"), { recursive: true });
    writeFileSync(join(cwd, ".graphkit/evidence/test-report.md"), evidence);
  }
  for (const node of ["implement", "test"]) {
    appendNode(cwd, {
      node,
      wave: 1,
      agent: null,
      model: null,
      status: "fail",
      evidence: node === "implement" && evidence != null ? ["test-report"] : [],
      duration_ms: null,
      notes: null,
    });
  }
}

function readJournalLines(cwd: string, run: string, stem = "0") {
  return readFileSync(join(cwd, ".graphkit/runs", run, `rounds/${stem}.jsonl`), "utf-8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
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
      // Task 2 envelope: coded failures are GraphKitError with a stable code,
      // not a message text prefix.
      try {
        recordRound(cwd, 3);
        throw new Error("expected LOOP_GROUP_MISSING");
      } catch (e) {
        expect(e).toBeInstanceOf(GraphKitError);
        expect((e as GraphKitError).code).toBe("LOOP_GROUP_MISSING");
      }
      const orphan = join(tmpdir(), `gk-loops-orphan-${process.pid}-${Date.now()}`);
      mkdirSync(orphan, { recursive: true });
      try {
        recordRound(orphan, 0);
        throw new Error("expected NO_ACTIVE_RUN");
      } catch (e) {
        expect(e).toBeInstanceOf(GraphKitError);
        expect((e as GraphKitError).code).toBe("NO_ACTIVE_RUN");
      }
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

  test("no_progress_similarity accepts [0,1] and rejects out-of-range", () => {
    const base = YAML.parse(GRAPH_SIM) as { loops: { no_progress_similarity?: number }[] };
    expect(GraphSchema.safeParse(base).success).toBe(true);
    for (const ok of [0, 0.5, 1])
      expect(
        GraphSchema.safeParse({ ...base, loops: [{ ...base.loops[0], no_progress_similarity: ok }] }).success,
      ).toBe(true);
    for (const bad of [-0.1, 1.01, 2])
      expect(
        GraphSchema.safeParse({ ...base, loops: [{ ...base.loops[0], no_progress_similarity: bad }] }).success,
      ).toBe(false);
  });
});

describe("normalizeFailureText", () => {
  test("strips paths, positions, timestamps, digests and numbers", () => {
    expect(normalizeFailureText("ENOENT /tmp/abc123/work/foo.ts:12 cannot open")).toBe("enoent <path> cannot open");
    expect(normalizeFailureText("failed at 2026-10-11T13:45:12Z commit 9f8e7d6a5b4c")).toBe(
      "failed at <ts> commit <id>",
    );
    expect(normalizeFailureText("timeout after 30s  \n\n retry 3")).toBe("timeout after <n> retry <n>");
    // Same failure in a different temp dir and line number normalizes identically.
    expect(
      normalizeFailureText("ENOENT /tmp/xyz789/tmp9/foo.ts:347 cannot open") ===
        normalizeFailureText("ENOENT /tmp/abc123/work/foo.ts:12 cannot open"),
    ).toBe(true);
  });
});

describe("signatureSimilarity", () => {
  test("Jaccard over 3-word shingles; short texts degrade to token sets", () => {
    expect(signatureSimilarity("a b c d e", "a b c d e")).toBe(1);
    expect(signatureSimilarity("a b c", "x y z")).toBe(0);
    const partial = signatureSimilarity("a b c d e", "a b c x y");
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThan(1);
    expect(signatureSimilarity("a b", "a c")).toBeCloseTo(1 / 3, 5);
    expect(signatureSimilarity("", "")).toBe(1);
  });
});

describe("recordRound with no_progress_similarity", () => {
  test("near-identical failure text trips no_progress via similarity", () => {
    const cwd = setup("sim", GRAPH_SIM);
    try {
      failRound(cwd, "ENOENT /tmp/abc123/work/foo.ts:12 cannot open\n");
      const r1 = recordRound(cwd, 0);
      expect(r1).toMatchObject({
        signature_similarity: null,
        similarity_threshold: 0.85,
        no_progress_via: null,
      });

      // Different bytes (path + line number) → different fingerprint, but the
      // normalized signature is identical → counts as no-progress.
      failRound(cwd, "ENOENT /tmp/xyz789/tmp9/foo.ts:347 cannot open\n");
      const r2 = recordRound(cwd, 0);
      expect(r2.fingerprint).not.toBe(r1.fingerprint);
      expect(r2.signature_similarity).toBe(1);
      expect(r2).toMatchObject({
        repeated: 2,
        no_progress_exhausted: true,
        stop_reason: "no_progress",
        no_progress_via: "similarity",
      });

      const journal = readJournalLines(cwd, r2.run);
      expect(journal).toHaveLength(2);
      expect(journal[1].signature).toContain("enoent <path> cannot open");
      expect(journal[1].signature_similarity).toBe(1);
      expect(journal[1].similarity_threshold).toBe(0.85);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("genuinely different errors do not extend the streak", () => {
    const cwd = setup("sim-diff", GRAPH_SIM);
    try {
      failRound(cwd, "ENOENT /tmp/abc123/foo.ts:12 cannot open\n");
      recordRound(cwd, 0);
      failRound(cwd, "TypeError: expected string, got object in serializer\n");
      const r2 = recordRound(cwd, 0);
      expect(r2.signature_similarity).not.toBeNull();
      expect(r2.signature_similarity as number).toBeLessThan(0.85);
      expect(r2).toMatchObject({
        repeated: 1,
        no_progress_exhausted: false,
        stop_reason: null,
        no_progress_via: null,
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("identical bytes still win as fingerprint, similarity stays null", () => {
    const cwd = setup("sim-fp", GRAPH_SIM);
    try {
      failRound(cwd, "ENOENT /tmp/abc123/foo.ts:12 cannot open\n");
      recordRound(cwd, 0);
      failRound(cwd, "ENOENT /tmp/abc123/foo.ts:12 cannot open\n");
      const r2 = recordRound(cwd, 0);
      expect(r2).toMatchObject({
        repeated: 2,
        signature_similarity: null,
        no_progress_exhausted: true,
        stop_reason: "no_progress",
        no_progress_via: "fingerprint",
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("mixed exact + similar rounds extend one streak to the limit", () => {
    const graph = GRAPH_SIM.replace("no_progress_limit: 2", "no_progress_limit: 3");
    const cwd = setup("sim-streak", graph);
    try {
      failRound(cwd, "ENOENT /tmp/aaa111/foo.ts:1 cannot open\n");
      recordRound(cwd, 0);
      // Similar (normalized-identical) to round 1.
      failRound(cwd, "ENOENT /tmp/bbb222/bar.ts:99 cannot open\n");
      const r2 = recordRound(cwd, 0);
      expect(r2.no_progress_via).toBeNull(); // streak 2 < limit 3 — no stop yet
      expect(r2.repeated).toBe(2);
      // Byte-identical to round 2 → fingerprint match on top of a similar streak.
      failRound(cwd, "ENOENT /tmp/bbb222/bar.ts:99 cannot open\n");
      const r3 = recordRound(cwd, 0);
      expect(r3).toMatchObject({
        repeated: 3,
        no_progress_exhausted: true,
        stop_reason: "no_progress",
        no_progress_via: "fingerprint",
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("threshold edge cases: 0 counts any differing round, 1 requires identical signature", () => {
    const zero = setup("sim-zero", `${GRAPH}\n    no_progress_similarity: 0`);
    try {
      failRound(zero, "ENOENT /tmp/abc123/foo.ts:12 cannot open\n");
      recordRound(zero, 0);
      failRound(zero, "TypeError: totally different failure class\n");
      const r2 = recordRound(zero, 0);
      expect(r2.signature_similarity).not.toBeNull();
      expect(r2).toMatchObject({ repeated: 2, stop_reason: "no_progress", no_progress_via: "similarity" });
    } finally {
      rmSync(zero, { recursive: true, force: true });
    }

    const one = setup("sim-one", `${GRAPH}\n    no_progress_similarity: 1`);
    try {
      failRound(one, "ENOENT /tmp/abc123/foo.ts:12 cannot open\n");
      recordRound(one, 0);
      // Same failure class but a different normalized tail → similarity < 1.
      failRound(one, "ENOENT /tmp/abc123/foo.ts:12 cannot open — also permission denied\n");
      const r2 = recordRound(one, 0);
      expect(r2.signature_similarity).not.toBeNull();
      expect(r2.signature_similarity as number).toBeLessThan(1);
      expect(r2).toMatchObject({ repeated: 1, no_progress_exhausted: false, stop_reason: null });
    } finally {
      rmSync(one, { recursive: true, force: true });
    }
  });

  test("unset similarity keeps byte-exact behavior and records no signature", () => {
    const cwd = setup("sim-unset", GRAPH);
    try {
      failRound(cwd, "ENOENT /tmp/abc123/foo.ts:12 cannot open\n");
      const r1 = recordRound(cwd, 0);
      failRound(cwd, "ENOENT /tmp/xyz789/foo.ts:34 cannot open\n");
      const r2 = recordRound(cwd, 0);
      expect(r2.fingerprint).not.toBe(r1.fingerprint);
      expect(r2).toMatchObject({
        repeated: 1,
        signature_similarity: null,
        similarity_threshold: null,
        no_progress_exhausted: false,
        stop_reason: null,
        no_progress_via: null,
      });
      const journal = readJournalLines(cwd, r2.run);
      expect("signature" in journal[0]).toBe(false);
      expect(journal[1].signature_similarity).toBeNull();
      expect(journal[1].similarity_threshold).toBeNull();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
