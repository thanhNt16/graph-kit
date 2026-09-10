import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { explainRecall } from "../src/memory/explain-recall.js";

const TEST_DIR = join(process.cwd(), ".tmp-test-explain-memory");

describe("explainRecall", () => {
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("classifies direct hits, expired, superseded, and outranked docs", () => {
    // 1. Valid hit
    writeFileSync(
      join(TEST_DIR, "hit.md"),
      `---\nid: mem-hit\nsalience: 0.8\nstatus: stable\n---\nAuth token refresh workflow.`,
    );

    // 2. Expired doc
    writeFileSync(
      join(TEST_DIR, "expired.md"),
      `---\nid: mem-exp\nsalience: 0.9\nvalid_to: 2026-01-01T00:00:00Z\n---\nAuth token refresh legacy.`,
    );

    // 3. Superseded doc
    writeFileSync(
      join(TEST_DIR, "old.md"),
      `---\nid: mem-old\nsalience: 0.9\nsuperseded_by: mem-hit\n---\nAuth token refresh old.`,
    );

    // 4. Low salience outranked doc
    writeFileSync(
      join(TEST_DIR, "low.md"),
      `---\nid: mem-low\nsalience: 0.1\nstatus: stable\n---\nAuth token background.`,
    );

    const explanation = explainRecall(TEST_DIR, "auth token refresh", 1, "2026-09-10T00:00:00Z");

    expect(explanation.query).toBe("auth token refresh");
    expect(explanation.query_terms).toEqual(["auth", "token", "refresh"]);
    expect(explanation.hits.length).toBe(1);
    expect(explanation.hits[0].id).toBe("mem-hit");
    expect(explanation.hits[0].status).toBe("hit");
    expect(explanation.hits[0].raw_salience).toBe(0.8);
    expect(explanation.hits[0].final_score).toBeCloseTo(3 * 0.8, 5); // 3 terms * 0.8

    // Check rejected candidates
    const expDoc = explanation.rejected_top_n.find((d) => d.id === "mem-exp");
    expect(expDoc).toBeDefined();
    expect(expDoc?.status).toBe("filtered");
    expect(expDoc?.reason).toBe("expired");

    const oldDoc = explanation.rejected_top_n.find((d) => d.id === "mem-old");
    expect(oldDoc).toBeDefined();
    expect(oldDoc?.status).toBe("filtered");
    expect(oldDoc?.reason).toBe("superseded");
    expect(oldDoc?.superseded_by).toBe("mem-hit");

    const lowDoc = explanation.rejected_top_n.find((d) => d.id === "mem-low");
    expect(lowDoc).toBeDefined();
    expect(lowDoc?.status).toBe("rejected");
    expect(lowDoc?.reason).toBe("outranked");
  });

  it("applies 0.5x penalty to link-expanded neighbors", () => {
    writeFileSync(
      join(TEST_DIR, "root.md"),
      `---\nid: mem-root\nsalience: 0.8\nstatus: stable\n---\nDatabase connection pool configuration.`,
    );
    writeFileSync(
      join(TEST_DIR, "neighbor.md"),
      `---\nid: mem-neighbor\nsalience: 0.6\nstatus: stable\n---\nQuery timeout tuning.`,
    );
    writeFileSync(
      join(TEST_DIR, ".links.json"),
      JSON.stringify({
        generated_at: "2026-09-10T00:00:00Z",
        links: {
          "mem-root": ["mem-neighbor"],
        },
      }),
    );

    const explanation = explainRecall(TEST_DIR, "database connection", 2, "2026-09-10T00:00:00Z");
    expect(explanation.hits.length).toBe(2);
    expect(explanation.hits[0].id).toBe("mem-root");
    expect(explanation.hits[0].linked_via).toBeUndefined();

    expect(explanation.hits[1].id).toBe("mem-neighbor");
    expect(explanation.hits[1].linked_via).toBe("mem-root");
    expect(explanation.hits[1].linked_penalty).toBe(0.5);
    expect(explanation.hits[1].final_score).toBeCloseTo(0.6 * 0.5, 5);
  });

  it("classifies future-valid docs as not_yet_valid", () => {
    writeFileSync(
      join(TEST_DIR, "future.md"),
      `---\nid: mem-future\nsalience: 0.9\nvalid_from: 2026-12-01T00:00:00Z\n---\nAuth token refresh futuristic.`,
    );

    const explanation = explainRecall(TEST_DIR, "auth token refresh", 5, "2026-09-10T00:00:00Z");
    expect(explanation.hits.length).toBe(0);
    const futureDoc = explanation.rejected_top_n.find((d) => d.id === "mem-future");
    expect(futureDoc).toBeDefined();
    expect(futureDoc?.status).toBe("filtered");
    expect(futureDoc?.reason).toBe("not_yet_valid");
  });

  it("returns zero-overlap rejected docs and handles subfolders", () => {
    mkdirSync(join(TEST_DIR, "patterns"), { recursive: true });
    writeFileSync(
      join(TEST_DIR, "patterns", "unrelated.md"),
      `---\nid: mem-unrelated\nsalience: 0.95\nstatus: stable\n---\nCompletely different topic.`,
    );

    const explanation = explainRecall(TEST_DIR, "database connection", 5, "2026-09-10T00:00:00Z");
    expect(explanation.hits.length).toBe(0);
    expect(explanation.scanned_count).toBe(1);
    expect(explanation.rejected_top_n.length).toBe(1);
    expect(explanation.rejected_top_n[0].id).toBe("mem-unrelated");
    expect(explanation.rejected_top_n[0].file).toBe("patterns/unrelated.md");
    expect(explanation.rejected_top_n[0].reason).toBe("zero_overlap");
  });

  it("handles non-existent memory directory gracefully", () => {
    const explanation = explainRecall(join(TEST_DIR, "does-not-exist"), "query");
    expect(explanation.hits).toEqual([]);
    expect(explanation.rejected_top_n).toEqual([]);
    expect(explanation.scanned_count).toBe(0);
  });
});
