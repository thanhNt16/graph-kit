import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("gk-eval SKILL.md covers both modes + LLM-as-judge", () => {
  const raw = readFileSync(join(import.meta.dir, "..", "..", "claude", "skills", "gk-eval", "SKILL.md"), "utf-8");
  const fm = raw.split("---")[1];
  expect(fm).toContain("name: gk:eval");
  expect(raw).toContain("work_product");
  expect(raw).toContain("memory");
  expect(raw).toContain("adversarial-verification");
  expect(raw).toContain("abstention");
});
