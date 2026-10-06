import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { installKit } from "../../src/cli/commands/kit.js";
import { validateGraph } from "../../src/compiler/validate.js";
import { GraphSchema } from "../../src/schemas/graph.schema.js";

const TMP = join(import.meta.dir, ".tmp-full-flow");
const FIXTURES = join(import.meta.dir, "..", "fixtures");

describe("Full flow: init -> validate", () => {
  beforeAll(() => {
    if (existsSync(TMP)) rmSync(TMP, { recursive: true });
    mkdirSync(TMP, { recursive: true });
    installKit(TMP);
    // validateGraph looks at projectRoot/claude/agents — installKit puts .claude/agents
    symlinkSync(join(TMP, ".claude"), join(TMP, "claude"), "junction");
  });
  afterAll(() => {
    if (existsSync(TMP)) rmSync(TMP, { recursive: true });
  });

  test("init installs agents, skills, hooks, rules", () => {
    const installed = readdirSync(join(TMP, ".claude"));
    expect(installed).toContain("agents");
    expect(installed).toContain("skills");
    expect(installed).toContain("hooks");
    expect(installed).toContain("rules");
    // all core agents
    const agents = readdirSync(join(TMP, ".claude", "agents")).filter((f) => f.endsWith(".md"));
    const coreCount = readdirSync(join(import.meta.dir, "..", "..", "kits", "_core", "agents")).filter((f) =>
      f.endsWith(".md"),
    ).length;
    expect(agents.length).toBe(coreCount);
    // 10 gk-* skills — assert the explicit set
    const skills = readdirSync(join(TMP, ".claude", "skills")).filter((f) => f.startsWith("gk-"));
    expect(skills.length).toBe(10);
    for (const expected of [
      "gk-brainstorm",
      "gk-eval",
      "gk-evidence",
      "gk-execute",
      "gk-init-graph",
      "gk-recall",
      "gk-status",
      "gk-template",
      "gk-validate",
      "gk-visualize",
    ]) {
      expect(skills, `missing skill ${expected}`).toContain(expected);
    }
    // 4 hooks
    const hooks = readdirSync(join(TMP, ".claude", "hooks")).filter((f) => f.endsWith(".cjs"));
    expect(hooks.length).toBe(4);
    // 3 rules
    const rules = readdirSync(join(TMP, ".claude", "rules")).filter((f) => f.endsWith(".md"));
    expect(rules.length).toBe(3);
  });

  test("validate passes on minimal-diamond with installed agents", () => {
    const raw = readFileSync(join(FIXTURES, "minimal-diamond.yaml"), "utf-8");
    const graph = GraphSchema.parse(YAML.parse(raw));
    const findings = validateGraph(graph, TMP);
    expect(findings).toEqual([]);
  });
});

describe("Subgraph composition: diamond + adversarial-verification", () => {
  beforeAll(() => {
    if (existsSync(TMP)) rmSync(TMP, { recursive: true });
    mkdirSync(TMP, { recursive: true });
    installKit(TMP);
    symlinkSync(join(TMP, ".claude"), join(TMP, "claude"), "junction");
  });
  afterAll(() => {
    if (existsSync(TMP)) rmSync(TMP, { recursive: true });
  });

  test("validateGraph still passes (subgraph is config, not a node)", () => {
    const raw = readFileSync(join(FIXTURES, "diamond-with-verification.yaml"), "utf-8");
    const graph = GraphSchema.parse(YAML.parse(raw));
    const findings = validateGraph(graph, TMP);
    expect(findings).toEqual([]);
  });
});
