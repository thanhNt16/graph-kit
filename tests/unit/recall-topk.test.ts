import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recallTopK, recallWithStats } from "../../src/eval/memory-recall.js";

const NOW = "2026-08-15T00:00:00.000Z";

describe("recallTopK", () => {
  let dir: string;
  test("ranks by overlap×salience, filters expired/superseded/future", () => {
    dir = join(tmpdir(), `gk-rtk-${process.pid}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const w = (f: string, fm: string, body: string) => writeFileSync(join(dir, f), `---\n${fm}---\n${body}`);
    w("hit.md", "id: hit\nsalience: 0.8\nexpired: false\n", "graph validation entry point function\n");
    w("gone.md", "id: gone\nsalience: 0.9\nexpired: true\n", "graph validation entry point function\n");
    w(
      "future.md",
      "id: future\nsalience: 0.9\nvalid_from: 2027-01-01T00:00:00.000Z\nexpired: false\n",
      "graph validation entry point function\n",
    );
    const top = recallTopK(dir, "graph validation entry point", 5, NOW);
    expect(top.map((h) => h.id)).toEqual(["hit"]); // only the live one survives
    rmSync(dir, { recursive: true, force: true });
  });
  test("superseded head resolves to successor", () => {
    dir = join(tmpdir(), `gk-rtk2-${process.pid}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const w = (f: string, fm: string, body: string) => writeFileSync(join(dir, f), `---\n${fm}---\n${body}`);
    w("v1.md", "id: v1\nsalience: 0.9\nsuperseded_by: v2\nexpired: false\n", "routing strategy\n");
    w("v2.md", "id: v2\nsalience: 0.4\nexpired: false\n", "routing strategy current\n");
    const top = recallTopK(dir, "routing strategy", 5, NOW);
    expect(top.map((h) => h.id)).toEqual(["v2"]); // head replaced by successor
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("recallWithStats (exec-tests step 3 — strict reader)", () => {
  const mk = (name: string) => join(tmpdir(), `gk-rws-${name}-${process.pid}-${Date.now()}`);
  const w = (dir: string, f: string, fm: string, body: string) => writeFileSync(join(dir, f), `---\n${fm}---\n${body}`);
  let dir: string;

  test("returns results + malformed count; malformed validity dates are dropped AND counted", () => {
    dir = mk("malformed");
    mkdirSync(dir, { recursive: true });
    w(dir, "good.md", "id: good\nsalience: 0.8\nexpired: false\n", "eval harness determinism pins\n");
    w(dir, "bad.md", "id: bad\nsalience: 0.95\nvalid_from: not-a-date\n", "eval harness determinism pins\n");
    const { results, malformed } = recallWithStats(dir, "eval harness determinism pins", 5, NOW);
    expect(results.map((r) => r.id)).toEqual(["good"]); // bad dropped despite higher salience
    expect(malformed).toBe(1); // counted, not silently swallowed
    rmSync(dir, { recursive: true, force: true });
  });

  test("missing directory returns empty results, malformed 0 (ENOENT tolerated)", () => {
    const { results, malformed } = recallWithStats(mk("absent"), "anything", 5, NOW);
    expect(results).toEqual([]);
    expect(malformed).toBe(0);
  });

  test("ENOTDIR (path is a file, not a dir) is also tolerated as empty", () => {
    const filePath = mk("notdir");
    writeFileSync(filePath, "plain file");
    const { results, malformed } = recallWithStats(filePath, "anything", 5, NOW);
    expect(results).toEqual([]);
    expect(malformed).toBe(0);
    rmSync(filePath, { force: true });
  });

  test("non-ENOENT/ENOTDIR fs errors are surfaced (EACCES throws, never silent-empty)", () => {
    dir = mk("eacces");
    mkdirSync(dir, { recursive: true });
    w(dir, "secret.md", "id: secret\n", "locked content\n");
    chmodSync(dir, 0o000);
    try {
      // Running as root would defeat chmod; skip in that environment.
      if (process.getuid?.() === 0) return;
      expect(() => recallWithStats(dir, "locked content", 5, NOW)).toThrow();
    } finally {
      chmodSync(dir, 0o755);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reserved index.md / log.md are ignored, never recalled", () => {
    dir = mk("reserved");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "index.md"), "---\nid: index\n---\ngraph validation entry point function\n");
    writeFileSync(join(dir, "log.md"), "---\nid: log\n---\ngraph validation entry point function\n");
    const { results, malformed } = recallWithStats(dir, "graph validation entry point", 5, NOW);
    expect(results).toEqual([]);
    expect(malformed).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  test("configured top-k is honored (k=1 returns exactly one hit)", () => {
    dir = mk("topk");
    mkdirSync(dir, { recursive: true });
    w(dir, "a.md", "id: a\nsalience: 0.9\nexpired: false\n", "routing strategy current\n");
    w(dir, "b.md", "id: b\nsalience: 0.8\nexpired: false\n", "routing strategy current\n");
    const { results } = recallWithStats(dir, "routing strategy current", 1, NOW);
    expect(results.length).toBe(1);
    expect(results[0].id).toBe("a");
    rmSync(dir, { recursive: true, force: true });
  });
});
