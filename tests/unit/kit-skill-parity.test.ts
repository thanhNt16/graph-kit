import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");

function skillNames(kit: "claude" | "cursor"): string[] {
  const dir = join(ROOT, kit, "skills");
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
