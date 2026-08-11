import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { installKit, templatesDir } from "../../src/cli/commands/kit.js";
import { compileGraph } from "../../src/compiler/emitter.js";
import { GraphSchema } from "../../src/schemas/graph.schema.js";

const TMP = join(import.meta.dir, "..", ".tmp-mem-aug");
const FIXTURES = join(import.meta.dir, "..", "fixtures");

describe("AC11/AC12: memory-augmented topology", () => {
  beforeAll(() => {
    if (existsSync(TMP)) rmSync(TMP, { recursive: true });
    mkdirSync(TMP, { recursive: true });
    installKit(TMP);
    symlinkSync(join(TMP, ".claude"), join(TMP, "claude"), "junction");
  });
  afterAll(() => {
    if (existsSync(TMP)) rmSync(TMP, { recursive: true });
  });

  test("AC11: memory-augmented graph parses and compiles", () => {
    const raw = readFileSync(join(FIXTURES, "memory-diamond.yaml"), "utf-8");
    const graph = GraphSchema.parse(YAML.parse(raw));
    expect(graph.topology).toBe("memory-augmented");

    const script = compileGraph(graph, templatesDir());
    expect(script).toContain("createMemoryAugmentedWorkflow");
    expect(script).toContain("createDiamondWorkflow");
  });

  test("AC12: compiled output contains Curator interleave (wrappedAgent)", () => {
    const raw = readFileSync(join(FIXTURES, "memory-diamond.yaml"), "utf-8");
    const graph = GraphSchema.parse(YAML.parse(raw));
    const script = compileGraph(graph, templatesDir());
    // The memory-augmented template wraps context.agent via wrappedAgent
    expect(script).toContain("wrappedAgent");
  });
});
