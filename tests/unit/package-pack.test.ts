import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");

/**
 * Packaging gate: `npm pack --dry-run` lists exactly what would ship in the
 * published tarball. Both kits must ship their skills, agents, and the built
 * bin entry. This guards against `files` in package.json dropping a kit asset.
 */
describe("npm package tarball contents", () => {
  const result = spawnSync("npm", ["pack", "--dry-run"], { cwd: ROOT, encoding: "utf-8" });
  const listing = `${result.stdout}\n${result.stderr}`;

  test("npm pack --dry-run succeeds", () => {
    expect(result.status, `npm pack failed:\n${listing}`).toBe(0);
  });

  test("both kits ship the gk-visualize skill with archify IR reference", () => {
    for (const kit of ["claude", "cursor"]) {
      expect(listing).toContain(`kits/${kit}/skills/gk-visualize/SKILL.md`);
      expect(listing).toContain(`kits/${kit}/skills/gk-visualize/references/archify-ir.md`);
      expect(listing).toContain(`kits/${kit}/skills/gk-visualize/references/graph-palette.md`);
    }
  });

  test("both kits ship the gk-template skill", () => {
    expect(listing).toContain("kits/claude/skills/gk-template/SKILL.md");
    expect(listing).toContain("kits/cursor/skills/gk-template/SKILL.md");
  });

  test("both kits ship agents and the built bin entry", () => {
    expect(listing).toContain("kits/claude/agents/qa-engineer.md");
    expect(listing).toContain("kits/cursor/agents/qa-engineer.md");
    // dist/index.js is the "gk" bin target
    expect(listing).toContain("dist/index.js");
  });
});
