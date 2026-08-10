import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { installKit, type KitTarget } from "../../src/cli/commands/kit.js";

const TMP = join(import.meta.dir, ".tmp-cursor-kit");

beforeAll(() => {
  if (existsSync(TMP)) rmSync(TMP, { recursive: true });
  mkdirSync(TMP, { recursive: true });
  installKit(TMP, false, "cursor" as KitTarget);
});

afterAll(() => {
  if (existsSync(TMP)) rmSync(TMP, { recursive: true });
});

describe("Cursor target: gk init --target cursor", () => {
  test("installs into .cursor/ (not .claude/)", () => {
    expect(existsSync(join(TMP, ".cursor"))).toBe(true);
    expect(existsSync(join(TMP, ".claude"))).toBe(false);
  });

  test("installs 3 .mdc rules with Cursor frontmatter", () => {
    const rules = readdirSync(join(TMP, ".cursor", "rules")).filter((f) => f.endsWith(".mdc"));
    expect(rules.length).toBe(3);
    // Cursor requires .mdc — plain .md is ignored
    const mdFiles = readdirSync(join(TMP, ".cursor", "rules")).filter((f) => f.endsWith(".md"));
    expect(mdFiles.length).toBe(0);
    // Each must have valid Cursor frontmatter fields
    for (const r of rules) {
      const body = readFileSync(join(TMP, ".cursor", "rules", r), "utf-8");
      expect(body).toMatch(/---[\s\S]*?---/);
      expect(body).toMatch(/alwaysApply:/);
    }
  });

  test("installs 8 agents with Cursor fields (readonly, is_background)", () => {
    const agents = readdirSync(join(TMP, ".cursor", "agents")).filter((f) => f.endsWith(".md"));
    expect(agents.length).toBe(8);
    for (const a of agents) {
      const body = readFileSync(join(TMP, ".cursor", "agents", a), "utf-8");
      expect(body).toMatch(/readonly:/);
      expect(body).toMatch(/is_background:/);
    }
  });

  test("installs 9 gk-* skills (run + compile dropped — no Cursor equivalent)", () => {
    const skills = readdirSync(join(TMP, ".cursor", "skills")).filter((f) => f.startsWith("gk-"));
    expect(skills.length).toBe(9);
    expect(skills).not.toContain("gk-run");
    expect(skills).not.toContain("gk-compile");
    expect(skills).toContain("gk-execute");
  });

  test("excalidraw-diagram portable content skill ships with references", () => {
    expect(existsSync(join(TMP, ".cursor", "skills", "excalidraw-diagram", "SKILL.md"))).toBe(true);
    expect(existsSync(join(TMP, ".cursor", "skills", "excalidraw-diagram", "references"))).toBe(true);
  });

  test("installs 4 hooks + hooks.json (Cursor format, lowercase events)", () => {
    const hooks = readdirSync(join(TMP, ".cursor", "hooks")).filter((f) => f.endsWith(".cjs"));
    expect(hooks.length).toBe(4);
    const cfg = JSON.parse(readFileSync(join(TMP, ".cursor", "hooks.json"), "utf-8"));
    expect(cfg.version).toBe(1);
    // Cursor uses lowercase event names (not PreToolUse)
    expect(cfg.hooks.preToolUse).toBeDefined();
    expect(cfg.hooks.postToolUse).toBeDefined();
    expect(cfg.hooks.subagentStart).toBeDefined();
    // Claude-Code-specific keys must not leak through
    expect(cfg.PreToolUse).toBeUndefined();
    expect(cfg.PostToolUse).toBeUndefined();
  });

  test("no settings.json for cursor (Cursor uses hooks.json)", () => {
    expect(existsSync(join(TMP, ".cursor", "settings.json"))).toBe(false);
  });

  test("gk-execute is re-platformed to Task tool (no Claude Agent/Workflow refs)", () => {
    const body = readFileSync(join(TMP, ".cursor", "skills", "gk-execute", "SKILL.md"), "utf-8");
    expect(body).toContain("Task tool");
    expect(body).toMatch(/\.cursor\/agents\//);
    // Must NOT reference Claude-Code-only mechanics
    expect(body).not.toMatch(/Claude Code subagents/);
  });

  test("rules reference .cursor/ not .claude/", () => {
    const binding = readFileSync(join(TMP, ".cursor", "rules", "agent-binding.mdc"), "utf-8");
    expect(binding).toMatch(/\.cursor\/agents\//);
    expect(binding).not.toMatch(/claude\/agents\//);
  });
});
