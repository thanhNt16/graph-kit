// tests/integration/memory-pipeline.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { consolidate } from "../../src/memory/consolidate.js";
import { appendNode, endRun, startRun } from "../../src/memory/ledger.js";
import { expandedRecall } from "../../src/memory/recall-expanded.js";
import { dismissSuggestion, rankSuggestions, readSuggestions } from "../../src/memory/suggest.js";

describe("memory pipeline", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = join(tmpdir(), `gk-pipeline-${process.pid}-${Date.now()}`);
    mkdirSync(join(cwd, ".graphkit", "runs"), { recursive: true });
    writeFileSync(join(cwd, "graph.yaml"), "metadata:\n  name: ci-flow\ntopology: diamond\n");
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  test("run ×3 → consolidate → suggest → dismiss → recall", () => {
    for (const day of [1, 2, 3]) {
      const at = `2026-09-0${day}T09:00:00.000Z`;
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
          duration_ms: 3,
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
          duration_ms: 3,
          notes: null,
        },
        at,
      );
      appendNode(
        cwd,
        {
          node: "verify",
          wave: 2,
          agent: "qa-engineer",
          model: "sonnet",
          status: "ok",
          evidence: ["verify"],
          duration_ms: 3,
          notes: null,
        },
        at,
      );
      endRun(cwd, "merged", at);
    }

    const consolidated = consolidate(cwd, "2026-09-03T12:00:00.000Z");
    expect(consolidated.runs).toBe(3);
    expect(consolidated.patterns).toBeGreaterThan(2); // at least plan→build and plan→build→verify
    expect(consolidated.suggestions).toBeGreaterThan(0); // chain ≥3 members ⇒ capture-skill

    const suggestions = rankSuggestions(readSuggestions(join(cwd, ".graphkit", "memory")));
    expect(suggestions.length).toBeGreaterThan(0);
    // capture-skill (plan→build→verify ×3) and materialize-template (same sha ×3)
    // tie on salience; don't assert order between them.
    expect(suggestions.some((s) => s.action === "capture-skill")).toBe(true);
    expect(suggestions.some((s) => s.action === "materialize-template")).toBe(true);

    expect(dismissSuggestion(join(cwd, ".graphkit", "memory"), suggestions[0].id, "2026-09-03T12:01:00.000Z")).toBe(
      true,
    );
    const afterDismiss = rankSuggestions(readSuggestions(join(cwd, ".graphkit", "memory"))).filter(
      (s) => s.status === "proposed",
    );
    expect(afterDismiss.map((s) => s.id)).not.toContain(suggestions[0].id);
    expect(existsSync(join(cwd, ".graphkit", "memory", "suggestions", `${suggestions[0].id}.md`))).toBe(true);

    // recall finds the pattern files by content terms
    const recall = expandedRecall(join(cwd, ".graphkit", "memory"), "plan build verify", 5, "2026-09-03T12:00:00.000Z");
    expect(recall.results.length).toBeGreaterThan(0);
    expect(recall.results.some((h) => h.file.startsWith("patterns/"))).toBe(true);

    // re-consolidate must not resurrect the dismissed suggestion
    consolidate(cwd, "2026-09-03T13:00:00.000Z");
    const resurrected = readSuggestions(join(cwd, ".graphkit", "memory")).find((s) => s.id === suggestions[0].id);
    expect(resurrected?.status).toBe("dismissed");
  });
});
