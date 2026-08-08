import { describe, test, expect } from "bun:test";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { resolveTopologyConfig } from "../../src/compiler/resolver.js";
import { GraphKitError } from "../../src/errors.js";

const TMP = join(import.meta.dir, ".tmp-resolver");

function tmpTemplates() {
  try { rmSync(TMP, { recursive: true }); } catch {}
  mkdirSync(TMP, { recursive: true });
  // Stub template files so existsSync passes
  for (const name of ["diamond", "adversarial-verification", "classify-and-act"]) {
    writeFileSync(join(TMP, `${name}.workflow.js`), "// stub");
  }
  return TMP;
}

describe("resolveTopologyConfig", () => {
  test("passthrough: no subgraph refs returns config unchanged", () => {
    const dir = tmpTemplates();
    const config = { strategy: "fanout", count: 3 };
    const result = resolveTopologyConfig("diamond", config, dir);
    expect(result).toEqual(config);
  });

  test("subgraph reference is marked with __subgraph", () => {
    const dir = tmpTemplates();
    const config = { verify: { template: "adversarial-verification", survive_threshold: 2 } };
    const result = resolveTopologyConfig("diamond", config, dir);
    expect(result.verify).toBeDefined();
    expect((result.verify as Record<string, unknown>).__subgraph).toBe("adversarial-verification");
  });

  test("unknown subgraph template rejected", () => {
    const dir = tmpTemplates();
    const config = { verify: { template: "nonexistent-topology" } };
    expect(() => resolveTopologyConfig("diamond", config, dir)).toThrow("not a canonical topology");
  });

  test("depth limit enforced", () => {
    const dir = tmpTemplates();
    // Build a deeply nested config
    let config: Record<string, unknown> = { deep: true };
    for (let i = 0; i < 5; i++) {
      config = { sub: { template: "adversarial-verification", ...config } };
    }
    expect(() => resolveTopologyConfig("diamond", config, dir)).toThrow("nesting exceeds 3 levels");
  });
});
