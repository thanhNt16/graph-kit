// tests/integration/ledger-consolidate.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { consolidate } from "../../src/memory/consolidate.js";
import { appendNode, endRun, startRun } from "../../src/memory/ledger.js";

const GRAPH = "metadata:\n  name: demo\ntopology: diamond\n";

describe("ledger → consolidate", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = join(tmpdir(), `gk-consolidate-${process.pid}-${Date.now()}`);
    mkdirSync(join(cwd, ".graphkit", "runs"), { recursive: true });
    mkdirSync(join(cwd, ".graphkit", "memory"), { recursive: true });
    writeFileSync(join(cwd, "graph.yaml"), GRAPH);
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  function fakeRun(hour: number) {
    const at = `2026-09-0${hour}T10:00:00.000Z`;
    startRun(cwd, join(cwd, "graph.yaml"), at);
    appendNode(
      cwd,
      {
        node: "plan",
        wave: 0,
        agent: "software-architect",
        model: "opus",
        status: "ok",
        evidence: ["plan"],
        duration_ms: 5,
        notes: null,
      },
      at,
    );
    appendNode(
      cwd,
      {
        node: "build",
        wave: 1,
        agent: "data-engineer",
        model: "sonnet",
        status: "ok",
        evidence: ["build"],
        duration_ms: 5,
        notes: null,
      },
      at,
    );
    endRun(cwd, "merged", at);
  }

  test("three identical runs produce patterns, suggestions, links, and an index", () => {
    fakeRun(1);
    fakeRun(2);
    fakeRun(3);

    const result = consolidate(cwd, "2026-09-03T12:00:00.000Z");
    expect(result.runs).toBe(3);
    expect(result.patterns).toBeGreaterThan(0);

    const memDir = join(cwd, ".graphkit", "memory");
    const patternFiles = readdirSync(join(memDir, "patterns"));
    expect(patternFiles.length).toBe(result.patterns);
    const anyPattern = readFileSync(join(memDir, "patterns", patternFiles[0]), "utf-8");
    expect(anyPattern).toContain("type: pattern");

    expect(existsSync(join(memDir, ".links.json"))).toBe(true);
    expect(readFileSync(join(memDir, "index.md"), "utf-8")).toContain("# Memory Index");
    expect(result.suggestions).toBeGreaterThan(0);
  });

  test("consolidate is idempotent — running twice does not duplicate files", () => {
    fakeRun(1);
    fakeRun(2);
    fakeRun(3);
    const first = consolidate(cwd, "2026-09-03T12:00:00.000Z");
    const second = consolidate(cwd, "2026-09-03T12:00:00.000Z");
    expect(second.patterns).toBe(first.patterns);
    expect(readdirSync(join(cwd, ".graphkit", "memory", "patterns")).length).toBe(first.patterns);
  });

  test("zero runs is a clean no-op", () => {
    const result = consolidate(cwd, "2026-09-03T12:00:00.000Z");
    expect(result).toEqual({ runs: 0, patterns: 0, suggestions: 0, links: 0, pruned: 0 });
  });

  test("stale pattern files whose signature no longer appears are pruned", () => {
    const patternsDir = join(cwd, ".graphkit", "memory", "patterns");
    mkdirSync(patternsDir, { recursive: true });
    writeFileSync(
      join(patternsDir, "deadbeef.md"),
      "---\nid: pattern-deadbeef\ntype: pattern\nkind: node-sequence\nlabel: gone\nmembers: []\nruns: []\ncount: 1\nlast_seen: 2026-01-01T00:00:00.000Z\nsignature: deadbeef\ngenerated:\n  by: process:gk-memory-consolidate\n  at: 2026-01-01T00:00:00.000Z\n---\nstale\n",
    );
    fakeRun(1);
    fakeRun(2);
    fakeRun(3);
    const result = consolidate(cwd, "2026-09-03T12:00:00.000Z");
    expect(result.pruned).toBe(1);
    expect(existsSync(join(patternsDir, "deadbeef.md"))).toBe(false);
  });
});
