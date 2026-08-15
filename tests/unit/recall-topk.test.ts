import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recallTopK } from "../../src/eval/memory-recall.js";

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
