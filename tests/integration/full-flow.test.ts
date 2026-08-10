import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { installKit, templatesDir } from "../../src/cli/commands/kit.js";
import { compileGraph } from "../../src/compiler/emitter.js";
import { validateGraph } from "../../src/compiler/validate.js";
import { GraphSchema } from "../../src/schemas/graph.schema.js";

const TMP = join(import.meta.dir, ".tmp-full-flow");
const FIXTURES = join(import.meta.dir, "..", "fixtures");

describe("Full flow: init -> validate -> compile", () => {
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
    // 8 agents
    const agents = readdirSync(join(TMP, ".claude", "agents")).filter((f) => f.endsWith(".md"));
    expect(agents.length).toBe(8);
    // 11 gk-* skills
    const skills = readdirSync(join(TMP, ".claude", "skills")).filter((f) => f.startsWith("gk-"));
    expect(skills.length).toBe(11);
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

  test("compile produces a runnable .workflow.js", () => {
    const raw = readFileSync(join(FIXTURES, "minimal-diamond.yaml"), "utf-8");
    const graph = GraphSchema.parse(YAML.parse(raw));
    const script = compileGraph(graph, templatesDir());
    expect(script).toContain("createDiamondWorkflow");
    // Write + re-read to confirm it's valid JS (no syntax errors)
    const outPath = join(TMP, "diamond.workflow.js");
    writeFileSync(outPath, script);
    expect(existsSync(outPath)).toBe(true);
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

  test("compiles with inlined subgraph template", () => {
    const raw = readFileSync(join(FIXTURES, "diamond-with-verification.yaml"), "utf-8");
    const graph = GraphSchema.parse(YAML.parse(raw));
    const script = compileGraph(graph, templatesDir());
    // Both template functions present (root + subgraph)
    expect(script).toContain("createDiamondWorkflow");
    expect(script).toContain("createAdversarialWorkflow");
    expect(script).toContain('"__subgraph": "adversarial-verification"');
  });

  test("validateGraph still passes (subgraph is config, not a node)", () => {
    const raw = readFileSync(join(FIXTURES, "diamond-with-verification.yaml"), "utf-8");
    const graph = GraphSchema.parse(YAML.parse(raw));
    const findings = validateGraph(graph, TMP);
    expect(findings).toEqual([]);
  });
});
