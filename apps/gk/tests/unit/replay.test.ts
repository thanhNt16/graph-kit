import { describe, expect, test } from "bun:test";
import { runGolden } from "../../src/eval/replay.js";
import { join } from "node:path";

const GOLDEN = join(import.meta.dir, "..", "..", "eval", "golden");

describe("runGolden", () => {
  test("runs all seed cases and aggregates", () => {
    const r = runGolden(GOLDEN);
    expect(r.total).toBeGreaterThanOrEqual(3);
    expect(r.results.length).toBe(r.total);
    expect(Object.keys(r.perCategory).length).toBeGreaterThan(0);
  });

  test("MERGE golden case scores MERGE", () => {
    const r = runGolden(GOLDEN);
    const merge = r.results.find((x) => x.id.includes("merge"));
    expect(merge?.actual).toBe("MERGE");
    expect(merge?.pass).toBe(true);
  });

  test("BLOCK golden case scores BLOCK", () => {
    const r = runGolden(GOLDEN);
    const block = r.results.find((x) => x.id.includes("block"));
    expect(block?.actual).toBe("BLOCK");
    expect(block?.pass).toBe(true);
  });
});
