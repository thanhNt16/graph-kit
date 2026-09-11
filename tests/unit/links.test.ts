import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildLinks, neighborsOf, readLinks, writeLinks } from "../../src/memory/links.js";

function mem(dir: string, file: string, fm: Record<string, string>, body: string) {
  const head = Object.entries(fm)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  writeFileSync(join(dir, file), `---\n${head}\n---\n${body}`);
}

describe("link graph", () => {
  let memDir: string;
  beforeEach(() => {
    memDir = join(tmpdir(), `gk-links-${process.pid}-${Date.now()}`, ".graphkit", "memory");
    mkdirSync(join(memDir, "patterns"), { recursive: true });
  });
  afterEach(() => rmSync(join(memDir, "..", ".."), { recursive: true, force: true }));

  test("authored wikilinks become bidirectional edges", () => {
    mem(memDir, "a.md", { id: "a", type: "knowledge" }, "see [[b]] for detail\n");
    mem(memDir, "b.md", { id: "b", type: "knowledge" }, "standalone\n");
    const g = buildLinks(memDir, "2026-09-03T00:00:00.000Z");
    expect(neighborsOf(g, "a")).toContain("b");
    expect(neighborsOf(g, "b")).toContain("a");
  });

  test("shared source path links two entries without any wikilink", () => {
    mem(memDir, "a.md", { id: "a", type: "knowledge", source: ".graphkit/evidence/audit.md" }, "x\n");
    mem(memDir, "b.md", { id: "b", type: "knowledge" }, "derived from `.graphkit/evidence/audit.md`\n");
    const g = buildLinks(memDir, "2026-09-03T00:00:00.000Z");
    expect(neighborsOf(g, "a")).toContain("b");
  });

  test("entries sharing nothing are not linked", () => {
    mem(memDir, "a.md", { id: "a", type: "knowledge" }, "apples\n");
    mem(memDir, "b.md", { id: "b", type: "knowledge" }, "bicycles\n");
    expect(neighborsOf(buildLinks(memDir, "2026-09-03T00:00:00.000Z"), "a")).toEqual([]);
  });

  test("keys and neighbor arrays are sorted for byte-deterministic .links.json", () => {
    // Created out of alphabetical order: insertion order must not leak into output.
    mem(memDir, "z.md", { id: "z", type: "knowledge" }, "see [[a]]\n");
    mem(memDir, "m.md", { id: "m", type: "knowledge" }, "solo\n");
    mem(memDir, "a.md", { id: "a", type: "knowledge" }, "solo\n");
    const g = buildLinks(memDir, "2026-09-03T00:00:00.000Z");
    expect(Object.keys(g.links)).toEqual(["a", "m", "z"]);
    for (const ns of Object.values(g.links)) expect(ns).toEqual([...ns].sort());
  });

  test("subfolder entries participate in the graph", () => {
    mem(memDir, "a.md", { id: "a", type: "knowledge" }, "links to [[p1]]\n");
    mem(join(memDir, "patterns"), "p1.md", { id: "p1", type: "pattern" }, "seq\n");
    expect(neighborsOf(buildLinks(memDir, "2026-09-03T00:00:00.000Z"), "p1")).toContain("a");
  });

  test("corrupt .links.json reads as empty rather than throwing", () => {
    writeFileSync(join(memDir, ".links.json"), "{ not json");
    expect(readLinks(memDir).links).toEqual({});
  });

  test("write then read round-trips", () => {
    const g = { generated_at: "2026-09-03T00:00:00.000Z", links: { a: ["b"], b: ["a"] } };
    writeLinks(memDir, g);
    expect(readLinks(memDir)).toEqual(g);
  });

  test("over-shared entities are skipped, not pairwise-linked (O(m²) guard, round 4)", () => {
    // One entity cited by every entry used to add m(m-1)/2 edges — 5.8s at
    // n=5000. Beyond MAX_ENTITY_SUPPORT it carries no signal: no derived edges
    // from it, while small shared entities still link normally.
    for (let i = 0; i < 60; i += 1) {
      mem(memDir, `hub${i}.md`, { id: `hub${i}`, type: "knowledge" }, "mentions `.graphkit/evidence/shared.md`\n");
    }
    mem(memDir, "a.md", { id: "a", type: "knowledge" }, "references `src/only-two.md` and [[b]]\n");
    mem(memDir, "b.md", { id: "b", type: "knowledge" }, "references `src/only-two.md`\n");
    const g = buildLinks(memDir, "2026-09-03T00:00:00.000Z");
    // hub entries have no edges from the ubiquitous entity…
    expect(neighborsOf(g, "hub0")).toEqual([]);
    // …while the 2-entry entity still links and wikilinks still work.
    expect(neighborsOf(g, "a")).toEqual(["b"]);
  });
});
