import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { GraphKitError } from "../../src/errors.js";
import { join } from "node:path";
import YAML from "yaml";
import { planGraph } from "../../src/compiler/plan.js";
import { GraphSchema } from "../../src/schemas/graph.schema.js";

const BASE = {
  apiVersion: "graphkit.dev/v2",
  kind: "Graph",
  metadata: { name: "plan-test" },
};

function diamondGraph() {
  return GraphSchema.parse({
    ...BASE,
    topology: "diamond",
    nodes: {
      scouter: { agent: "Software Architect", objective: "scout" },
      worker1: { agent: "Code Reviewer", objective: "w1", depend_on: ["scouter"] },
      worker2: { agent: "Code Reviewer", objective: "w2", depend_on: ["scouter"] },
      synthesizer: { agent: "Software Architect", objective: "merge", depend_on: ["worker1", "worker2"] },
    },
  });
}

describe("planGraph — planner IR", () => {
  test("diamond graph levelizes into [scouter],[worker1,worker2],[synthesizer] with wave indices", () => {
    const plan = planGraph(diamondGraph());
    expect(plan.waves.map((w) => w.nodes.map((n) => n.id))).toEqual([
      ["scouter"],
      ["worker1", "worker2"],
      ["synthesizer"],
    ]);
    expect(plan.waves.map((w) => w.index)).toEqual([0, 1, 2]);
    expect(plan.waves[0].parallel).toBe(false);
    expect(plan.waves[1].parallel).toBe(true);
    expect(plan.waves[2].parallel).toBe(false);
  });

  test("memory-augmented graph interleaves the curator after every action wave", () => {
    const graph = GraphSchema.parse({
      ...BASE,
      topology: "memory-augmented",
      topology_config: { inner: { template: "custom" }, memory: { curator_node: "curator" } },
      nodes: {
        scouter: { agent: "Software Architect", objective: "scout" },
        worker: { agent: "Code Reviewer", objective: "work", depend_on: ["scouter"] },
        synthesizer: { agent: "Software Architect", objective: "merge", depend_on: ["worker"] },
        curator: { agent: "Memory Curator", objective: "curate" },
      },
    });
    const plan = planGraph(graph);
    // on_node_complete cadence: one curator wave after each action wave
    expect(plan.waves.map((w) => (w.curator ? "C" : w.nodes.map((n) => n.id).join("+")))).toEqual([
      "scouter",
      "C",
      "worker",
      "C",
      "synthesizer",
      "C",
    ]);
    // curator waves carry the recall skill and are never parallel
    const curatorWave = plan.waves.find((w) => w.curator);
    expect(curatorWave?.parallel).toBe(false);
    expect(curatorWave?.nodes[0].skills).toContain("gk-recall");
    // action waves never contain the curator node
    for (const w of plan.waves) {
      if (!w.curator) expect(w.nodes.map((n) => n.id)).not.toContain("curator");
    }
    // envelope carries the resolved memory config (planner fills the defaults)
    expect(plan.memory).toEqual({
      curator_node: "curator",
      cadence: "on_node_complete",
      every: 1,
      recall_topk: 5,
      expire_policy: "act_r",
      null_intervention_allowed: true,
    });
  });

  test("cadence 'every: 2' fires after the second action wave and at end-of-run", () => {
    const graph = GraphSchema.parse({
      ...BASE,
      topology: "memory-augmented",
      topology_config: { memory: { curator_node: "curator", cadence: "every", every: 2 } },
      nodes: {
        scouter: { agent: "Software Architect", objective: "scout" },
        worker: { agent: "Code Reviewer", objective: "work", depend_on: ["scouter"] },
        synthesizer: { agent: "Software Architect", objective: "merge", depend_on: ["worker"] },
        curator: { agent: "Memory Curator", objective: "curate" },
      },
    });
    const plan = planGraph(graph);
    // 3 action waves: fires at cumulative 2 (after wave 2); wave 3 passes a
    // threshold since the last fire → end-of-run curation, no duplicate.
    expect(plan.waves.map((w) => (w.curator ? "C" : "A"))).toEqual(["A", "A", "C", "A", "C"]);
  });

  test("non-memory graph has no curator waves and no memory block", () => {
    const plan = planGraph(diamondGraph());
    expect(plan.memory).toBeUndefined();
    expect(plan.waves.some((w) => w.curator === true)).toBe(false);
  });

  test("topology_config rides the plan payload", () => {
    const graph = GraphSchema.parse({
      ...BASE,
      topology: "custom",
      topology_config: { inner: { template: "diamond" }, notes: { fanout: 3 } },
      nodes: { a: { agent: "Code Reviewer", objective: "x" } },
    });
    const plan = planGraph(graph);
    expect(plan.topology_config).toEqual({ inner: { template: "diamond" }, notes: { fanout: 3 } });
  });

  test("node orchestration fields ride verbatim; unset fields surface as null", () => {
    const graph = GraphSchema.parse({
      ...BASE,
      topology: "diamond",
      nodes: {
        planner: { agent: "Software Architect", objective: "plan" },
        executor: {
          agent: "Code Reviewer",
          model: "opus",
          objective: "execute",
          depend_on: ["planner"],
          tools: ["Read", "Grep"],
          skills: ["gk-recall"],
          evidence: ["report"],
          advisor: { model: "opus", after_failed_rounds: 2, max_calls: 2 },
          fan_out: { briefs_from: "planner", template: "Do {brief}", reduce: "merge" },
          retry: { max_attempts: 3 },
          when: "planner produced briefs",
          budget_tokens: 4096,
          gate: { question: "Proceed?" },
          effort: "deep",
          timeout_ms: 900000,
          constraints: [{ no_write: true }],
          assumptions: ["the plan is sound"],
          owns: ["src/**"],
          loop: { enabled: true, max_rounds: 4, stop_when: "done" },
        },
      },
    });
    const plan = planGraph(graph);
    const node = plan.waves.flatMap((w) => w.nodes).find((n) => n.id === "executor")!;
    expect(node.model).toBe("opus");
    expect(node.tools).toEqual(["Read", "Grep"]);
    expect(node.skills).toEqual(["gk-recall"]);
    expect(node.evidence).toEqual(["report"]);
    expect(node.advisor).toEqual({ model: "opus", after_failed_rounds: 2, max_calls: 2 });
    expect(node.fan_out).toEqual({ briefs_from: "planner", template: "Do {brief}", reduce: "merge" });
    expect(node.retry).toEqual({ max_attempts: 3, initial_interval_ms: 1000, backoff: 2, non_retryable: [] });
    expect(node.when).toBe("planner produced briefs");
    expect(node.budget_tokens).toBe(4096);
    expect(node.gate).toEqual({ question: "Proceed?" });
    expect(node.effort).toBe("deep");
    expect(node.timeout_ms).toBe(900000);
    expect(node.constraints).toEqual([{ no_write: true }]);
    expect(node.assumptions).toEqual(["the plan is sound"]);
    expect(node.owns).toEqual(["src/**"]);
    expect(node.loop).toEqual({ enabled: true, max_rounds: 4, stop_when: "done" });

    const planner = plan.waves[0].nodes[0];
    expect(planner.model).toBe("sonnet"); // defaulted
    expect(planner.effort).toBe("standard"); // defaulted
    expect(planner.advisor).toBeNull();
    expect(planner.fan_out).toBeNull();
    expect(planner.retry).toBeNull();
    expect(planner.when).toBeNull();
    expect(planner.gate).toBeNull();
    expect(planner.loop).toBeNull();
    expect(planner.budget_tokens).toBeNull();
    expect(planner.timeout_ms).toBeNull();
    expect(planner.role).toBeNull();
    expect(planner.eval).toBeNull();
  });

  test("role and eval ride verbatim from the source YAML, not the default-materialized parse", () => {
    const dir = mkdtempSync(join(tmpdir(), "gk-plan-src-"));
    const file = join(dir, "g.yaml");
    writeFileSync(
      file,
      [
        "apiVersion: graphkit.dev/v2",
        "kind: Graph",
        "metadata: { name: src }",
        "topology: diamond",
        "nodes:",
        "  gated:",
        "    agent: Code Reviewer",
        "    objective: gate",
        "    role: eval-gate",
        "    eval: { mode: memory }",
      ].join("\n"),
    );
    const graph = GraphSchema.parse(YAML.parse(readFileSync(file, "utf-8")));
    const plan = planGraph(graph, { source: file });
    const gated = plan.waves[0].nodes[0];
    expect(gated.role).toBe("eval-gate");
    // raw authored block — GraphSchema.parse would have materialized
    // rubric/abstention_weighted defaults on top of it
    expect(gated.eval).toEqual({ mode: "memory" });
  });

  test("worker depending on the excluded curator throws WAVES_INCOMPLETE instead of a partial plan", () => {
    const graph = GraphSchema.parse({
      ...BASE,
      topology: "memory-augmented",
      topology_config: { memory: { curator_node: "curator" } },
      nodes: {
        curator: { agent: "Memory Curator", objective: "curate" },
        worker: { agent: "Code Reviewer", objective: "work", depend_on: ["curator"] },
      },
    });
    try {
      planGraph(graph);
      throw new Error("planGraph should have thrown WAVES_INCOMPLETE");
    } catch (e) {
      if (e instanceof GraphKitError) expect(e.code).toBe("WAVES_INCOMPLETE");
      else throw e;
    }
  });
});
