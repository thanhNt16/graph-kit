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

  test("syntax-broken frontmatter is dropped, not fatal (malformed convention)", () => {
    // `tags: [unclosed` never closes the flow sequence — YAML.parse throws.
    writeFileSync(join(cwd, ".graphkit", "memory", "broken.md"), "---\nid: broken\ntags: [unclosed\n---\nnotes\n");
    writeMemory(cwd, "good.md", { id: "good", salience: 0.5, expired: false, valid_from: NOW, tags: "[]" });

    const r = traceMemory(cwd, NOW); // must not throw — one bad file can't kill decay
    expect(r.total).toBe(1); // malformed entry dropped, not counted
    expect(r.memories.map((m) => m.id)).toEqual(["good"]);
    const broken = readFileSync(join(cwd, ".graphkit", "memory", "broken.md"), "utf-8");
    expect(broken).toContain("tags: [unclosed"); // dropped ≠ deleted (audit rule)
  });

  test("touchMemory skips syntax-broken frontmatter instead of crashing", () => {
    writeFileSync(join(cwd, ".graphkit", "memory", "broken.md"), "---\nid: broken\ntags: [unclosed\n---\nnotes\n");
    expect(touchMemory(cwd, "broken")).toBeNull(); // id matches the filename, parse fails → skip
    writeMemory(cwd, "good.md", { id: "good", salience: 0.5, expired: false, valid_from: NOW, tags: "[]" });
    expect(touchMemory(cwd, "good")?.id).toBe("good"); // store still usable after the skip
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

  test("touchMemory coerces legacy string tags — reinforcement no longer silently nulls (regression)", () => {
    // Pre-fix: `tags: "decay"` failed MemoryFileSchema (tags must be an array),
    // so touchMemory skipped the entry and returned null — legacy store entries
    // never got use_count reinforcement and decay expired them like unused ones.
    writeMemory(cwd, "legacy.md", { id: "legacy", salience: 0.5, expired: false, valid_from: NOW, tags: "decay" });
    const t = touchMemory(cwd, "legacy", NOW);
    expect(t).not.toBeNull();
    expect(t?.use_count).toBe(2);
    expect(t?.last_used_at).toBe(NOW);
    const rewritten = readFileSync(join(cwd, ".graphkit", "memory", "legacy.md"), "utf-8");
    expect(rewritten).toContain("use_count: 2");
    expect(rewritten).toContain(`last_used_at: ${NOW}`);
    // the rewritten (now array-tagged) entry still parses for the decay pass
    expect(traceMemory(cwd, NOW).total).toBe(1);
  });

  test("touchMemory reinforces subfolder entries through the same walk", () => {
    mkdirSync(join(cwd, ".graphkit", "memory", "patterns"), { recursive: true });
    writeFileSync(
      join(cwd, ".graphkit", "memory", "patterns", "p1.md"),
      `---\nid: pattern-p1\ntype: pattern\nsalience: 0.9\n---\nseq\n`,
    );
    const t = touchMemory(cwd, "pattern-p1", NOW);
    expect(t?.use_count).toBe(2);
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

describe("memory lifecycle semantics (exec-tests step 4)", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = join(tmpdir(), `gk-mem-life-${process.pid}-${Date.now()}`);
    mkdirSync(join(cwd, ".graphkit", "memory"), { recursive: true });
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  test("expiry rewrite also sets status: deprecated alongside expired:true", () => {
    writeMemory(cwd, "stale.md", {
      id: "stale",
      salience: 0.1,
      expired: false,
      valid_from: "2026-01-01T00:00:00.000Z",
      tags: [],
    });
    traceMemory(cwd, NOW);
    const stale = readFileSync(join(cwd, ".graphkit", "memory", "stale.md"), "utf-8");
    expect(stale).toContain("expired: true");
    expect(stale).toContain("status: deprecated");
  });

  test("expiry/touch rewrites preserve unknown frontmatter keys", () => {
    writeMemory(cwd, "keep.md", {
      id: "keep",
      salience: 0.1,
      expired: false,
      valid_from: "2026-01-01T00:00:00.000Z",
      ponytail_note: "user-added provenance",
    });
    traceMemory(cwd, NOW); // expiry rewrite path
    const raw = readFileSync(join(cwd, ".graphkit", "memory", "keep.md"), "utf-8");
    expect(raw).toContain("ponytail_note: user-added provenance");

    writeMemory(cwd, "touch.md", { id: "touch", salience: 0.5, expired: false, valid_from: NOW, tags: "[]" });
    touchMemory(cwd, "touch", NOW); // touch rewrite path
    const touched = readFileSync(join(cwd, ".graphkit", "memory", "touch.md"), "utf-8"); // different file, no cross-contamination
    expect(touched).toContain("use_count: 2"); // reinforcement applied to the touched file
    // the touched file must keep its own unknown keys if any were present
    writeMemory(cwd, "touch2.md", {
      id: "touch2",
      salience: 0.5,
      expired: false,
      valid_from: NOW,
      tags: "[]",
      custom_field: "survives-touch",
    });
    touchMemory(cwd, "touch2", NOW);
    const raw2 = readFileSync(join(cwd, ".graphkit", "memory", "touch2.md"), "utf-8");
    expect(raw2).toContain("custom_field: survives-touch");
  });

  test("expire_policy manual: scores are reported but no memory is mutated", () => {
    writeMemory(cwd, "stale.md", {
      id: "stale",
      salience: 0.1,
      expired: false,
      valid_from: "2026-01-01T00:00:00.000Z",
      tags: [],
    });
    const before = readFileSync(join(cwd, ".graphkit", "memory", "stale.md"), "utf-8");
    const r = traceMemory(cwd, NOW, { expire_policy: "manual" });
    const after = readFileSync(join(cwd, ".graphkit", "memory", "stale.md"), "utf-8");
    expect(after).toBe(before); // byte-identical: no expiry marking
    expect(r.memories.find((m) => m.id === "stale")).toBeDefined(); // scoring still reported
  });

  test("connectivity is monotonic: one tag never scores below untagged baseline", () => {
    writeMemory(cwd, "tagged.md", { id: "tagged", salience: 0.5, expired: false, valid_from: NOW, tags: "[one]" });
    writeMemory(cwd, "bare.md", { id: "bare", salience: 0.5, expired: false, valid_from: NOW, tags: "[]" });
    const r = traceMemory(cwd, NOW);
    const tagged = r.memories.find((m) => m.id === "tagged")?.score ?? -1;
    const bare = r.memories.find((m) => m.id === "bare")?.score ?? -1;
    expect(tagged).toBeGreaterThanOrEqual(bare); // floor at 0.5 — no tag can lower a score
    expect(tagged).toBeGreaterThan(0);
  });

  test("mutations never write .memory-dirty (dead flag removed)", () => {
    writeMemory(cwd, "m.md", { id: "m", salience: 0.5, expired: false, valid_from: NOW, tags: "[]" });
    touchMemory(cwd, "m", NOW);
    traceMemory(cwd, NOW);
    expect(existsSync(join(cwd, ".graphkit", ".memory-dirty"))).toBe(false);
  });

  test("trace parses MemoryFileSchema-valid files with reserved names skipped", () => {
    // type: "knowledge" makes these schema-valid memories, so the skip below is
    // exercised for the reserved-name rule — not merely schema rejection
    writeMemory(cwd, "index.md", { id: "index", salience: 0.5, type: "knowledge" }); // reserved — not a memory
    writeMemory(cwd, "log.md", { id: "log", salience: 0.5, type: "knowledge" }); // reserved
    const r = traceMemory(cwd, NOW);
    expect(r.total).toBe(0); // reserved files ignored
    expect(r.memories.length).toBe(0);
  });
});

// Round 4: unknown ≠ expiring, dry-run writes nothing, policy echoes.
describe("trace honesty guards (round 4)", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = join(tmpdir(), `gk-mem-guard-${process.pid}-${Date.now()}`);
    mkdirSync(join(cwd, ".graphkit", "memory"), { recursive: true });
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  test("garbage last_used_at never expires a healthy memory — reported as unknown-date", () => {
    // Pre-fix: "recently" → ageDays Infinity → score 0 → expired:true rewrite,
    // regardless of salience or use. Now: untouched, counted, flagged.
    writeMemory(cwd, "good.md", {
      id: "good",
      salience: 0.9,
      use_count: 50,
      last_used_at: "recently",
      type: "knowledge",
    });
    const r = traceMemory(cwd, NOW);
    expect(r.unparseable_dates).toBe(1);
    expect(r.newly_expired).toBe(0);
    const m = r.memories.find((x) => x.id === "good")!;
    expect(m.action).toBe("unknown-date");
    expect(m.state).toBe("live");
    const after = readFileSync(join(cwd, ".graphkit", "memory", "good.md"), "utf-8");
    expect(after).toContain("last_used_at: recently"); // untouched — operator fixes the field
    expect(after).not.toContain("expired: true");
  });

  test("already-expired entry with garbage date reports already-expired, not unknown", () => {
    writeMemory(cwd, "old.md", {
      id: "old",
      salience: 0.9,
      expired: true,
      last_used_at: "whenever",
      type: "knowledge",
    });
    const r = traceMemory(cwd, NOW);
    expect(r.memories.find((x) => x.id === "old")?.action).toBe("already-expired");
    expect(r.unparseable_dates).toBe(0);
  });

  test("dry_run: would-expire is previewed, zero writes, no trace-log append", () => {
    writeMemory(cwd, "stale.md", {
      id: "stale",
      salience: 0.1,
      expired: false,
      valid_from: "2026-01-01T00:00:00.000Z",
      tags: [],
    });
    const before = readFileSync(join(cwd, ".graphkit", "memory", "stale.md"), "utf-8");
    const r = traceMemory(cwd, NOW, { dry_run: true });
    expect(readFileSync(join(cwd, ".graphkit", "memory", "stale.md"), "utf-8")).toBe(before); // byte-identical
    expect(r.memories.find((x) => x.id === "stale")?.action).toBe("would-expire"); // honest preview
    expect(r.dry_run).toBe(true);
    expect(existsSync(join(cwd, ".graphkit", ".trace-log"))).toBe(false); // dry run leaves no audit rows
    // a real pass then expires it
    const real = traceMemory(cwd, NOW);
    expect(real.memories.find((x) => x.id === "stale")?.action).toBe("newly-expired");
  });

  test("report echoes a provided expire_policy", () => {
    writeMemory(cwd, "a.md", { id: "a", salience: 0.5, expired: false, valid_from: NOW, tags: "[]" });
    const r = traceMemory(cwd, NOW, { expire_policy: "manual" });
    expect(r.expire_policy).toBe("manual");
  });
});
