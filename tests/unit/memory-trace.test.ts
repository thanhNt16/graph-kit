import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { traceMemory } from "../../src/cli/commands/memory.js";

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
});
