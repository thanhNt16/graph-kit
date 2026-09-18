import { describe, expect, it } from "bun:test";
import { renderRecallAscii, renderRecallHtml } from "../../src/memory/render-recall.js";

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
        ppr_mass: 0.42,
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
      {
        id: "mem-0a1b",
        file: "unrelated.md",
        matched_terms: [],
        raw_salience: 0.1,
        final_score: 0,
        status: "rejected" as const,
        reason: "zero_overlap" as const,
      },
    ],
  };

  it("renders expected ASCII table layout", () => {
    const ascii = renderRecallAscii(sampleExplanation);
    expect(ascii).toContain('recall: "auth token expiry"');
    expect(ascii).toContain("HITS");
    expect(ascii).toContain("mem-a1b2");
    expect(ascii).toContain("0.035*");
    expect(ascii).toContain("linked via mem-a1b2 (ppr 0.42)");
    expect(ascii).toContain("REJECTED");
    expect(ascii).toContain("superseded by mem-a1b2");
    expect(ascii).toContain("ZERO_OVERLAP");
    expect(ascii).toContain("no term overlap with query");
  });

  it("renders standalone self-contained HTML page", () => {
    const html = renderRecallHtml(sampleExplanation);
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("auth token expiry");
    expect(html).toContain("knowledge/token-ttl.md");
    expect(html).toContain("mem-a1b2");
    expect(html).toContain("Archify");
    expect(html).toContain("prefers-color-scheme: light");
    expect(html).toContain("#020617");
    expect(html).toContain("#f8fafc");
  });

  it("escapes special HTML characters in content", () => {
    const unsafeExp = {
      ...sampleExplanation,
      query: '<script>alert("xss")</script> & "quote"',
      hits: [
        {
          ...sampleExplanation.hits[0],
          id: "mem<safe>",
          file: "path/to/<xss>.md",
        },
      ],
    };
    const html = renderRecallHtml(unsafeExp);
    expect(html).not.toContain('<script>alert("xss")</script>');
    expect(html).toContain("&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt; &amp; &quot;quote&quot;");
    expect(html).toContain("mem&lt;safe&gt;");
    expect(html).toContain("path/to/&lt;xss&gt;.md");
  });
});
