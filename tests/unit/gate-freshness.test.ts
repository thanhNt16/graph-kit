import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gateGraph } from "../../src/cli/commands/gate.js";
import { fingerprint } from "../../src/evidence/fingerprint.js";
import { type MarkerMeta, renderMarker } from "../../src/evidence/marker.js";

let repo: string;
let evDir: string;
beforeEach(() => {
  repo = join(tmpdir(), `gk-gatefp-${process.pid}-${Date.now()}`);
  mkdirSync(repo, { recursive: true });
  evDir = join(repo, ".graphkit", "evidence");
  mkdirSync(evDir, { recursive: true });
  execSync("git init -q && git config user.email t@t && git config user.name t && git commit -q --allow-empty -m e", {
    cwd: repo,
    shell: "/bin/bash",
  });
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

function markerFor(key: string, fp: { head: string | null; tree: string | null }): MarkerMeta {
  return {
    key,
    run_id: null,
    node: null,
    fingerprint_head: fp.head,
    fingerprint_tree: fp.tree,
    artifact: null,
    artifact_sha256: null,
    bytes: null,
    ts: null,
    note: null,
    superseded: null,
  };
}

describe("gateGraph freshness", () => {
  test("fresh marker → MERGE even strict; freshness map populated", () => {
    writeFileSync(join(evDir, "design.md"), renderMarker(markerFor("design", fingerprint(repo)), "body"));
    const r = gateGraph(["design"], evDir, { cwd: repo, strict: true });
    expect(r.verdict).toBe("MERGE");
    expect(r.freshness.design).toBe("fresh");
  });

  test("stale marker: report-mode MERGEs, strict BLOCKs", () => {
    const fp = fingerprint(repo);
    writeFileSync(
      join(evDir, "design.md"),
      renderMarker(markerFor("design", { head: fp.head, tree: "0".repeat(64) }), "body"),
    );
    expect(gateGraph(["design"], evDir, { cwd: repo }).verdict).toBe("MERGE");
    expect(gateGraph(["design"], evDir, { cwd: repo }).freshness.design).toBe("stale");
    const strict = gateGraph(["design"], evDir, { cwd: repo, strict: true });
    expect(strict.verdict).toBe("BLOCK");
  });

  test("strict freshness BLOCKs markerless (unknown) evidence with warning", () => {
    writeFileSync(join(evDir, "design.md"), "# plain legacy\n");
    // report mode unchanged
    expect(gateGraph(["design"], evDir, { cwd: repo }).verdict).toBe("MERGE");
    const r = gateGraph(["design"], evDir, { cwd: repo, strict: true });
    expect(r.verdict).toBe("BLOCK");
    expect(r.freshness.design).toBe("unknown");
    expect(r.warnings.length).toBe(1);
    expect(r.warnings[0]).toContain("design");
  });

  test("superseded evidence BLOCKs regardless of freshness", () => {
    const fp = fingerprint(repo);
    const m = { ...markerFor("design", fp), superseded: "superseded-by-v2" };
    writeFileSync(join(evDir, "design.md"), renderMarker(m, "body"));
    for (const strict of [false, true]) {
      const r = gateGraph(["design"], evDir, { cwd: repo, strict });
      expect(r.verdict).toBe("BLOCK");
      expect(r.missing).toEqual(["design"]);
      expect(r.scorecard.design).toBe("missing");
    }
  });

  test("require_landed BLOCKs ok-but-unlanded node evidence", () => {
    const fp = fingerprint(repo);
    writeFileSync(join(evDir, "design.md"), renderMarker(markerFor("design", fp), "body"));
    const runs = join(repo, ".graphkit", "runs");
    mkdirSync(join(runs, "run-1"), { recursive: true });
    writeFileSync(
      join(runs, "run-1", "trace.jsonl"),
      `${JSON.stringify({ at: "t0", node: "build", model: null, status: "ok", evidence: ["design"], duration_ms: 1, notes: null })}\n`,
    );
    writeFileSync(
      join(runs, "index.jsonl"),
      `${JSON.stringify({ id: "run-1", graph: "graph.yaml", graph_sha256: "x", started_at: "t0", ended_at: "t1", status: "blocked", node_count: 1, failures: 0, evidence_keys: ["design"] })}\n`,
    );
    // landed trace → MERGE
    mkdirSync(join(runs, "run-2"), { recursive: true });
    writeFileSync(
      join(runs, "run-2", "trace.jsonl"),
      `${JSON.stringify({ at: "t0", node: "build", model: null, status: "ok", evidence: ["design"], duration_ms: 1, notes: null, landed: { at: "t1", commit: "abc" } })}\n`,
    );
    writeFileSync(join(runs, "index.jsonl"), `${JSON.stringify({ id: "run-2", graph: "graph.yaml", graph_sha256: "x", started_at: "t0", ended_at: "t1", status: "merged", node_count: 1, failures: 0, evidence_keys: ["design"] })}\n`);
    expect(gateGraph(["design"], evDir, { cwd: repo, requireLanded: true }).verdict).toBe("MERGE");
    // latest run (index row 2 = run-2) landed → swap to run-1 (unlanded) as last row
    writeFileSync(join(runs, "index.jsonl"), `${JSON.stringify({ id: "run-1", graph: "graph.yaml", graph_sha256: "x", started_at: "t0", ended_at: "t1", status: "blocked", node_count: 1, failures: 0, evidence_keys: ["design"] })}\n`);
    const r = gateGraph(["design"], evDir, { cwd: repo, requireLanded: true });
    expect(r.verdict).toBe("BLOCK");
    expect(r.unlanded).toEqual(["build"]);
    // without requireLanded the same tree MERGEs
    expect(gateGraph(["design"], evDir, { cwd: repo }).verdict).toBe("MERGE");
  });

  test("no cwd option → unknown freshness, verdict unchanged", () => {
    writeFileSync(join(evDir, "design.md"), "body\n");
    const r = gateGraph(["design"], evDir);
    expect(r.verdict).toBe("MERGE");
    expect(r.freshness.design).toBe("unknown");
  });

  test("stale missing key still just missing", () => {
    const r = gateGraph(["design"], evDir, { cwd: repo, strict: true });
    expect(r.verdict).toBe("BLOCK");
    expect(r.missing).toEqual(["design"]);
    expect(r.freshness.design).toBe("unknown");
  });
});
