import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { installKit } from "../../src/cli/commands/kit.js";

const TMP = join(import.meta.dir, "..", "..", ".tmp-kit-deletions");
const SRC = join(TMP, "src-kit");
const PROJECT = join(TMP, "project");
const PREV_GK_KIT_DIR = process.env.GK_KIT_DIR;

// Minimal kit source: metadata.json + one shipped skill.
function makeSource(deletions: unknown): string {
  rmSync(SRC, { recursive: true, force: true });
  mkdirSync(join(SRC, "skills", "gk-run"), { recursive: true });
  writeFileSync(join(SRC, "skills", "gk-run", "SKILL.md"), "# run\n");
  // codex installs rules as AGENTS.md sections and requires this file.
  writeFileSync(join(SRC, "rules-section.md"), "# rules\n");
  writeFileSync(join(SRC, "metadata.json"), JSON.stringify({ name: "graphkit", version: "0.0.0", deletions }));
  return SRC;
}

// installKit surfaces the failure code on GraphKitError.code, not the message.
function expectInvalidMetadata(fn: () => void): void {
  expect(fn).toThrow();
  try {
    fn();
  } catch (e) {
    expect((e as { code?: string }).code).toBe("KIT_METADATA_INVALID");
  }
}

// Destination state as a previous kit version would have left it.
function makeProject(stalePaths: string[]): string {
  rmSync(PROJECT, { recursive: true, force: true });
  for (const p of stalePaths) mkdirSync(join(PROJECT, p), { recursive: true });
  return PROJECT;
}

afterEach(() => {
  if (PREV_GK_KIT_DIR === undefined) delete process.env.GK_KIT_DIR;
  else process.env.GK_KIT_DIR = PREV_GK_KIT_DIR;
  rmSync(TMP, { recursive: true, force: true });
});

describe("installKit deletions", () => {
  test("prunes retired assets from an existing project", () => {
    process.env.GK_KIT_DIR = makeSource(["viewer"]);
    const project = makeProject([".claude/viewer", ".claude/skills/gk-old"]);
    installKit(project, false, "claude");
    expect(existsSync(join(project, ".claude", "viewer"))).toBe(false);
    // Not listed in deletions: cpSync overlays, so unrelated stale dirs survive.
    expect(existsSync(join(project, ".claude", "skills", "gk-old"))).toBe(true);
    expect(existsSync(join(project, ".claude", "skills", "gk-run", "SKILL.md"))).toBe(true);
  });

  test("fresh install prunes nothing extra (no stale paths to remove)", () => {
    process.env.GK_KIT_DIR = makeSource(["viewer"]);
    const project = makeProject([]);
    installKit(project, false, "claude");
    expect(existsSync(join(project, ".claude", "skills", "gk-run"))).toBe(true);
  });

  test("codex skill deletions also prune .agents/skills", () => {
    process.env.GK_KIT_DIR = makeSource(["skills/gk-old"]);
    const project = makeProject([".codex/skills/gk-old", ".agents/skills/gk-old"]);
    installKit(project, false, "codex");
    expect(existsSync(join(project, ".codex", "skills", "gk-old"))).toBe(false);
    expect(existsSync(join(project, ".agents", "skills", "gk-old"))).toBe(false);
  });

  test("missing or empty deletions is a no-op", () => {
    process.env.GK_KIT_DIR = makeSource([]);
    const project = makeProject([".claude/viewer"]);
    installKit(project, false, "claude");
    expect(existsSync(join(project, ".claude", "viewer"))).toBe(true);
  });

  test("rejects traversal, absolute, and .gk.json deletion paths", () => {
    for (const bad of ["../evil", "/etc", "a/../../up", "", ".gk.json", "skills/.gk.json"]) {
      process.env.GK_KIT_DIR = makeSource([bad]);
      const project = makeProject([]);
      expectInvalidMetadata(() => installKit(project, false, "claude"));
    }
  });

  test("rejects non-string and non-array deletions", () => {
    for (const bad of [["viewer", 3], "viewer", { a: 1 }]) {
      process.env.GK_KIT_DIR = makeSource(bad);
      const project = makeProject([]);
      expectInvalidMetadata(() => installKit(project, false, "claude"));
    }
  });
});
