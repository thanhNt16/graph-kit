import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const AGENTS_DIR = join(import.meta.dir, "..", "..", "claude", "agents");
const AGENT_FILES = [
  "software-architect.md",
  "code-reviewer.md",
  "qa-engineer.md",
  "data-engineer.md",
  "ui-ux-researcher.md",
  "agents-orchestrator.md",
  "document-generator.md",
];

function parseFrontmatter(content: string): Record<string, unknown> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const yaml = match[1];
  const data: Record<string, unknown> = {};
  for (const line of yaml.split("\n")) {
    const m = line.match(/^(\w[\w-]*):\s*(.+)$/);
    if (m) {
      const key = m[1]!;
      let value: unknown = m[2]?.trim();
      if (value.startsWith("[") && value.endsWith("]")) {
        value = value
          .slice(1, -1)
          .split(",")
          .map((s) => s.trim());
      }
      data[key] = value;
    }
  }
  return data;
}

describe("Agent Frontmatter", () => {
  test("all 7 agent files exist on disk", () => {
    const actual = readdirSync(AGENTS_DIR).filter((f) => f.endsWith(".md") && f !== ".gitkeep");
    expect(actual.sort()).toEqual(AGENT_FILES.sort());
  });

  test("each agent has required frontmatter fields", () => {
    const names = new Set<string>();
    for (const file of AGENT_FILES) {
      const content = readFileSync(join(AGENTS_DIR, file), "utf-8");
      const fm = parseFrontmatter(content);
      expect(fm.name, `${file}: missing 'name'`).toBeTruthy();
      expect(fm.description, `${file}: missing 'description'`).toBeTruthy();
      expect(fm.model, `${file}: missing 'model'`).toBeTruthy();
      expect(fm.graph_roles, `${file}: missing 'graph_roles'`).toBeTruthy();
      expect(fm.evidence_keys, `${file}: missing 'evidence_keys'`).toBeTruthy();
      expect(fm.source, `${file}: missing 'source'`).toBeTruthy();
      expect(Array.isArray(fm.graph_roles), `${file}: graph_roles must be an array`).toBe(true);
      expect(Array.isArray(fm.evidence_keys), `${file}: evidence_keys must be an array`).toBe(true);
      names.add(String(fm.name));
    }
    expect(names.size, "all agent names must be unique").toBe(AGENT_FILES.length);
  });

  test("all agent names are unique", () => {
    const names = AGENT_FILES.map((file) => {
      const content = readFileSync(join(AGENTS_DIR, file), "utf-8");
      const fm = parseFrontmatter(content);
      return String(fm.name);
    });
    expect(new Set(names).size).toBe(names.length);
  });
});
