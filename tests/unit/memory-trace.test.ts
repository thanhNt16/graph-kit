import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { touchMemory, traceMemory } from "../../src/cli/commands/memory.js";

const NOW = "2026-08-15T00:00:00.000Z";

function writeMemory(cwd: string, file: string, fm: Record<string, unknown>, body = "notes\n") {
  writeFileSync(join(cwd, ".graphkit", "memory", file), `---\n${yamlFm(fm)}---\n${body}`);
}
function yamlFm(fm: Record<string, unknown>): string {
  return Object.entries(fm)
    .map(([k, v]) => `${k}: ${v}\n`)
    .join("");
}

describe("gk memory trace", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = join(tmpdir(), `gk-mem-trace-${process.pid}-${Date.now()}`);
    mkdirSync(join(cwd, ".graphkit", "memory"), { recursive: true });
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  test("marks stale low-salience memory expired, keeps fresh one live", () => {
    writeMemory(cwd, "stale.md", {
      id: "stale",
      salience: 0.1,
      expired: false,
      valid_from: "2026-01-01T00:00:00.000Z",
      tags: [],
    });
    writeMemory(cwd, "fresh.md", {
      // neutral defaults (salience 0.5, untagged) — the realistic curator output;
      // guards the threshold calibration: peak ~0.15 must stay live
      id: "fresh",
      salience: 0.5,
      expired: false,
      valid_from: NOW,
      tags: "[]",
    });

    const r = traceMemory(cwd, NOW);
    expect(r.total).toBe(2);
    expect(r.live).toBe(1);
    expect(r.newly_expired).toBe(1);

    const stale = readFileSync(join(cwd, ".graphkit", "memory", "stale.md"), "utf-8");
    expect(stale).toContain("expired: true");
    expect(stale).toContain(`valid_to: ${NOW}`); // expired ≠ deleted
    expect(stale).toContain("notes"); // body preserved

    const fresh = readFileSync(join(cwd, ".graphkit", "memory", "fresh.md"), "utf-8");
    expect(fresh).toContain("notes"); // untouched
  });

  test("already-expired and superseded memories are reported, not rewritten", () => {
    writeMemory(cwd, "exp.md", { id: "exp", salience: 0.9, expired: true, valid_from: NOW, tags: "[]" });
    writeMemory(cwd, "sup.md", {
      id: "sup",
      salience: 0.9,
      expired: false,
      valid_from: NOW,
      superseded_by: "other",
      tags: "[]",
    });

    const r = traceMemory(cwd, NOW);
    expect(r.expired).toBe(1);
    expect(r.superseded).toBe(1);
    expect(r.live).toBe(0);
    expect(r.memories.find((m) => m.id === "exp")?.action).toBe("already-expired");
    expect(r.memories.find((m) => m.id === "sup")?.action).toBe("superseded");
  });

  test("empty memory dir reports zeros", () => {
    const r = traceMemory(cwd, NOW);
    expect(r.total).toBe(0);
  });

  test("touchMemory reinforces: touched memory survives +21d decay, untouched twin expires", () => {
    const LATER = "2026-09-05T00:00:00.000Z"; // NOW + 21 days
    // identical neutral twins, both last used at creation
    writeMemory(cwd, "touched.md", { id: "touched", salience: 0.5, expired: false, valid_from: NOW, tags: "[]" });
    writeMemory(cwd, "twin.md", { id: "twin", salience: 0.5, expired: false, valid_from: NOW, tags: "[]" });

    const t = touchMemory(cwd, "touched", LATER);
    expect(t?.use_count).toBe(2); // default 1 + 1
    expect(t?.last_used_at).toBe(LATER);

    const r = traceMemory(cwd, LATER);
    expect(r.memories.find((m) => m.id === "touched")?.state).toBe("live");
    expect(r.memories.find((m) => m.id === "twin")?.state).toBe("expired");
  });

  test("touchMemory returns null for unknown id", () => {
    expect(touchMemory(cwd, "nope")).toBeNull();
  });

  test("mutations set .memory-dirty (recall freshness gate now reachable)", () => {
    writeMemory(cwd, "m.md", { id: "m", salience: 0.5, expired: false, valid_from: NOW, tags: "[]" });
    touchMemory(cwd, "m", NOW);
    expect(existsSync(join(cwd, ".graphkit", ".memory-dirty"))).toBe(true);
  });

  test("trace pass appends one audit JSONL row per memory, append-only", () => {
    writeMemory(cwd, "a.md", { id: "a", salience: 0.5, expired: false, valid_from: NOW, tags: "[]" });
    writeMemory(cwd, "b.md", {
      id: "b",
      salience: 0.1,
      expired: false,
      valid_from: "2026-01-01T00:00:00.000Z",
      tags: "[]",
    });
    traceMemory(cwd, NOW);
    traceMemory(cwd, NOW); // second pass: no truncation
    const log = readFileSync(join(cwd, ".graphkit", ".trace-log"), "utf-8")
      .trim()
      .split("\n");
    expect(log.length).toBe(4); // 2 memories × 2 passes
    const rows = log.map((l) => JSON.parse(l));
    const a = rows.find((r) => r.id === "a" && r.ts === NOW);
    const b = rows.find((r) => r.id === "b");
    expect(a?.action).toBe("kept");
    expect(b?.action).toBe("newly-expired");
  });
});
