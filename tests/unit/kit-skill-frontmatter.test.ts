import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";

const ROOT = join(import.meta.dir, "..", "..");

// Bun.Glob matches across kits/pi/skills/, kits/claude/skills/ ... and
// kits/opencode/skill/ (singular) in one pass.
const skillFiles = [...new Bun.Glob("kits/**/SKILL.md").scanSync({ cwd: ROOT })].sort();

function frontmatter(raw: string): string {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) throw new Error("no frontmatter block");
  return m[1];
}

describe("SKILL.md frontmatter is valid YAML", () => {
  test("found SKILL.md files in all kits", () => {
    expect(skillFiles.length).toBeGreaterThan(0);
    expect(skillFiles.some((f) => f.startsWith("kits/opencode/skill/"))).toBe(true);
    expect(skillFiles.some((f) => f.startsWith("kits/pi/skills/"))).toBe(true);
  });

  // Regression: unquoted plain scalars containing ': ' (e.g.
  // `description: Trigger: "eval"`) parse as nested mappings
  // ("Nested mappings are not allowed in compact mappings").
  for (const file of skillFiles) {
    test(`${file} frontmatter parses with non-empty string description`, () => {
      const raw = readFileSync(join(ROOT, file), "utf8");
      let data: unknown;
      try {
        data = YAML.parse(frontmatter(raw));
      } catch (e) {
        throw new Error(`${file}: invalid YAML frontmatter (${(e as Error).message})`);
      }
      expect(data, file).toBeInstanceOf(Object);
      const description = (data as Record<string, unknown>).description;
      expect(description, `${file}: description must be a string`).toBeString();
      expect(description as string, `${file}: description must be non-empty`).not.toBe("");
    });
  }
});
