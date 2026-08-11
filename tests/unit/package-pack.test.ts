import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");

/**
 * Packaging gate: `npm pack --dry-run` lists exactly what would ship in the
 * published tarball. Both kits must ship their viewer assets, server launcher,
 * skills, agents, and the built bin entry. This guards against `files` in
 * package.json dropping a kit or a viewer asset.
 */
describe("npm package tarball contents", () => {
  const result = spawnSync("npm", ["pack", "--dry-run"], { cwd: ROOT, encoding: "utf-8" });
  const listing = `${result.stdout}\n${result.stderr}`;

  test("npm pack --dry-run succeeds", () => {
    expect(result.status, `npm pack failed:\n${listing}`).toBe(0);
  });

  test("both kits ship viewer assets (claude + cursor)", () => {
    for (const kit of ["claude", "cursor"]) {
      for (const asset of ["app.js", "dagre.js", "index.html", "server.mjs", "styles.css"]) {
        expect(listing, `${kit}/viewer/${asset} missing from tarball`).toContain(`${kit}/viewer/${asset}`);
      }
    }
  });

  test("both kits ship the gk-template skill", () => {
    expect(listing).toContain("claude/skills/gk-template/SKILL.md");
    expect(listing).toContain("cursor/skills/gk-template/SKILL.md");
  });

  test("both kits ship agents and the built bin entry", () => {
    expect(listing).toContain("claude/agents/qa-engineer.md");
    expect(listing).toContain("cursor/agents/qa-engineer.md");
    // dist/index.js is the "gk" bin target
    expect(listing).toContain("dist/index.js");
  });
});
