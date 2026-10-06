// tests/unit/memory-suggestions.test.ts
// Regression for audit defect M1: consolidate writes suggestions with
// SuggestionFileSchema statuses (proposed|accepted|dismissed) while the recall
// reader validates MemoryFileSchema (draft|stable|deprecated) — every generated
// suggestion used to fail the read-side parse and vanish from recall, touch,
// and trace. The doc-status mapping must keep them in the loop, and must stay
// read-side only (files keep their proposal lifecycle).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { touchMemory, traceMemory } from "../../src/cli/commands/memory.js";
import { consolidate } from "../../src/memory/consolidate.js";
import { appendNode, endRun, startRun } from "../../src/runs/ledger.js";
import { expandedRecall } from "../../src/memory/recall-expanded.js";
import { readSuggestions } from "../../src/memory/suggest.js";

const NOW = "2026-09-03T12:00:00.000Z";
const TOUCHED_AT = "2026-09-03T12:30:00.000Z";
const TRACED_AT = "2026-09-03T13:00:00.000Z";

const NODES = [
  { node: "plan", wave: 0, agent: "software-architect" },
  { node: "build", wave: 1, agent: "data-engineer" },
  { node: "verify", wave: 2, agent: "qa-engineer" },
];

describe("suggestion round-trip (consolidate → recall/touch/trace)", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = join(tmpdir(), `gk-suggestions-${process.pid}-${Date.now()}`);
    mkdirSync(join(cwd, ".graphkit", "runs"), { recursive: true });
    writeFileSync(join(cwd, "graph.yaml"), "metadata:\n  name: ci-flow\ntopology: diamond\n");
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  test("a generated suggestion is recallable, touchable, and trace-clean", () => {
    for (const day of [1, 2, 3]) {
      const at = `2026-09-0${day}T09:00:00.000Z`;
      startRun(cwd, join(cwd, "graph.yaml"), at);
      for (const n of NODES) {
        appendNode(cwd, { ...n, model: "sonnet", status: "ok", evidence: [n.node], duration_ms: 3, notes: null }, at);
      }
      endRun(cwd, "merged", at);
    }
    const consolidated = consolidate(cwd, NOW);
    expect(consolidated.suggestions).toBeGreaterThan(0);

    const capture = readSuggestions(join(cwd, ".graphkit", "memory")).find((s) => s.action === "capture-skill");
    expect(capture).toBeDefined();

    // Recall returns the generated suggestion (was: parse-rejected, invisible).
    const recall = expandedRecall(join(cwd, ".graphkit", "memory"), "capture skill template chain recurred", 5, NOW);
    const hit = recall.results.find((r) => r.id === capture!.id);
    expect(hit).toBeDefined();
    expect(hit!.file.startsWith("suggestions/")).toBe(true);

    // Touch by id reinforces it, and the file keeps its proposal lifecycle —
    // the doc-status mapping is read-side only, never rewritten to disk.
    const touched = touchMemory(cwd, capture!.id, TOUCHED_AT);
    expect(touched).not.toBeNull();
    expect(touched!.use_count).toBe(2);
    expect(touched!.last_used_at).toBe(TOUCHED_AT);
    const raw = readFileSync(join(cwd, ".graphkit", "memory", "suggestions", `${capture!.id}.md`), "utf-8");
    expect(raw).toContain("use_count: 2");
    expect(raw).toContain(`last_used_at: ${TOUCHED_AT}`);
    expect(raw).toContain("status: proposed");
    expect(raw).not.toContain("status: draft");

    // Trace scores it like any memory: nothing malformed, entry live.
    const trace = traceMemory(cwd, TRACED_AT);
    expect(trace.malformed).toBe(0);
    expect(trace.total).toBe(consolidated.patterns + consolidated.suggestions);
    expect(trace.memories.find((m) => m.id === capture!.id)?.state).toBe("live");
  });
});
