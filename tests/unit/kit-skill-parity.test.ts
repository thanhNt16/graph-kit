import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const KITS = join(ROOT, "kits");

// OpenCode installs skills into .opencode/skill (singular); claude/cursor use skills/.
const SKILL_DIR_BY_KIT: Record<"claude" | "cursor" | "opencode", string> = {
  claude: "skills",
  cursor: "skills",
  opencode: "skill",
};

function skillNames(kit: "claude" | "cursor" | "opencode"): string[] {
  const dir = join(KITS, kit, SKILL_DIR_BY_KIT[kit]);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((d) => existsSync(join(dir, d, "SKILL.md")))
    .sort();
}

const CLAUDE_ONLY = ["gk-compile", "gk-run"];
const HOST_KITS = ["cursor", "opencode"] as const;

describe("claude/cursor/opencode skill-set parity", () => {
  const claude = skillNames("claude");

  test("gk-template ships in all kits", () => {
    expect(claude).toContain("gk-template");
    for (const kit of HOST_KITS) {
      expect(skillNames(kit), `${kit} should ship gk-template`).toContain("gk-template");
    }
  });

  for (const kit of HOST_KITS) {
    test(`${kit} lacks only the Claude-only skills (compile, run); no unexpected differences`, () => {
      const kitSkills = skillNames(kit);
      for (const s of CLAUDE_ONLY) {
        expect(claude, `claude should ship ${s}`).toContain(s);
        expect(kitSkills, `${kit} should NOT ship ${s}`).not.toContain(s);
      }
      // Everything else in claude must be in the host kit (and vice versa).
      const hostDiff = claude.filter((s) => !kitSkills.includes(s));
      expect(hostDiff).toEqual(CLAUDE_ONLY);
      const claudeDiff = kitSkills.filter((s) => !claude.includes(s));
      expect(claudeDiff).toEqual([]);
    });
  }
});

function skillFrontmatterName(kit: "claude" | "cursor" | "opencode", skill: string): string {
  const raw = readFileSync(join(KITS, kit, SKILL_DIR_BY_KIT[kit], skill, "SKILL.md"), "utf8");
  const m = raw.match(/^name:\s*(.*)$/m);
  return m ? m[1].trim() : "";
}

for (const kit of HOST_KITS) {
  test(`${kit} skill names use the dash form (no colon)`, () => {
    for (const skill of skillNames(kit)) {
      const name = skillFrontmatterName(kit, skill);
      expect(name, `${kit}/${skill} name '${name}' must not contain ':'`).not.toContain(":");
    }
  });

  test(`${kit} names match their directory (dash form)`, () => {
    for (const skill of skillNames(kit)) {
      expect(skillFrontmatterName(kit, skill)).toBe(skill);
    }
  });
}
