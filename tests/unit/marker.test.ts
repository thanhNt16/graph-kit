import { describe, expect, test } from "bun:test";
import { freshnessOf, type MarkerMeta, parseMarker, renderMarker } from "../../src/evidence/marker.js";

const meta: MarkerMeta = {
  key: "api-response",
  run_id: "20260905-090000-g",
  node: "probe",
  fingerprint_head: "a".repeat(40),
  fingerprint_tree: "b".repeat(64),
  artifact: "api-response/abc.json",
  artifact_sha256: "c".repeat(64),
  bytes: 8123,
  ts: "2026-09-05T09:00:00.000Z",
  note: "n",
};

describe("marker", () => {
  test("round-trips frontmatter", () => {
    const md = renderMarker(meta, 'Evidence artifact "api-response" recorded.');
    expect(parseMarker(md)).toEqual(meta);
  });

  test("legacy marker (no frontmatter) parses to null", () => {
    expect(parseMarker("# Just markdown\n")).toBeNull();
  });

  test("freshness: fresh / stale / unknown", () => {
    const cur = { head: "a".repeat(40), tree: "b".repeat(64) };
    expect(freshnessOf(meta, cur)).toBe("fresh");
    expect(freshnessOf({ ...meta, fingerprint_tree: null }, cur)).toBe("unknown"); // missing tree field
    expect(freshnessOf(meta, { head: "z".repeat(40), tree: "b".repeat(64) })).toBe("stale");
    expect(freshnessOf(meta, { head: null, tree: null })).toBe("unknown"); // non-git cwd
    expect(freshnessOf(null, cur)).toBe("unknown"); // legacy marker
  });

  // Round 4: raw `${String(note)}` interpolation emitted invalid YAML for notes
  // containing ": " or newlines — parseMarker returned null and gate freshness
  // silently degraded to "unknown" for a key the user just recorded.
  describe("hostile note round-trip (round 4)", () => {
    const hostile = [
      "blocked: needs review",
      "line one\nline two",
      "trailing #comment",
      'already "quoted"',
      "leading indicator: |block",
      "emoji 🚀 and unicode — dash",
      "",
    ];
    for (const note of hostile) {
      test(`note ${JSON.stringify(note)} round-trips`, () => {
        const md = renderMarker({ ...meta, note }, "body");
        const parsed = parseMarker(md);
        expect(parsed).not.toBeNull();
        expect(parsed?.note).toBe(note); // "" round-trips as ""
      });
    }
  });
});
