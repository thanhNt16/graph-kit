// tests/unit/memory-consolidate.test.ts
// Regression for audit defect MEM F3: re-consolidation rewrote memory files
// from scratch — wiping the reinforcement state (use_count, last_used_at) that
// gk-recall/touch accumulates, resurrecting entries the decay pass had marked
// expired:true, and resetting created_at. gk-execute consolidates after every
// run end, so ACT-R anti-decay never survived a run boundary.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { touchMemory } from "../../src/cli/commands/memory.js";
import { consolidate } from "../../src/memory/consolidate.js";
import { appendNode, endRun, startRun } from "../../src/runs/ledger.js";

const GRAPH = "metadata:\n  name: demo\ntopology: diamond\n";

describe("consolidate merge-retain (MEM F3)", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = join(tmpdir(), `gk-consolidate-f3-${process.pid}-${Date.now()}`);
    mkdirSync(join(cwd, ".graphkit", "runs"), { recursive: true });
    mkdirSync(join(cwd, ".graphkit", "memory"), { recursive: true });
    writeFileSync(join(cwd, "graph.yaml"), GRAPH);
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  function fakeRun(day: number) {
    const at = `2026-09-0${day}T09:00:00.000Z`;
    startRun(cwd, join(cwd, "graph.yaml"), at);
    const nodes = [
      { node: "plan", wave: 0, agent: "software-architect", model: "opus", status: "ok", evidence: ["plan"], duration_ms: 3, notes: null },
      { node: "build", wave: 1, agent: "data-engineer", model: "sonnet", status: "ok", evidence: ["build"], duration_ms: 3, notes: null },
      { node: "verify", wave: 2, agent: "qa-engineer", model: "sonnet", status: "ok", evidence: ["verify"], duration_ms: 3, notes: null },
    ] as const;
    for (const n of nodes) appendNode(cwd, n, at);
    endRun(cwd, "merged", at);
  }

  const frontmatterOf = (path: string): Record<string, unknown> =>
    YAML.parse(readFileSync(path, "utf-8").match(/^---\n([\s\S]*?)\n---/)![1]);

  test("re-consolidation preserves reinforcement and decay state", () => {
    fakeRun(1);
    fakeRun(2);
    fakeRun(3);
    consolidate(cwd, "2026-09-03T12:00:00.000Z");

    const patternsDir = join(cwd, ".graphkit", "memory", "patterns");
    const files = readdirSync(patternsDir).sort();
    expect(files.length).toBeGreaterThanOrEqual(2);
    const [reinforcedFile, decayedFile] = files;
    const reinforcedPath = join(patternsDir, reinforcedFile);
    const decayedPath = join(patternsDir, decayedFile);
    const originalCreated = frontmatterOf(reinforcedPath).created_at;

    // Reinforce, the way gk-recall does when a memory surfaces.
    expect(touchMemory(cwd, String(frontmatterOf(reinforcedPath).id), "2026-09-04T09:00:00.000Z")).not.toBeNull();

    // Decay-mark a sibling, the way `gk memory trace` does (expired + valid_to + deprecated).
    const decayedBefore = frontmatterOf(decayedPath);
    writeFileSync(
      decayedPath,
      `---\n${YAML.stringify({ ...decayedBefore, expired: true, valid_to: "2026-09-04T09:00:00.000Z", status: "deprecated" })}---\nstale\n`,
    );

    // Next run boundary: consolidation must merge, not rewrite.
    consolidate(cwd, "2026-09-05T12:00:00.000Z");

    const reinforced = frontmatterOf(reinforcedPath);
    expect(reinforced.use_count).toBe(2);
    expect(reinforced.last_used_at).toBe("2026-09-04T09:00:00.000Z");
    expect(reinforced.created_at).toBe(originalCreated);
    expect(reinforced.expired).toBe(false);

    const decayedAfter = frontmatterOf(decayedPath);
    expect(decayedAfter.expired).toBe(true); // no resurrection
    expect(decayedAfter.valid_to).toBe("2026-09-04T09:00:00.000Z");
    expect(decayedAfter.created_at).toBe(decayedBefore.created_at);
    expect(decayedAfter.status).toBe("deprecated"); // decay's status survives re-consolidation
  });
});
