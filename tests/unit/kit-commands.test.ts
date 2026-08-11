import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installKit } from "../../src/cli/commands/kit.js";

describe("gk init/new", () => {
  let tmp: string;
  beforeAll(() => {
    tmp = join(tmpdir(), `gk-kit-test-${Date.now()}`);
    mkdirSync(tmp, { recursive: true });
  });
  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("installKit copies claude/ contents into .claude/", () => {
    const result = installKit(tmp);
    const claudeDir = join(tmp, ".claude");
    expect(existsSync(claudeDir)).toBe(true);
    for (const sub of ["agents", "skills", "hooks", "rules"]) {
      expect(existsSync(join(claudeDir, sub))).toBe(true);
      expect(result.installed).toContain(sub);
    }
  });

  test("installKit creates .gk.json if missing", () => {
    const gkJson = join(tmp, ".claude", ".gk.json");
    expect(existsSync(gkJson)).toBe(true);
    const parsed = JSON.parse(readFileSync(gkJson, "utf-8"));
    expect(parsed).toHaveProperty("codingLevel");
    expect(parsed).toHaveProperty("statusline");
  });

  test("installKit does not overwrite existing .gk.json", () => {
    const gkJson = join(tmp, ".claude", ".gk.json");
    writeFileSync(gkJson, JSON.stringify({ codingLevel: 99, statusline: "minimal" }));
    installKit(tmp);
    const parsed = JSON.parse(readFileSync(gkJson, "utf-8"));
    expect(parsed.codingLevel).toBe(99);
  });

  test("gk new creates directory and installs", () => {
    const newDir = join(tmp, "new-project");
    mkdirSync(newDir, { recursive: true });
    const result = installKit(newDir);
    expect(existsSync(join(newDir, ".claude"))).toBe(true);
    expect(result.installed.length).toBeGreaterThan(0);
  });
});
