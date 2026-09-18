import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = import.meta.dir.replace(/\/tests\/unit$/, "");

describe("cbm:parity CI gate wiring", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

  test('scripts["cbm:parity"] references scripts/cbm-parity.ts', () => {
    expect(pkg.scripts["cbm:parity"]).toContain("scripts/cbm-parity.ts");
  });

  test("ci:local does NOT chain cbm:parity (CBM_CMD can never be set on fresh checkouts)", () => {
    expect(pkg.scripts["ci:local"]).not.toContain("cbm:parity");
  });
});

describe("agent tool-binding wire-up", () => {
  // Agents must not advertise CBM commands: the backend is unpublished and the
  // commands exit CBM_UNAVAILABLE — a dead tool in a prompt is worse than none.
  const agents = ["kits/claude/agents/code-reviewer.md", "kits/claude/agents/data-engineer.md"];

  for (const rel of agents) {
    test(`${rel} does not reference unavailable 'gk graph search'`, () => {
      const content = readFileSync(join(ROOT, rel), "utf8");
      expect(content).not.toContain("gk graph search");
    });
  }
});
