import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dispatch } from "../../kits/pi/extensions/gk-subagent";

const ROOT = join(import.meta.dir, "..", "..");
const KIT = join(ROOT, "kits", "pi");

describe("pi kit structure", () => {
  test("8 agent fragments with role header", () => {
    const dir = join(KIT, "agents");
    const files = readdirSync(dir).filter((f) => f.endsWith(".md"));
    expect(files.length).toBe(8);
    for (const f of files) {
      const raw = readFileSync(join(dir, f), "utf8");
      const name = f.replace(/\.md$/, "");
      expect(raw.split("\n")[0], `${f} role header`).toContain(`You are ${name}, acting as an isolated subagent.`);
    }
  });

  test("fragments carry the claude agent bodies (frontmatter stripped)", () => {
    const raw = (f: string) => readFileSync(join(KIT, "agents", f), "utf8");
    expect(raw("data-engineer.md")).toContain("# Data Engineer Agent");
    expect(raw("code-reviewer.md")).not.toMatch(/^---/);
    expect(raw("memory-curator.md")).toContain("# Memory Curator Agent");
  });

  test("11 skills matching cursor set", () => {
    const pi = readdirSync(join(KIT, "skills")).sort();
    const cursor = readdirSync(join(ROOT, "kits", "cursor", "skills")).sort();
    expect(pi).toEqual(cursor);
  });

  test("skill frontmatter names are dash form and match directories", () => {
    const dir = join(KIT, "skills");
    for (const skill of readdirSync(dir)) {
      const raw = readFileSync(join(dir, skill, "SKILL.md"), "utf8");
      const name = raw.match(/^name:\s*(.*)$/m)?.[1]?.trim() ?? "";
      expect(name, `${skill} name`).not.toContain(":");
      expect(name).toBe(skill);
    }
  });

  test("gk-execute carries gk_dispatch_agent wave protocol", () => {
    const raw = readFileSync(join(KIT, "skills", "gk-execute", "SKILL.md"), "utf8");
    expect(raw).toContain("## Dispatching a wave (pi)");
    expect(raw).toContain("gk_dispatch_agent");
    expect(raw).toContain("ok:true");
    expect(raw).toContain("constraints.no_write=true");
    expect(raw).not.toContain("/gk:");
  });

  test("no stale host path references in skills", () => {
    const offenders: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(md|py)$/.test(e.name)) {
          const raw = readFileSync(p, "utf8");
          if (/\.claude|\.cursor/.test(raw)) offenders.push(p);
        }
      }
    };
    walk(join(KIT, "skills"));
    expect(offenders).toEqual([]);
  });

  test("extension ships at .pi/extensions/gk-subagent.ts and exports pure functions", () => {
    const ext = join(KIT, "extensions", "gk-subagent.ts");
    expect(existsSync(ext)).toBe(true);
    const raw = readFileSync(ext, "utf8");
    expect(raw).toContain('"gk_dispatch_agent"');
    expect(raw).toContain("export default async function");
    expect(raw).toContain('await import("typebox")');
  });

  test("prompt template routes through gk-status", () => {
    const raw = readFileSync(join(KIT, "prompts", "gk.md"), "utf8");
    expect(raw).toContain(".pi/skills/gk-status/SKILL.md");
    expect(raw).toContain("$ARGUMENTS");
  });

  test("instructions.md carries graph-authority rules", () => {
    const raw = readFileSync(join(KIT, "instructions.md"), "utf8");
    expect(raw).toContain("graph-authority");
    expect(raw).toContain("agent-binding");
    expect(raw).toContain("topology-routing");
  });
});

describe("dispatch guard rails", () => {
  test("unknown agent fails fast without spawning a child", async () => {
    const result = await dispatch({ agent: "__nonexistent_agent__", objective: "x" });
    expect(result.ok).toBe(false);
    expect(result.exit_code).toBe(1);
    expect(result.output).toContain("__nonexistent_agent__");
  });
});
