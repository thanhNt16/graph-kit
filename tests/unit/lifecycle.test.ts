import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { touchMemory, traceMemory } from "../../src/cli/commands/memory.js";
import { adoptProposal } from "../../src/learn/learn.js";
import { evaluate, type LifecycleMember } from "../../src/memory/lifecycle.js";
import {
  ARCHIVE_DIR,
  archiveMember,
  findArchived,
  findLiveMember,
  lifecycleCounts,
  requestCount,
  reviveMember,
  runLifecycle,
} from "../../src/memory/lifecycle-store.js";
import { expandedRecall } from "../../src/memory/recall-expanded.js";
import { readMemoryFile } from "../../src/memory/store.js";
import { MemoryLifecycleConfig } from "../../src/schemas/memory.schema.js";

const NOW = "2026-10-11T00:00:00.000Z";
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

const cfg = (over: Record<string, unknown> = {}) => MemoryLifecycleConfig.parse({ maturity: 3, capacity: 2, ...over });

const member = (name: string, over: Partial<LifecycleMember["adherence"]> = {}): LifecycleMember => ({
  name,
  adherence: { adopted_by: "gk-learn", anchor: 0, use: 0, view: 0, patch: 0, ...over },
});

let cwd: string;
let memDir: string;
beforeEach(() => {
  cwd = join(tmpdir(), `gk-lifecycle-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  memDir = join(cwd, ".graphkit", "memory");
  mkdirSync(memDir, { recursive: true });
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

function writeMemory(file: string, fm: Record<string, unknown>, body = "notes\n") {
  writeFileSync(join(memDir, file), `---\n${YAML.stringify(fm)}---\n${body}`);
}

/** Seed a learn-adopted artifact directly (the shape adoptProposal writes). */
function adopted(id: string, adherence: Record<string, unknown> = {}, body = `${id} learned artifact\n`) {
  writeMemory(
    `${id}.md`,
    {
      id,
      type: "learned-artifact",
      valid_from: NOW,
      salience: 0.9,
      generated: { by: "process:gk-learn-adopt", at: NOW },
      status: "stable",
      adherence: { adopted_by: "gk-learn", anchor: 0, use: 0, view: 0, patch: 0, ...adherence },
    },
    body,
  );
}

const verdict = (members: LifecycleMember[], requests: number, c = cfg()) =>
  new Map(evaluate(members, requests, c).map((v) => [v.name, v]));

describe("evaluate: probation", () => {
  test("a member inside its probation window is unevictable even at zero use", () => {
    const v = verdict([member("newbie", { anchor: 5 })], 7, cfg()); // 2 requests < maturity 3
    expect(v.get("newbie")?.action).toBe("live");
    expect(v.get("newbie")?.reason).toBe("probation");
  });

  test("probation members are excluded from the capacity pool", () => {
    // 1 probation + 3 mature, capacity 2 → only 1 mature eviction, never the probationer.
    const members = [
      member("probation", { anchor: 8 }),
      member("old-a", { use: 0, view: 1 }),
      member("old-b", { use: 1, view: 1 }),
      member("old-c", { use: 3, view: 3 }),
    ];
    const v = verdict(members, 10, cfg());
    expect(v.get("probation")?.action).toBe("live");
    expect([...v.values()].filter((x) => x.action === "archive")).toHaveLength(1);
  });
});

describe("evaluate: graduation review", () => {
  test("use==0 AND view==0 → archive; either counter alone survives", () => {
    const v = verdict([member("dead", {}), member("viewed", { view: 2 }), member("used", { use: 1 })], 10, cfg());
    expect(v.get("dead")).toMatchObject({ action: "archive", reason: "graduation" });
    expect(v.get("viewed")?.action).toBe("live"); // view-only survives
    expect(v.get("used")?.action).toBe("live");
  });

  test("graduation_suspended parks the review — zero-use members stay live", () => {
    const v = verdict([member("dead", {})], 10, cfg({ graduation_suspended: true }));
    expect(v.get("dead")?.action).toBe("live");
    expect(v.get("dead")?.reason).toBe("mature");
  });
});

describe("evaluate: capacity eviction", () => {
  test("evicts exactly pool−capacity members, lowest rates first", () => {
    const members = [
      member("idle", { view: 1 }), // rate 0/10
      member("low", { use: 1, view: 1 }), // rate .1
      member("mid", { use: 2, view: 2 }), // rate .2
      member("hot", { use: 3, view: 3 }), // rate .3
    ];
    const v = verdict(members, 10, cfg());
    expect(v.get("idle")).toMatchObject({ action: "archive", reason: "capacity" });
    expect(v.get("low")).toMatchObject({ action: "archive", reason: "capacity" });
    expect(v.get("mid")?.action).toBe("live");
    expect(v.get("hot")?.action).toBe("live");
  });

  test("rate ties break deterministically by sha256(name)", () => {
    const members = [member("a", { view: 1 }), member("b", { view: 1 }), member("c", { view: 1 })];
    const expected = [...members]
      .sort((x, y) => sha256(x.name).localeCompare(sha256(y.name)))
      .slice(0, 1)
      .map((m) => m.name);
    const first = verdict(members, 10, cfg());
    const second = verdict([...members].reverse(), 10, cfg());
    const evicted = [...first.values()].filter((v) => v.action === "archive").map((v) => v.name);
    expect(evicted).toEqual(expected);
    expect([...second.values()].filter((v) => v.action === "archive").map((v) => v.name)).toEqual(expected);
  });

  test("pool at capacity → nobody evicted", () => {
    const v = verdict([member("a", { view: 1 }), member("b", { view: 1 })], 10, cfg());
    expect([...v.values()].every((x) => x.action === "live")).toBe(true);
  });
});

describe("evaluate: adoption provenance", () => {
  test("human-adopted items are tracked but never eligible", () => {
    const v = verdict([member("human-note", { adopted_by: "human" })], 100, cfg());
    expect(v.get("human-note")?.action).toBe("live");
    expect(v.get("human-note")?.reason).toBe("human");
  });
});

describe("request denominator (.requests.jsonl)", () => {
  test("grows exactly one line per expandedRecall invocation", () => {
    adopted("art");
    expect(requestCount(memDir)).toBe(0);
    expandedRecall(memDir, "anything", 5, NOW);
    expandedRecall(memDir, "anything", 5, NOW);
    expandedRecall(memDir, "anything", 5, NOW);
    expect(requestCount(memDir)).toBe(3);
    const lines = readFileSync(join(memDir, ".requests.jsonl"), "utf-8").trim().split("\n");
    expect(lines).toHaveLength(3);
  });

  test("anchor snapshots the index at adoption; denominator is opportunity-relative", () => {
    expandedRecall(memDir, "x", 5, NOW);
    expandedRecall(memDir, "x", 5, NOW); // 2 requests pre-adoption
    adopted("newbie", { anchor: 2 });
    const m = findLiveMember(memDir, "newbie");
    expect(m?.adherence.anchor).toBe(2);
    // 1 more request → denom 1 < maturity 3 ��� still probation
    expandedRecall(memDir, "x", 5, NOW);
    expect(evaluate([m!], requestCount(memDir), cfg())[0].reason).toBe("probation");
  });
});

describe("offer/use counters", () => {
  test("expandedRecall bumps view on surfaced hits; touchMemory bumps use", () => {
    adopted("needle", {}, "needle oauth token flow\n");
    const res = expandedRecall(memDir, "needle oauth", 5, NOW);
    expect(res.results.map((h) => h.id)).toContain("needle");
    let fm = readMemoryFile(join(memDir, "needle.md")).fm;
    expect((fm.adherence as { view: number }).view).toBe(1);
    expect((fm.adherence as { use: number }).use).toBe(0);
    touchMemory(cwd, "needle", NOW);
    fm = readMemoryFile(join(memDir, "needle.md")).fm;
    expect((fm.adherence as { use: number }).use).toBe(1);
  });

  test("a hit never surfaced stays view==0 — graduation can still retire it", () => {
    adopted("surfaced", {}, "needle hit\n");
    adopted("buried", {}, "zzz unrelated\n");
    expandedRecall(memDir, "needle", 1, NOW);
    expect((readMemoryFile(join(memDir, "buried.md")).fm.adherence as { view: number }).view).toBe(0);
  });
});

describe("archive / revive", () => {
  test("runLifecycle archives graduates into .archive/ — never deletes", () => {
    adopted("stale");
    for (let i = 0; i < 3; i++) expandedRecall(memDir, "miss", 5, NOW); // denom 3 ≥ maturity
    const run = runLifecycle(cwd, cfg(), { now: NOW });
    expect(run.verdicts[0]).toMatchObject({ action: "archive", reason: "graduation" });
    expect(existsSync(join(memDir, "stale.md"))).toBe(false);
    const archived = join(memDir, ARCHIVE_DIR, "stale.md");
    expect(existsSync(archived)).toBe(true);
    const fm = readMemoryFile(archived).fm;
    expect((fm.archived as { cause: string }).cause).toBe("graduation");
    // ledger line
    const trace = readFileSync(join(cwd, ".graphkit", ".trace-log"), "utf-8");
    expect(trace).toContain('"action":"archived"');
  });

  test("--dry-run reports verdicts without moving files", () => {
    adopted("stale");
    for (let i = 0; i < 3; i++) expandedRecall(memDir, "miss", 5, NOW);
    const run = runLifecycle(cwd, cfg(), { dryRun: true, now: NOW });
    expect(run.archived).toBe(1);
    expect(run.dry_run).toBe(true);
    expect(existsSync(join(memDir, "stale.md"))).toBe(true);
  });

  test("archived items are absent from recall", () => {
    adopted("needle", { view: 1 }, "needle oauth flow\n");
    archiveMember(memDir, "needle.md", "manual", NOW);
    const res = expandedRecall(memDir, "needle oauth", 5, NOW);
    expect(res.results.map((h) => h.id)).not.toContain("needle");
  });

  test("revive restores the file with counters intact", () => {
    adopted("art", { use: 4, view: 7, patch: 1 });
    archiveMember(memDir, "art.md", "capacity", NOW);
    expect(findLiveMember(memDir, "art")).toBeNull();
    expect(findArchived(memDir, "art")).toBe("art.md");
    reviveMember(memDir, "art.md", NOW);
    const fm = readMemoryFile(join(memDir, "art.md")).fm;
    expect(fm.archived).toBeUndefined();
    expect(fm.adherence).toMatchObject({ use: 4, view: 7, patch: 1 });
  });

  test("human files are untouched: no adherence → not a member; adopted_by human → live", () => {
    writeMemory("plain.md", { id: "plain", type: "knowledge" });
    adopted("human-art", { adopted_by: "human" });
    for (let i = 0; i < 5; i++) expandedRecall(memDir, "miss", 5, NOW);
    runLifecycle(cwd, cfg(), { now: NOW });
    expect(existsSync(join(memDir, "plain.md"))).toBe(true);
    expect(existsSync(join(memDir, "human-art.md"))).toBe(true);
  });
});

describe("learn adopt populates the store", () => {
  const seedAdoptable = () => {
    mkdirSync(join(cwd, ".graphkit", "learn"), { recursive: true });
    mkdirSync(join(cwd, ".graphkit", "runs"), { recursive: true });
    writeFileSync(
      join(cwd, ".graphkit", "learn", "learn-r1.yaml"),
      YAML.stringify({
        id: "learn-r1",
        created: NOW,
        source_run: "20260101-000001-a",
        source_case: null,
        hypothesis: "always verify before merge",
        proposal_kind: "procedure",
        proposes: null,
        fix: null,
        status: "evaluated",
        evaluation: { at: NOW, evidence_dir: null, verdicts: [], after_fix: null },
        adopted: null,
        rejected: null,
        reverted: null,
      }),
    );
  };

  test("adopt lands .graphkit/memory/<id>.md with anchor + zeroed counters", () => {
    expandedRecall(memDir, "x", 5, NOW); // 1 request pre-adoption
    seedAdoptable();
    const adoptedRes = adoptProposal(cwd, "learn-r1");
    expect(adoptedRes.artifact).toBe("learn-r1.md");
    const fm = readMemoryFile(join(memDir, "learn-r1.md")).fm;
    expect(fm.adherence).toMatchObject({ adopted_by: "gk-learn", anchor: 1, use: 0, view: 0, patch: 0 });
    expect((fm.generated as { by: string }).by).toBe("process:gk-learn-adopt");
  });

  test("re-adopt onto an existing artifact is a revision → patch++", () => {
    seedAdoptable();
    adopted("learn-r1", { use: 3, view: 5, patch: 0 });
    adoptProposal(cwd, "learn-r1");
    const fm = readMemoryFile(join(memDir, "learn-r1.md")).fm;
    expect(fm.adherence).toMatchObject({ use: 3, view: 5, patch: 1 });
  });
});

describe("gk memory trace lifecycle counts", () => {
  test("report carries probation/mature/archived/graduated/capacity_evicted", () => {
    // Lifecycle config comes from the graph's topology_config.memory block.
    writeFileSync(
      join(cwd, "graph.yaml"),
      "topology: diamond\nnodes: {}\ntopology_config:\n  memory:\n    lifecycle: {maturity: 3, capacity: 2}\n",
    );
    adopted("young", { anchor: 9 }); // probation (10-9 < 3)
    adopted("old", { view: 1 }); // mature survivor
    adopted("gone", { view: 1 });
    archiveMember(memDir, "gone.md", "capacity", NOW);
    for (let i = 0; i < 10; i++) expandedRecall(memDir, "miss", 5, NOW);
    const r = traceMemory(cwd, NOW);
    expect(r.lifecycle).toMatchObject({ probation: 1, mature: 1, archived: 1, capacity_evicted: 1, graduated: 0 });
    // archived files are not ACT-R traced either
    expect(r.memories.map((m) => m.id)).not.toContain("gone");
    expect(lifecycleCounts(memDir, cfg()).archived).toBe(1);
  });
});

describe("end-to-end (maturity 3, capacity 2)", () => {
  test("probation → graduation → capacity → archive → revive", () => {
    // Two never-offered items graduate; three offered-but-unused compete for 2 slots.
    adopted("buried-1");
    adopted("buried-2");
    adopted("offered-a", {}, "needle alpha\n");
    adopted("offered-b", {}, "needle beta\n");
    adopted("offered-c", {}, "needle gamma\n");
    for (let i = 0; i < 3; i++) expandedRecall(memDir, "needle", 5, NOW);

    // One lazy pass does both reviews: buried items graduate out (use==0,
    // view==0), then the remaining mature pool (3 offered) exceeds capacity 2
    // → the sha256 tiebreak evicts exactly one.
    const run = runLifecycle(cwd, cfg(), { now: NOW });
    const graduated = run.verdicts.filter((v) => v.reason === "graduation").map((v) => v.name);
    expect(graduated.sort()).toEqual(["buried-1", "buried-2"]);
    const evicted = run.verdicts.filter((v) => v.reason === "capacity").map((v) => v.name);
    expect(evicted).toHaveLength(1);

    // Live store now holds exactly 2 members (pool fits → a re-run is a no-op);
    // the 3 evicted rest under .archive/.
    const rerun = runLifecycle(cwd, cfg(), { now: NOW });
    expect(rerun.members).toBe(2);
    expect(rerun.archived).toBe(0);
    const archivedIds = ["buried-1", "buried-2", ...evicted];
    for (const id of archivedIds) expect(findArchived(memDir, id)).not.toBeNull();
    const res = expandedRecall(memDir, "needle", 5, NOW);
    for (const id of archivedIds) expect(res.results.map((h) => h.id)).not.toContain(id);

    // Revive brings one back with its counters.
    reviveMember(memDir, `${evicted[0]}.md`, NOW);
    expect(findLiveMember(memDir, evicted[0])).not.toBeNull();
  });
});
