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

  test("legacy marker (no frontmatter) → unknown, never blocks strict", () => {
    writeFileSync(join(evDir, "design.md"), "# plain legacy\n");
    const r = gateGraph(["design"], evDir, { cwd: repo, strict: true });
    expect(r.verdict).toBe("MERGE");
    expect(r.freshness.design).toBe("unknown");
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
