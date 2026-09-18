import { describe, expect, test } from "bun:test";
import { GraphSchema } from "../../src/schemas/graph.schema.js";

const base = {
  metadata: { name: "demo" },
  topology: "custom",
};

describe("advisor schema", () => {
  test("accepts advisor on a looping node and applies defaults", () => {
    const r = GraphSchema.safeParse({
      ...base,
      nodes: { work: { agent: "builder", objective: "build", loop: { enabled: true, max_rounds: 6 }, advisor: {} } },
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.nodes.work.advisor).toEqual({ model: "fable", after_failed_rounds: 1, max_calls: 1 });
    }
  });

  test("rejects advisor without loop.enabled", () => {
    const r = GraphSchema.safeParse({
      ...base,
      nodes: { work: { agent: "builder", objective: "build", advisor: {} } },
    });
    expect(r.success).toBe(false);
    expect(r.error!.issues.some((i) => i.message.includes("advisor requires loop.enabled"))).toBe(true);
  });

  test("rejects bad tier and zero thresholds", () => {
    const bad1 = GraphSchema.safeParse({
      ...base,
      nodes: { w: { agent: "b", objective: "o", loop: { enabled: true }, advisor: { model: "gpt5" } } },
    });
    const bad2 = GraphSchema.safeParse({
      ...base,
      nodes: { w: { agent: "b", objective: "o", loop: { enabled: true }, advisor: { max_calls: 0 } } },
    });
    const bad3 = GraphSchema.safeParse({
      ...base,
      nodes: { w: { agent: "b", objective: "o", loop: { enabled: true }, advisor: { after_failed_rounds: 0 } } },
    });
    expect(bad1.success).toBe(false);
    expect(bad2.success).toBe(false);
    expect(bad3.success).toBe(false);
  });
});

describe("fan_out schema", () => {
  test("accepts fan_out with upstream briefs_from and defaults template", () => {
    const r = GraphSchema.safeParse({
      ...base,
      nodes: {
        plan: { agent: "planner", objective: "plan" },
        exec: { agent: "builder", objective: "exec", depend_on: ["plan"], fan_out: { briefs_from: "plan" } },
      },
    });
    expect(r.success).toBe(true);
    if (r.success)
      expect(r.data.nodes.exec.fan_out).toEqual({ briefs_from: "plan", template: "{brief.body}", reduce: "append" });
  });

  test("accepts explicit reduce mode", () => {
    const r = GraphSchema.safeParse({
      ...base,
      nodes: {
        plan: { agent: "p", objective: "o" },
        exec: { agent: "b", objective: "o", depend_on: ["plan"], fan_out: { briefs_from: "plan", reduce: "vote" } },
      },
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.nodes.exec.fan_out?.reduce).toBe("vote");
  });

  test("rejects unknown reduce mode", () => {
    const r = GraphSchema.safeParse({
      ...base,
      nodes: {
        plan: { agent: "p", objective: "o" },
        exec: {
          agent: "b",
          objective: "o",
          depend_on: ["plan"],
          fan_out: { briefs_from: "plan", reduce: "rank" },
        },
      },
    });
    expect(r.success).toBe(false);
  });

  test("rejects dangling briefs_from", () => {
    const r = GraphSchema.safeParse({
      ...base,
      nodes: { exec: { agent: "b", objective: "o", fan_out: { briefs_from: "ghost" } } },
    });
    expect(r.success).toBe(false);
  });

  test("rejects non-upstream briefs_from (sibling, not predecessor)", () => {
    const r = GraphSchema.safeParse({
      ...base,
      nodes: {
        a: { agent: "b", objective: "o" },
        b: { agent: "b", objective: "o" },
        exec: { agent: "b", objective: "o", fan_out: { briefs_from: "b" } },
      },
    });
    expect(r.success).toBe(false);
    expect(r.error!.issues.some((i) => i.message.includes("upstream"))).toBe(true);
  });

  test("rejects empty template", () => {
    const r = GraphSchema.safeParse({
      ...base,
      nodes: {
        plan: { agent: "p", objective: "o" },
        exec: { agent: "b", objective: "o", depend_on: ["plan"], fan_out: { briefs_from: "plan", template: "" } },
      },
    });
    expect(r.success).toBe(false);
  });
});

describe("orchestration fields", () => {
  test("retry applies defaults and enforces bounds", () => {
    const ok = GraphSchema.safeParse({
      ...base,
      nodes: { w: { agent: "b", objective: "o", retry: {} } },
    });
    expect(ok.success).toBe(true);
    if (ok.success)
      expect(ok.data.nodes.w.retry).toEqual({
        max_attempts: 1,
        initial_interval_ms: 1000,
        backoff: 2,
        non_retryable: [],
      });
    for (const retry of [{ max_attempts: 0 }, { initial_interval_ms: 0 }, { backoff: 0.5 }]) {
      expect(GraphSchema.safeParse({ ...base, nodes: { w: { agent: "b", objective: "o", retry } } }).success).toBe(
        false,
      );
    }
  });

  test("when, budget_tokens, gate, effort parse and default effort to standard", () => {
    const r = GraphSchema.safeParse({
      ...base,
      nodes: {
        w: {
          agent: "b",
          objective: "o",
          when: "upstream report contains no blockers",
          budget_tokens: 4000,
          gate: { question: "Ship this?", details: "Review the diff" },
        },
      },
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.nodes.w.effort).toBe("standard");
      expect(r.data.nodes.w.when).toContain("blockers");
      expect(r.data.nodes.w.gate?.question).toBe("Ship this?");
    }
  });

  test("rejects bad effort, empty when, empty gate question, non-positive budget", () => {
    const cases = [{ effort: "extreme" }, { when: "" }, { gate: { question: "" } }, { budget_tokens: 0 }];
    for (const extra of cases) {
      const r = GraphSchema.safeParse({ ...base, nodes: { w: { agent: "b", objective: "o", ...extra } } });
      expect(r.success, JSON.stringify(extra)).toBe(false);
    }
  });

  test("effort accepts all three tiers", () => {
    for (const effort of ["light", "standard", "deep"] as const) {
      const r = GraphSchema.safeParse({ ...base, nodes: { w: { agent: "b", objective: "o", effort } } });
      expect(r.success).toBe(true);
      if (r.success) expect(r.data.nodes.w.effort).toBe(effort);
    }
  });
});
