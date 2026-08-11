import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";

const FIXTURES = join(import.meta.dir, "..", "fixtures");

describe("gk:init-graph skill", () => {
  const tmpDir = join(import.meta.dir, ".tmp-init-graph");
  beforeEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
    mkdirSync(tmpDir, { recursive: true });
  });
  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
  });

  test("generates valid graph.yaml from diamond template", () => {
    const raw = readFileSync(join(FIXTURES, "minimal-diamond.yaml"), "utf-8");
    const parsed = YAML.parse(raw);
    expect(parsed.topology).toBe("diamond");
    expect(parsed.nodes).toHaveProperty("scouter");
    expect(parsed.nodes).toHaveProperty("worker");
    expect(parsed.nodes).toHaveProperty("synthesizer");
  });
});
