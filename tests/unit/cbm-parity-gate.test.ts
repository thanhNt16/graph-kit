import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = import.meta.dir.replace(/\/tests\/unit$/, "");

describe("cbm:parity CI gate wiring", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

  test('scripts["cbm:parity"] references scripts/cbm-parity.ts', () => {
    expect(pkg.scripts["cbm:parity"]).toContain("scripts/cbm-parity.ts");
  });

  test("ci:local chains cbm:parity", () => {
    expect(pkg.scripts["ci:local"]).toContain("cbm:parity");
  });
});

describe("agent tool-binding wire-up", () => {
  const agents = ["claude/agents/code-reviewer.md", "claude/agents/data-engineer.md"];

  for (const rel of agents) {
    test(`${rel} contains 'gk graph search'`, () => {
      const content = readFileSync(join(ROOT, rel), "utf8");
      expect(content).toContain("gk graph search");
    });
  }
});
