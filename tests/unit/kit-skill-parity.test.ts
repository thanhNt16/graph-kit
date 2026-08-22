import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const KITS = join(ROOT, "kits");

function skillNames(kit: "claude" | "cursor"): string[] {
  const dir = join(KITS, kit, "skills");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((d) => existsSync(join(dir, d, "SKILL.md")))
    .sort();
}

const CLAUDE_ONLY = ["gk-compile", "gk-run"];

describe("claude/cursor skill-set parity", () => {
  const claude = skillNames("claude");
  const cursor = skillNames("cursor");

  test("gk-template ships in both kits", () => {
    expect(claude).toContain("gk-template");
    expect(cursor).toContain("gk-template");
  });

  test("cursor lacks only the Claude-only skills (compile, run); no unexpected differences", () => {
    for (const s of CLAUDE_ONLY) {
      expect(claude, `claude should ship ${s}`).toContain(s);
      expect(cursor, `cursor should NOT ship ${s}`).not.toContain(s);
    }
    // Everything else in claude must be in cursor (and vice versa).
    const cursorDiff = claude.filter((s) => !cursor.includes(s));
    expect(cursorDiff).toEqual(CLAUDE_ONLY);
    const claudeDiff = cursor.filter((s) => !claude.includes(s));
    expect(claudeDiff).toEqual([]);
  });
});

function skillFrontmatterName(kit: "claude" | "cursor", skill: string): string {
  const raw = readFileSync(join(KITS, kit, "skills", skill, "SKILL.md"), "utf8");
  const m = raw.match(/^name:\s*(.*)$/m);
  return m ? m[1].trim() : "";
}

test("cursor skill names use the dash form (no colon)", () => {
  for (const skill of skillNames("cursor")) {
    const name = skillFrontmatterName("cursor", skill);
    expect(name, `cursor/${skill} name '${name}' must not contain ':'`).not.toContain(":");
  }
});

test("cursor names match their directory (dash form)", () => {
  for (const skill of skillNames("cursor")) {
    expect(skillFrontmatterName("cursor", skill)).toBe(skill);
  }
});
