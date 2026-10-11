// tests/unit/software-factory-template.test.ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { topoWaves } from "../../src/compiler/plan.js";
import { GraphTemplateSchema, materializeTemplate } from "../../src/schemas/template.schema.js";

const TPL_PATH = join(import.meta.dir, "..", "..", "templates", "gallery", "software-factory.gk.yaml");

function load() {
  const doc = YAML.parse(readFileSync(TPL_PATH, "utf-8"));
  const parsed = GraphTemplateSchema.safeParse(doc);
  expect(parsed.success).toBe(true);
  if (!parsed.success) throw new Error("template failed schema");
  return parsed.data;
}

describe("software-factory template", () => {
  const tpl = load();

  test("is a GraphTemplate with task / modules / max-iterate-rounds parameters", () => {
    expect(tpl.kind).toBe("GraphTemplate");
    expect(tpl.metadata.name).toBe("software-factory");
    expect(tpl.parameters.task.required).toBe(true);
    expect(tpl.parameters.modules.required).toBe(false);
    expect(tpl.parameters["max-iterate-rounds"].default).toBe(3);
  });

  test("declares the 8-phase production line", () => {
    const ids = Object.keys(tpl.graph.nodes);
    for (const id of [
      "scout",
      "architect",
      "plan-review",
      "build-core",
      "build-ui",
      "build-cli",
      "integrate",
      "holdout-eval",
      "merge",
    ]) {
      expect(ids).toContain(id);
    }
  });

  test("plan-review is a human gate; scout and holdout-eval are read-only / eval-gate", () => {
    expect(tpl.graph.nodes["plan-review"].gate?.question).toBeTruthy();
    expect(tpl.graph.nodes["holdout-eval"].role).toBe("eval-gate");
    expect(tpl.graph.nodes["holdout-eval"].eval).toBeDefined();
    const flat = (arr: { [k: string]: unknown }[]) => arr.flatMap((c) => Object.entries(c));
    expect(flat(tpl.graph.nodes.scout.constraints)).toContainEqual(["no_write", true]);
    expect(flat(tpl.graph.nodes["holdout-eval"].constraints)).toContainEqual(["no_write", true]);
  });

  test("builders hold distinct owns globs in one parallel wave", () => {
    const owns = (id: string) => tpl.graph.nodes[id].owns;
    expect(owns("build-core")).not.toEqual(owns("build-ui"));
    expect(owns("build-ui")).not.toEqual(owns("build-cli"));
  });

  test("the iterate loop wraps build→eval with gate_evidence and no_progress_limit", () => {
    const loop = tpl.graph.loops[0];
    expect(loop.nodes).toEqual(["build-core", "build-ui", "build-cli", "integrate", "holdout-eval"]);
    expect(loop.gate_evidence).toEqual(["holdout_verdict"]);
    expect(loop.no_progress_limit).toBe(2);
  });

  test("materializes a valid graph; max-iterate-rounds lands in loops[].max_rounds", () => {
    const g = materializeTemplate(tpl, { task: "a markdown export pipeline", "max-iterate-rounds": 5 });
    expect(g.loops[0].max_rounds).toBe(5);
    const g2 = materializeTemplate(tpl, { task: "x" });
    expect(g2.loops[0].max_rounds).toBe(3); // parameter default flows through
    expect(g2.evidence.required_keys).toContain("holdout_verdict");
  });

  test("wave order is scout < architect < review < build < integrate < eval < merge", () => {
    const g = materializeTemplate(tpl, { task: "x" });
    const { waves } = topoWaves(g.nodes);
    const waveOf = (id: string) => waves.findIndex((w) => w.includes(id));
    expect(waveOf("scout")).toBeLessThan(waveOf("architect"));
    expect(waveOf("architect")).toBeLessThan(waveOf("plan-review"));
    expect(waveOf("plan-review")).toBeLessThan(waveOf("build-core"));
    expect(waveOf("build-core")).toBe(waveOf("build-ui"));
    expect(waveOf("build-ui")).toBe(waveOf("build-cli"));
    expect(waveOf("build-cli")).toBeLessThan(waveOf("integrate"));
    expect(waveOf("integrate")).toBeLessThan(waveOf("holdout-eval"));
    expect(waveOf("holdout-eval")).toBeLessThan(waveOf("merge"));
  });
});
