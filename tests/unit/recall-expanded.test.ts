// tests/unit/recall-expanded.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expandedRecall } from "../../src/memory/recall-expanded.js";

function entry(dir: string, file: string, fm: Record<string, unknown>, body: string) {
  const head = Object.entries(fm)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join("\n");
  writeFileSync(join(dir, file), `---\n${head}\n---\n${body}`);
}

describe("expanded recall", () => {
  let memDir: string;
  beforeEach(() => {
    const root = join(tmpdir(), `gk-recall-exp-${process.pid}-${Date.now()}`);
    memDir = join(root, ".graphkit", "memory");
    mkdirSync(join(memDir, "patterns"), { recursive: true });
  });
  afterEach(() => rmSync(join(memDir, "..", ".."), { recursive: true, force: true }));

  test("searches root and subfolders together, ranked across both", () => {
    entry(memDir, "auth.md", { id: "auth", type: "knowledge", salience: 0.5 }, "oauth token rotation notes\n");
    entry(
      memDir,
      "patterns/p1.md",
      { id: "pattern-p1", type: "pattern", salience: 1.0 },
      "oauth refresh sequence seen often\n",
    );
    const r = expandedRecall(memDir, "oauth", 5, "2026-09-03T00:00:00.000Z");
    expect(r.results.map((h) => h.id)).toEqual(["pattern-p1", "auth"]); // 2×1.0 beats 1×0.5
    expect(r.results[0].file).toBe("patterns/p1.md");
    expect(r.results.every((h) => h.linked === false)).toBe(true);
  });

  test("hits carry the store-relative path for single-file reinforcement", () => {
    entry(memDir, "auth.md", { id: "auth", type: "knowledge", salience: 0.5 }, "oauth token rotation notes\n");
    entry(
      memDir,
      "patterns/p1.md",
      { id: "pattern-p1", type: "pattern", salience: 1.0 },
      "oauth refresh sequence seen often\n",
    );
    const r = expandedRecall(memDir, "oauth", 5, "2026-09-03T00:00:00.000Z");
    expect(r.results.find((h) => h.id === "auth")?.path).toBe("auth.md");
    expect(r.results.find((h) => h.id === "pattern-p1")?.path).toBe("patterns/p1.md");
    // score = keyword overlap × salience, what the ranker ranked on
    expect(r.results.find((h) => h.id === "pattern-p1")?.score).toBeCloseTo(1.0);
    expect(r.results.find((h) => h.id === "auth")?.score).toBeCloseTo(0.5);
  });

  test("link neighbors fill remaining slots below direct hits", () => {
    entry(
      memDir,
      "auth.md",
      { id: "auth", type: "knowledge", salience: 1.0 },
      "oauth token rotation\nsee [[tokens]]\n",
    );
    entry(memDir, "tokens.md", { id: "tokens", type: "knowledge", salience: 1.0 }, "jwt signing keys\n");
    // ponytail: hand-written fixture — JSON-quoted frontmatter ids in the brief's
    // entry() helper don't round-trip through links.ts' raw-regex id parse, so
    // buildLinks keys would never match. Upgrade path: links.ts strips quotes.
    writeFileSync(
      join(memDir, ".links.json"),
      JSON.stringify({ generated_at: "2026-09-03T00:00:00.000Z", links: { auth: ["tokens"] } }),
    );
    const r = expandedRecall(memDir, "oauth", 2, "2026-09-03T00:00:00.000Z");
    const ids = r.results.map((h) => h.id);
    expect(ids[0]).toBe("auth");
    expect(ids).toContain("tokens"); // joined via [[wikilink]], penalized
    expect(r.results.find((h) => h.id === "tokens")?.linked).toBe(true);
  });

  test("direct hits always outrank linked neighbors", () => {
    entry(memDir, "auth.md", { id: "auth", type: "knowledge", salience: 1.0 }, "oauth\nsee [[tokens]]\n");
    entry(memDir, "tokens.md", { id: "tokens", type: "knowledge", salience: 1.0 }, "oauth too, mentions tokens\n");
    const r = expandedRecall(memDir, "oauth", 2, "2026-09-03T00:00:00.000Z");
    expect(r.results.every((h) => h.linked === false)).toBe(true); // both direct: no room for linked
  });

  // A2: link expansion used to pull from the UNFILTERED doc list, so an
  // expired or superseded memory could resurface (and get reinforced) as a
  // [linked] hit — the documented filters must apply to neighbors too.
  test("expired neighbor reachable only via links never surfaces", () => {
    entry(memDir, "auth.md", { id: "auth", type: "knowledge", salience: 1.0 }, "oauth\nsee [[oldnote]]\n");
    entry(
      memDir,
      "oldnote.md",
      { id: "oldnote", type: "knowledge", salience: 1.0, expired: true },
      "outdated advice\n",
    );
    writeFileSync(
      join(memDir, ".links.json"),
      JSON.stringify({ generated_at: "2026-09-03T00:00:00.000Z", links: { auth: ["oldnote"] } }),
    );
    const r = expandedRecall(memDir, "oauth", 5, "2026-09-03T00:00:00.000Z");
    expect(r.results.map((h) => h.id)).toEqual(["auth"]);
  });

  test("superseded neighbor reachable only via links never surfaces", () => {
    entry(memDir, "auth.md", { id: "auth", type: "knowledge", salience: 1.0 }, "oauth\nsee [[v1]]\n");
    entry(memDir, "v1.md", { id: "v1", type: "knowledge", salience: 1.0, superseded_by: "v2" }, "stale policy\n");
    entry(memDir, "v2.md", { id: "v2", type: "knowledge", salience: 1.0 }, "current policy\n");
    writeFileSync(
      join(memDir, ".links.json"),
      JSON.stringify({ generated_at: "2026-09-03T00:00:00.000Z", links: { auth: ["v1"] } }),
    );
    const r = expandedRecall(memDir, "oauth", 5, "2026-09-03T00:00:00.000Z");
    expect(r.results.map((h) => h.id)).toEqual(["auth"]); // v1 dropped; v2 not a link neighbor
  });

  test("malformed store entries are counted in the result", () => {
    entry(memDir, "auth.md", { id: "auth", type: "knowledge", salience: 0.5 }, "oauth notes\n");
    writeFileSync(join(memDir, "broken.md"), "---\ntags: [unclosed\n---\nbody");
    const r = expandedRecall(memDir, "oauth", 5, "2026-09-03T00:00:00.000Z");
    expect(r.malformed).toBe(1);
    expect(r.results.map((h) => h.id)).toEqual(["auth"]);
  });

  test("empty store returns empty", () => {
    expect(expandedRecall(memDir, "anything", 5, "2026-09-03T00:00:00.000Z").results).toEqual([]);
  });
});
