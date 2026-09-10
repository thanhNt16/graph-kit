import { describe, expect, it } from "bun:test";
import { renderRecallAscii, renderRecallHtml } from "../src/memory/render-recall.js";

describe("renderRecall", () => {
  const sampleExplanation = {
    query: "auth token expiry",
    query_terms: ["auth", "token", "expiry"],
    now: "2026-09-10T14:00:00Z",
    k: 3,
    scanned_count: 15,
    malformed_count: 0,
    hits: [
      {
        id: "mem-a1b2",
        file: "knowledge/token-ttl.md",
        matched_terms: ["auth", "token", "expiry"],
        raw_salience: 0.14,
        final_score: 0.42,
        status: "hit" as const,
      },
      {
        id: "mem-e5f6",
        file: "suggestions/renewal.md",
        matched_terms: ["expiry"],
        raw_salience: 0.07,
        final_score: 0.035,
        status: "hit" as const,
        linked_via: "mem-a1b2",
        linked_penalty: 0.5,
      },
    ],
    rejected_top_n: [
      {
        id: "mem-9a8b",
        file: "legacy/token.md",
        matched_terms: ["auth", "token"],
        raw_salience: 0.1,
        final_score: 0.2,
        status: "filtered" as const,
        reason: "superseded" as const,
        superseded_by: "mem-a1b2",
      },
      {
        id: "mem-7c6d",
        file: "old.md",
        matched_terms: ["auth"],
        raw_salience: 0.05,
        final_score: 0.05,
        status: "filtered" as const,
        reason: "expired" as const,
      },
    ],
  };

  it("renders expected ASCII table layout", () => {
    const ascii = renderRecallAscii(sampleExplanation);
    expect(ascii).toContain('recall: "auth token expiry"');
    expect(ascii).toContain("HITS");
    expect(ascii).toContain("mem-a1b2");
    expect(ascii).toContain("0.035*");
    expect(ascii).toContain("linked via mem-a1b2");
    expect(ascii).toContain("REJECTED");
    expect(ascii).toContain("superseded by mem-a1b2");
  });

  it("renders standalone self-contained HTML page", () => {
    const html = renderRecallHtml(sampleExplanation);
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("auth token expiry");
    expect(html).toContain("knowledge/token-ttl.md");
    expect(html).toContain("mem-a1b2");
    expect(html).toContain("Archify");
  });
});
