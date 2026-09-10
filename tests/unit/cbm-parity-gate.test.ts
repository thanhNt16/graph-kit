import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = import.meta.dir.replace(/\/tests\/unit$/, "");

describe("cbm:parity CI gate wiring", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

  test('scripts["cbm:parity"] references scripts/cbm-parity.ts', () => {
    expect(pkg.scripts["cbm:parity"]).toContain("scripts/cbm-parity.ts");
  });

  test("ci:local chains cbm:parity and eval:memory", () => {
    // E2: the recall-quality eval is deterministic, offline, and fails loudly —
    // it belongs in THE gate; cbm:parity alone is a guaranteed-SKIP no-op
    // while CBM_CMD is unset everywhere in CI.
    expect(pkg.scripts["ci:local"]).toContain("cbm:parity");
    expect(pkg.scripts["ci:local"]).toContain("eval:memory");
  });

  test("cbm-parity.ts SKIP path executes clean (exit 0) without CBM_CMD", () => {
    const proc = Bun.spawnSync(["bun", "run", join(ROOT, "scripts", "cbm-parity.ts")], {
      env: { ...process.env, CBM_CMD: "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.exitCode).toBe(0);
    expect(new TextDecoder().decode(proc.stdout)).toContain("CBM not configured");
  });
});

describe("agent tool-binding wire-up", () => {
  const agents = ["kits/claude/agents/code-reviewer.md", "kits/claude/agents/data-engineer.md"];

  for (const rel of agents) {
    test(`${rel} contains 'gk graph search'`, () => {
      const content = readFileSync(join(ROOT, rel), "utf8");
      expect(content).toContain("gk graph search");
    });
  }
});
