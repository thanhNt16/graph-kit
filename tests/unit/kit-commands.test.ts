import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installKit, kitVersionWarnings } from "../../src/cli/commands/kit.js";
import { APP_VERSION } from "../../src/version.js";

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

  test("installKit creates .graphkit runtime directories", () => {
    for (const dir of ["evidence", "reports", "memory", "runs", "inbox"]) {
      expect(existsSync(join(tmp, ".graphkit", dir))).toBe(true);
    }
  });

  test("installKit creates .gk.json if missing", () => {
    const gkJson = join(tmp, ".claude", ".gk.json");
    expect(existsSync(gkJson)).toBe(true);
    const parsed = JSON.parse(readFileSync(gkJson, "utf-8"));
    expect(parsed).toHaveProperty("codingLevel");
    expect(parsed).toHaveProperty("statusline");
  });

  test("re-init overwrites stale kit files (upgrade refreshes skills)", () => {
    const skill = join(tmp, ".claude", "skills", "gk-recall", "SKILL.md");
    if (existsSync(skill)) writeFileSync(skill, "# stale v0.1 content\n");
    installKit(tmp);
    expect(readFileSync(skill, "utf-8")).not.toContain("stale v0.1 content");
  });

  test("installKit does not overwrite existing .gk.json", () => {
    const gkJson = join(tmp, ".claude", ".gk.json");
    writeFileSync(gkJson, JSON.stringify({ codingLevel: 99, statusline: "minimal" }));
    installKit(tmp);
    const parsed = JSON.parse(readFileSync(gkJson, "utf-8"));
    expect(parsed.codingLevel).toBe(99);
  });

  test("--force wipes kit files but preserves custom .gk.json keys", () => {
    const gkJson = join(tmp, ".claude", ".gk.json");
    writeFileSync(
      gkJson,
      JSON.stringify({ codingLevel: 2, statusline: "compact", myCustomKey: "keepme", kitVersion: "0.1.0" }),
    );
    const staleSkill = join(tmp, ".claude", "skills", "force-stale-skill");
    mkdirSync(staleSkill, { recursive: true });
    writeFileSync(join(staleSkill, "SKILL.md"), "stale");

    installKit(tmp, true);

    // kit FILES are still refreshed by --force
    expect(existsSync(staleSkill)).toBe(false);
    // user config survives the wipe and is restamped
    const parsed = JSON.parse(readFileSync(gkJson, "utf-8"));
    expect(parsed.codingLevel).toBe(2);
    expect(parsed.statusline).toBe("compact");
    expect(parsed.myCustomKey).toBe("keepme");
    expect(parsed.kitVersion).toBe(APP_VERSION);
  });

  test("gk new creates directory and installs", () => {
    const newDir = join(tmp, "new-project");
    mkdirSync(newDir, { recursive: true });
    const result = installKit(newDir);
    expect(existsSync(join(newDir, ".claude"))).toBe(true);
    expect(result.installed.length).toBeGreaterThan(0);
  });

  describe("kitVersionWarnings", () => {
    function setClaudeKitVersion(kitVersion: string | null): void {
      writeFileSync(join(tmp, ".claude", ".gk.json"), JSON.stringify(kitVersion === null ? {} : { kitVersion }));
    }
    function claudeWarning(): string | undefined {
      return kitVersionWarnings(tmp).find((w) => w.startsWith(".claude/.gk.json"));
    }

    test("recorded version newer than the running binary → 'is newer than'", () => {
      setClaudeKitVersion("9.9.9");
      const hit = claudeWarning();
      expect(hit).toContain("kitVersion=9.9.9 is newer than gk");
      expect(hit).not.toContain("predates");
    });

    test("recorded version older than the running binary → 'predates'", () => {
      setClaudeKitVersion("0.0.1");
      expect(claudeWarning()).toContain("kitVersion=0.0.1 predates gk");
    });

    test("recorded version equal to the running binary → no warning", () => {
      setClaudeKitVersion(APP_VERSION);
      expect(kitVersionWarnings(tmp).filter((w) => w.startsWith(".claude/"))).toEqual([]);
    });

    test("unrecorded kitVersion keeps the existing 'predates' wording", () => {
      setClaudeKitVersion(null);
      expect(claudeWarning()).toContain("kitVersion=unrecorded predates gk");
    });
  });
});
