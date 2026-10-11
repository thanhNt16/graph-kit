import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { planGraph } from "../../src/compiler/plan.js";
import { validateGraph } from "../../src/compiler/validate.js";
import {
  isHoldoutCriterion,
  isHoldoutPath,
  isHoldoutRef,
  loadCriteria,
  registryFileFor,
} from "../../src/evidence/criteria.js";
import { GraphSchema } from "../../src/schemas/graph.schema.js";

let cwd: string;
beforeEach(() => {
  cwd = join(tmpdir(), `gk-holdout-${process.pid}-${Date.now()}`);
  mkdirSync(join(cwd, "criteria"), { recursive: true });
  writeFileSync(join(cwd, "criteria", "rubric.holdout.md"), "---\nkind: report\n---\nsealed rubric\n");
  writeFileSync(join(cwd, "criteria", "open.md"), "public criterion\n");
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

function graphObj(nodes: Record<string, unknown>, ev?: unknown) {
  return YAML.parse(
    YAML.stringify({
      apiVersion: "graphkit.dev/v2",
      kind: "Graph",
      metadata: { name: "t" },
      topology: "custom",
      nodes,
      evidence: ev ?? { required_keys: ["report"] },
    }),
  );
}

// builder + eval-gate pair: producer writes report, gate reads the sealed rubric
const BUILDER = {
  agent: "code-reviewer",
  objective: "build",
  depend_on: [],
  evidence: ["report"],
};
const GATE_REFS = [{ path: "criteria/rubric.holdout.md", purpose: "sealed rubric" }];
const GATE = {
  agent: "qa-engineer",
  objective: "evaluate",
  role: "eval-gate",
  eval: { mode: "work_product" },
  depend_on: ["builder"],
  refs: GATE_REFS,
};

describe("holdout declaration", () => {
  test("schema accepts holdout: true on refs and defaults to false", () => {
    const g = GraphSchema.parse(
      graphObj({
        builder: {
          ...BUILDER,
          refs: [
            { path: "docs/a.md", purpose: "context" },
            { path: "criteria/rubric.holdout.md", purpose: "sealed", holdout: true },
          ],
        },
      }),
    );
    expect(g.nodes.builder.refs[0].holdout).toBe(false);
    expect(g.nodes.builder.refs[1].holdout).toBe(true);
  });

  test("criteria/<id>.holdout.md satisfies evidence.criteria and marks the criterion sealed", () => {
    writeFileSync(join(cwd, "criteria", "report.holdout.md"), "sealed report rubric\n");
    const g = GraphSchema.parse(
      graphObj({ builder: BUILDER, gate: GATE }, { required_keys: ["report"], criteria: ["report"] }),
    );
    expect(validateGraph(g, cwd).filter((f) => f.check === "criteria-file")).toEqual([]);
    expect(isHoldoutCriterion(cwd, "report")).toBe(true);
    // registry resolution prefers .md, falls back to .holdout.md
    expect(registryFileFor(cwd, "rubric")).toEqual({
      path: join(cwd, "criteria", "rubric.holdout.md"),
      holdout: true,
    });
    expect(isHoldoutCriterion(cwd, "rubric")).toBe(true);
    expect(isHoldoutCriterion(cwd, "open")).toBe(false);
    const loaded = loadCriteria(cwd, ["rubric", "open"]);
    expect(loaded.get("rubric")).toEqual({ id: "rubric", description: "sealed rubric", kind: "report", holdout: true });
    expect(loaded.get("open")?.holdout).toBe(false);
  });

  test("isHoldoutPath / isHoldoutRef cover both declaration forms", () => {
    expect(isHoldoutPath("criteria/rubric.holdout.md")).toBe(true);
    expect(isHoldoutPath("./criteria/rubric.holdout.md")).toBe(true);
    expect(isHoldoutPath("criteria/rubric.md")).toBe(false);
    expect(isHoldoutPath("docs/x.holdout.md")).toBe(false); // convention is criteria-scoped
    expect(isHoldoutRef({ path: "tests/hidden.sh", holdout: true })).toBe(true);
    expect(isHoldoutRef({ path: "docs/a.md" })).toBe(false);
  });
});

describe("holdout seal — compiler enforcement", () => {
  test("HOLDOUT_LEAK on a builder refs entry to criteria/<id>.holdout.md", () => {
    const g = GraphSchema.parse(
      graphObj({
        builder: { ...BUILDER, refs: [{ path: "criteria/rubric.holdout.md", purpose: "rubric" }] },
        gate: GATE,
      }),
    );
    const leaks = validateGraph(g, cwd).filter((f) => f.check === "holdout-leak");
    expect(leaks).toHaveLength(1);
    expect(leaks[0].severity).toBeUndefined(); // blocking, not advisory
    expect(leaks[0].message).toContain("HOLDOUT_LEAK");
    expect(leaks[0].message).toContain("builder");
    expect(leaks[0].message).toContain("criteria/rubric.holdout.md");
  });

  test("holdout: true flag seals arbitrary paths for builders too", () => {
    const g = GraphSchema.parse(
      graphObj({
        builder: { ...BUILDER, refs: [{ path: "tests/hidden.sh", purpose: "x", holdout: true }] },
      }),
    );
    expect(validateGraph(g, cwd).some((f) => f.check === "holdout-leak")).toBe(true);
  });

  test("eval-gate node refs to the same sealed path pass clean", () => {
    const g = GraphSchema.parse(graphObj({ builder: BUILDER, gate: GATE }));
    expect(validateGraph(g, cwd).filter((f) => f.check === "holdout-leak")).toEqual([]);
    expect(validateGraph(g, cwd).filter((f) => f.check === "holdout-dead-seal")).toEqual([]);
  });

  test("any non-eval-gate role counts as a builder", () => {
    const g = GraphSchema.parse(
      graphObj({
        builder: { ...BUILDER, role: "supervisor", refs: GATE_REFS },
      }),
    );
    expect(validateGraph(g, cwd).some((f) => f.check === "holdout-leak")).toBe(true);
  });

  test("dead seal advisory: holdouts declared, zero eval-gate nodes", () => {
    writeFileSync(join(cwd, "criteria", "report.holdout.md"), "sealed report rubric\n");
    const g = GraphSchema.parse(graphObj({ builder: BUILDER }, { required_keys: ["report"], criteria: ["report"] }));
    const dead = validateGraph(g, cwd).filter((f) => f.check === "holdout-dead-seal");
    expect(dead).toHaveLength(1);
    expect(dead[0].severity).toBe("warn");
  });

  test("no advisory when an eval-gate node exists", () => {
    writeFileSync(join(cwd, "criteria", "report.holdout.md"), "sealed report rubric\n");
    const g = GraphSchema.parse(
      graphObj({ builder: BUILDER, gate: GATE }, { required_keys: ["report"], criteria: ["report"] }),
    );
    expect(validateGraph(g, cwd).some((f) => f.check === "holdout-dead-seal")).toBe(false);
  });
});

describe("holdout seal — payload filtering", () => {
  test("planGraph strips sealed refs from builder payloads, keeps them on eval-gate", () => {
    const g = GraphSchema.parse(
      graphObj({
        builder: {
          ...BUILDER,
          refs: [
            { path: "docs/spec.md", purpose: "context" },
            { path: "criteria/rubric.holdout.md", purpose: "sealed" },
            { path: "tests/hidden.sh", purpose: "sealed2", holdout: true },
          ],
        },
        gate: GATE,
      }),
    );
    const plan = planGraph(g);
    const builder = plan.waves.flatMap((w) => w.nodes).find((n) => n.id === "builder")!;
    const gate = plan.waves.flatMap((w) => w.nodes).find((n) => n.id === "gate")!;
    expect(builder.refs).toEqual([{ path: "docs/spec.md", purpose: "context", holdout: false }]);
    expect(gate.refs).toEqual(GATE_REFS.map((r) => ({ ...r, holdout: false })));
  });
});
