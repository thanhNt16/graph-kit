import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { installKit, templatesDir } from "../../src/cli/commands/kit.js";
import { compileGraph } from "../../src/compiler/emitter.js";
import { validateGraph } from "../../src/compiler/validate.js";
import { GraphSchema } from "../../src/schemas/graph.schema.js";

const TMP = join(import.meta.dir, ".tmp-acceptance");
const FIXTURES = join(import.meta.dir, "..", "fixtures");
const TOPOS = [
  "diamond",
  "classify-and-act",
  "adversarial-verification",
  "loop-until-done",
  "generate-and-filter",
  "tournament",
];

beforeAll(() => {
  if (existsSync(TMP)) rmSync(TMP, { recursive: true });
  mkdirSync(TMP, { recursive: true });
  installKit(TMP);
  // validateGraph looks for claude/agents/ relative to projectRoot — symlink .claude → claude
  symlinkSync(join(TMP, ".claude"), join(TMP, "claude"));
});

afterAll(() => {
  if (existsSync(TMP)) rmSync(TMP, { recursive: true });
});

describe("AC01: gk init installs claude/ with all agents, skills, hooks, rules", () => {
  test("8 agents, 12 gk-* skills, 4 hooks, 3 rules installed", () => {
    expect(readdirSync(join(TMP, ".claude", "agents")).filter((f) => f.endsWith(".md")).length).toBe(8);
    const skills = readdirSync(join(TMP, ".claude", "skills")).filter((f) => f.startsWith("gk-"));
    expect(skills.length).toBe(12);
    // Explicit skill set — do not blindly count. gk-compile + gk-run are Claude-only.
    for (const expected of [
      "gk-brainstorm",
      "gk-compile",
      "gk-eval",
      "gk-evidence",
      "gk-execute",
      "gk-init-graph",
      "gk-recall",
      "gk-run",
      "gk-status",
      "gk-template",
      "gk-validate",
      "gk-visualize",
    ]) {
      expect(skills, `missing skill ${expected}`).toContain(expected);
    }
    expect(readdirSync(join(TMP, ".claude", "hooks")).filter((f) => f.endsWith(".cjs")).length).toBe(4);
    expect(readdirSync(join(TMP, ".claude", "rules")).filter((f) => f.endsWith(".md")).length).toBe(3);
  });
});

describe("AC02: gk validate rejects invalid graph.yaml", () => {
  test("missing agent field → schema rejection", () => {
    const r = GraphSchema.safeParse(
      YAML.parse(`metadata:\n  name: x\ntopology: diamond\nnodes:\n  a:\n    objective: no agent`),
    );
    expect(r.success).toBe(false);
  });
});

describe("AC03: gk compile produces valid .workflow.js for all 6 topologies", () => {
  test("each topology compiles", () => {
    for (const topo of TOPOS) {
      const g = GraphSchema.parse(
        YAML.parse(
          `metadata:\n  name: t\ntopology: ${topo}\nnodes:\n  a:\n    agent: Code Reviewer\n    objective: x\n`,
        ),
      );
      const script = compileGraph(g, templatesDir());
      expect(script).toContain("export const meta");
    }
  });
});

describe("AC04: gk compile resolves subgraph references", () => {
  test("diamond + adversarial-verification inlines both templates", () => {
    const g = GraphSchema.parse(YAML.parse(readFileSync(join(FIXTURES, "diamond-with-verification.yaml"), "utf-8")));
    const script = compileGraph(g, templatesDir());
    expect(script).toContain("createAdversarialWorkflow");
  });
});

describe("AC05: gk:visualize produces .excalidraw file", () => {
  test("excalidraw-diagram skill is vendored", () => {
    const skillsDir = join(import.meta.dir, "..", "..", "kits", "claude", "skills");
    expect(existsSync(join(skillsDir, "excalidraw-diagram", "SKILL.md"))).toBe(true);
    expect(existsSync(join(skillsDir, "gk-visualize", "SKILL.md"))).toBe(true);
  });
});

describe("AC06: gk validate detects acyclic dependencies", () => {
  test("cyclic depend_on rejected by schema", () => {
    const r = GraphSchema.safeParse(
      YAML.parse(
        `metadata:\n  name: x\ntopology: diamond\nnodes:\n  a:\n    agent: A\n    depend_on: [b]\n  b:\n    agent: B\n    depend_on: [a]`,
      ),
    );
    expect(r.success).toBe(false);
  });
});

describe("AC07: gk validate detects missing refs", () => {
  test("nonexistent ref path → finding", () => {
    const g = GraphSchema.parse(
      YAML.parse(
        `metadata:\n  name: x\ntopology: diamond\nnodes:\n  a:\n    agent: Code Reviewer\n    objective: x\n    refs:\n      - path: nope/missing.md\n        purpose: gone`,
      ),
    );
    const findings = validateGraph(g, TMP);
    expect(findings.some((f) => f.check === "refs-exist")).toBe(true);
  });
});

describe("AC08: init-graph diamond template produces valid graph.yaml", () => {
  test("fixture parses against schema", () => {
    const g = GraphSchema.parse(YAML.parse(readFileSync(join(FIXTURES, "minimal-diamond.yaml"), "utf-8")));
    expect(g.topology).toBe("diamond");
    expect(g.nodes.scouter).toBeDefined();
  });
});

describe("AC09: brainstorm updates graph.yaml", () => {
  test("model override is schema-valid (simulating brainstorm edit)", () => {
    const doc = YAML.parse(readFileSync(join(FIXTURES, "minimal-diamond.yaml"), "utf-8"));
    doc.nodes.scouter.loop = { enabled: true, max_rounds: 3, stop_when: "evidence found" };
    const r = GraphSchema.safeParse(doc);
    expect(r.success).toBe(true);
  });
});

describe("AC10: model tiering propagates to compiled .workflow.js", () => {
  test("opus and sonnet tiers present in emitted config", () => {
    const g = GraphSchema.parse(YAML.parse(readFileSync(join(FIXTURES, "minimal-diamond.yaml"), "utf-8")));
    const script = compileGraph(g, templatesDir());
    expect(script).toContain('"model": "opus"');
    expect(script).toContain('"model": "sonnet"');
  });
});
