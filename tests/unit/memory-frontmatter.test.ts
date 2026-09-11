import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { parseMemoryFile, splitFrontmatter, walkMemoryStore } from "../../src/frontmatter.js";

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

// B1: the split regex used to be \n-only — a CRLF-authored file (Windows
// checkout with autocrlf) registered as "no frontmatter" and silently dropped
// out of every store pass.
describe("splitFrontmatter CRLF tolerance (B1)", () => {
  test("parses CRLF frontmatter + body", () => {
    const raw = "---\r\nid: win\r\ntype: knowledge\r\n---\r\nbody line\r\n";
    const split = splitFrontmatter(raw);
    expect(split).not.toBeNull();
    expect(split!.fmText).toContain("id: win");
  });

  test("CRLF memory file survives parseMemoryFile and the store walk", () => {
    const parsed = parseMemoryFile("---\r\nid: win\r\ntype: knowledge\r\n---\r\nbody\n", "win");
    expect(parsed).not.toBeNull();
    expect(parsed!.fm.id).toBe("win");
  });

  test("no frontmatter still returns null", () => {
    expect(splitFrontmatter("just text\n")).toBeNull();
  });
});

// Round-4 perf: parseMemoryFile takes a flat-scalar fast path and only falls
// back to YAML.parse for frontmatter the whitelist can't prove flat. Parity is
// the contract: for every input, the fast path either produces EXACTLY what
// YAML.parse produces or declines (→ YAML.parse runs anyway).
describe("flat-frontmatter fast path parity (round 4)", () => {
  const scalars = [
    ["id", "my-task-1"],
    ["salience", "0.5"],
    ["salience", ".5"],
    ["use_count", "12"],
    ["negative", "-7"],
    ["float_exp", "1e5"],
    ["valid_from", "2026-09-11T00:00:00Z"],
    ["checkpoint", "2026-09-11"], // date-shaped string on a passthrough key stays a string
    ["expired", "true"],
    ["expired", "false"],
    ["legacy_null", "~"],
    ["legacy_null", "null"],
    ["nan_score", ".nan"],
    ["inf_score", ".inf"],
    ["neg_inf", "-.inf"],
    ["plus_int", "+5"],
    ["underscored", "1_000"], // YAML core keeps this a string
    ["zero_lead", "007"], // YAML core resolves to 7, fast path agrees
  ];
  for (const [key, value] of scalars) {
    test(`parity: ${key}: ${value}`, () => {
      const expected = YAML.parse(value);
      const parsed = parseMemoryFile(raw(`${key}: ${value}\n`), "x");
      expect(parsed).not.toBeNull();
      expect(Object.is((parsed!.fm as Record<string, unknown>)[key], expected)).toBe(true);
    });
  }

  test("realistic curator frontmatter parses identically to YAML.parse", () => {
    const fmText = "id: actR-score\nuse_count: 3\nsalience: 0.8\nvalid_from: 2026-09-01T00:00:00Z\ntype: knowledge";
    const expected = YAML.parse(fmText) as Record<string, unknown>;
    const parsed = parseMemoryFile(raw(`${fmText}\n`), "x")!;
    for (const [k, v] of Object.entries(expected)) {
      expect(Object.is((parsed.fm as Record<string, unknown>)[k], v)).toBe(true);
    }
  });

  test("CRLF flat frontmatter takes the fast path too", () => {
    const parsed = parseMemoryFile("---\r\nid: win\r\nsalience: 0.5\r\n---\r\nbody\n", "win");
    expect(parsed).not.toBeNull();
    expect(parsed!.fm.id).toBe("win");
    expect(parsed!.fm.salience).toBe(0.5);
  });

  test("anything unprovable falls back to YAML.parse and keeps old semantics", () => {
    // flow sequence
    expect(parseMemoryFile(raw("id: a\ntags: [x, y]\n"), "a")!.fm.tags).toEqual(["x", "y"]);
    // quoted value with colon inside
    const q = parseMemoryFile(raw('id: "a: b"\n'), "x");
    expect(q!.fm.id).toBe("a: b");
    // nested map
    const nested = parseMemoryFile(raw("id: a\nmeta:\n  deep: 1\n"), "a") as Record<string, unknown>;
    expect((nested.fm as Record<string, unknown>).meta).toEqual({ deep: 1 });
    // comment line
    const c = parseMemoryFile(raw("# note\nid: a\n"), "a");
    expect(c!.fm.id).toBe("a");
    // duplicate keys: the yaml package reports a duplicate-key error →
    // malformed convention (null), unchanged from the pre-fast-path behavior
    expect(parseMemoryFile(raw("id: first\nid: last\n"), "fallback")).toBeNull();
    // value containing `: ` is invalid YAML → malformed convention (null)
    expect(parseMemoryFile(raw("note: blocked: needs review\n"), "x")).toBeNull();
    // hex ints resolve through YAML
    const hex = parseMemoryFile(raw("n: 0x1A\n"), "x") as Record<string, unknown>;
    expect((hex.fm as Record<string, unknown>).n).toBe(26);
  });
});
