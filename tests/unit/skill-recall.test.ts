import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("gk-recall SKILL.md has valid frontmatter", () => {
  const raw = readFileSync(join(import.meta.dir, "..", "..", "kits", "claude", "skills", "gk-recall", "SKILL.md"), "utf-8");
  const fm = raw.split("---")[1];
  expect(fm).toContain("name: gk:recall");
  expect(fm).toContain("user-invocable: true");
  expect(raw).toContain("search_graph");
  expect(raw).toContain("expired");
});
