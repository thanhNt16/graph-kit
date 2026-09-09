import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseMemoryFile, walkMemoryStore } from "../../src/memory/frontmatter.js";

const raw = (fm: string, body = "notes\n") => `---\n${fm}---\n${body}`;

describe("parseMemoryFile", () => {
  test("parses valid frontmatter and preserves the body verbatim", () => {
    const p = parseMemoryFile(raw("id: a\ntype: knowledge\nsalience: 0.5\n", "body line\n"), "a");
    expect(p).not.toBeNull();
    expect(p!.fm.id).toBe("a");
    expect(p!.fm.type).toBe("knowledge");
    expect(p!.fm.salience).toBe(0.5);
    expect(p!.body).toBe("\nbody line\n"); // body = everything after the closing delimiter
  });

  test("returns null for missing frontmatter, broken YAML, and schema misses", () => {
    expect(parseMemoryFile("no frontmatter at all\n", "x")).toBeNull();
    expect(parseMemoryFile("---\nid: x\ntags: [unclosed\n---\nbody\n", "x")).toBeNull();
    expect(parseMemoryFile("---\nid: x\nvalid_from: not-a-date\n---\nbody\n", "x")).toBeNull();
  });

  test("coerces legacy string tags exactly like traceMemory did", () => {
    // stringified flow sequence → array
    const a = parseMemoryFile(raw('id: a\ntype: knowledge\ntags: "[one, two]"\n'), "a");
    expect(a!.fm.tags).toEqual(["one", "two"]);
    // plain scalar string → []
    const b = parseMemoryFile(raw("id: b\ntype: knowledge\ntags: decay\n"), "b");
    expect(b!.fm.tags).toEqual([]);
    // unparseable string (would fail schema as a raw string) → [] → valid
    const c = parseMemoryFile(raw('id: c\ntype: knowledge\ntags: "[unclosed"\n'), "c");
    expect(c!.fm.tags).toEqual([]);
    // YAML list passes through untouched
    const d = parseMemoryFile(raw("id: d\ntype: knowledge\ntags: [x, y]\n"), "d");
    expect(d!.fm.tags).toEqual(["x", "y"]);
  });

  test("defaults id/type and preserves unknown keys (passthrough)", () => {
    const p = parseMemoryFile(raw("salience: 0.2\nponytail_note: custom\n"), "fallback-name");
    expect(p!.fm.id).toBe("fallback-name");
    expect(p!.fm.type).toBe("knowledge");
    expect((p!.fm as Record<string, unknown>).ponytail_note).toBe("custom");
    const empty = parseMemoryFile(raw('id: ""\ntype: ""\n'), "fallback");
    expect(empty!.fm.id).toBe("fallback");
    expect(empty!.fm.type).toBe("knowledge");
  });
});

describe("walkMemoryStore", () => {
  let memDir: string;
  beforeEach(() => {
    memDir = join(tmpdir(), `gk-fm-${process.pid}-${Date.now()}`);
    mkdirSync(join(memDir, "patterns"), { recursive: true });
    mkdirSync(join(memDir, ".hidden-dir"), { recursive: true });
  });
  afterEach(() => rmSync(memDir, { recursive: true, force: true }));
  const write = (file: string, content: string) => writeFileSync(join(memDir, file), content);

  test("walks root + one sublevel with store-relative file paths and absolute paths", () => {
    write("a.md", raw("id: a\ntype: knowledge\n"));
    write("patterns/p1.md", raw("id: p1\ntype: pattern\n"));
    write("notes.txt", "not markdown — ignored");
    const entries = walkMemoryStore(memDir);
    expect(entries.map((e) => e.file).sort()).toEqual(["a.md", "patterns/p1.md"]);
    const p1 = entries.find((e) => e.id === "p1")!;
    expect(p1.path).toBe(join(memDir, "patterns", "p1.md"));
    expect(p1.body).toBe("\nnotes\n");
  });

  test("does not descend past one sublevel", () => {
    mkdirSync(join(memDir, "patterns", "deeper"), { recursive: true });
    write("patterns/deeper/x.md", raw("id: x\ntype: knowledge\n"));
    expect(walkMemoryStore(memDir)).toEqual([]);
  });

  test("skips dot-dirs and the skip list; keeps other dotfiles untouched", () => {
    write(".hidden-dir/x.md", raw("id: x\ntype: knowledge\n"));
    write("index.md", raw("id: index\ntype: knowledge\n"));
    write("log.md", raw("id: log\ntype: knowledge\n"));
    write("a.md", raw("id: a\ntype: knowledge\n"));
    const entries = walkMemoryStore(memDir, { skip: ["index.md", "log.md"] });
    expect(entries.map((e) => e.id)).toEqual(["a"]);
  });

  test("drops malformed entries without aborting the walk", () => {
    write("broken.md", "---\nid: broken\ntags: [unclosed\n---\nbody\n");
    write("good.md", raw("id: good\ntype: knowledge\n"));
    const entries = walkMemoryStore(memDir);
    expect(entries.map((e) => e.id)).toEqual(["good"]);
  });

  test("coerces legacy string tags on the walk too (touchMemory bug fix substrate)", () => {
    write("legacy.md", raw("id: legacy\ntype: knowledge\ntags: decay\n"));
    const entries = walkMemoryStore(memDir);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.fm.tags).toEqual([]);
  });

  test("fallback id is the filename base, including in subfolders", () => {
    write("patterns/noid.md", raw("type: pattern\n"));
    const entries = walkMemoryStore(memDir);
    expect(entries.map((e) => e.id)).toEqual(["noid"]);
    expect(entries[0]!.file).toBe("patterns/noid.md");
  });

  test("missing store directory returns []", () => {
    expect(walkMemoryStore(join(memDir, "absent"))).toEqual([]);
  });
});
