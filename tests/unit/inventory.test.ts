import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInventory } from "../../src/cli/commands/inventory.js";

function fixtureRoot(): string {
  return join(import.meta.dir, "..", "fixtures", "inventory");
}

describe("gk inventory", () => {
  let tmp: string;
  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "gk-inventory-test-"));
    cpSync(fixtureRoot(), tmp, { recursive: true });
  });
  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("project and user agents/skills discovered for claude, local overrides user by name", () => {
    const inv = runInventory({ cwd: tmp, target: "claude", userDir: join(tmp, "user") });

    const byName = new Map(inv.agents.map((a) => [a.name, a.model]));
    expect(byName.has("code-reviewer")).toBe(true);
    expect(byName.has("local-agent")).toBe(true);
    expect(byName.has("user-agent")).toBe(true);

    // Project overrides user: code-reviewer.md exists in both, local model wins.
    expect(byName.get("code-reviewer")).toBe("opus");
    // Local-only agent present; user-only agent survives (no collision).
    expect(byName.get("user-agent")).toBe("sonnet");
    // Frontmatter default model parsed; missing model omitted.
    expect(byName.get("local-agent")).toBeUndefined();

    expect(inv.skills).toContain("gk-recall");
    expect(inv.skills).toContain("local-skill");
    expect(inv.skills).toContain("user-skill");
  });

  test("cursor target reads .cursor instead of .claude", () => {
    const inv = runInventory({ cwd: tmp, target: "cursor", userDir: join(tmp, "user") });
    const names = inv.agents.map((a) => a.name);
    expect(names).toContain("cursor-only-agent");
    expect(names).not.toContain("local-agent");
    expect(inv.skills).toContain("cursor-skill");
  });

  test("agent frontmatter default model parsed; unknown model key omitted", () => {
    const inv = runInventory({ cwd: tmp, target: "cursor", userDir: join(tmp, "user") });
    const cur = inv.agents.find((a) => a.name === "cursor-only-agent");
    expect(cur?.model).toBe("haiku");
    const oth = inv.agents.find((a) => a.name === "other-cursor-agent");
    expect(oth?.model).toBeUndefined();
  });

  test("built-in host tools come from the versioned allowlist", () => {
    const inv = runInventory({ cwd: tmp, target: "claude", userDir: join(tmp, "user") });
    for (const t of ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "WebFetch", "Agent", "Task", "TodoWrite"]) {
      expect(inv.tools).toContain(t);
    }
  });

  test("opencode target reads descriptor dirs (agent/, skill/, command/, plugins/)", () => {
    const inv = runInventory({ cwd: tmp, target: "opencode", userDir: join(tmp, "user") });
    const byName = new Map(inv.agents.map((a) => [a.name, a.model]));
    expect(byName.get("oc-agent")).toBe("sonnet");
    expect(inv.skills).toContain("oc-skill");
    expect(inv.commands).toContain("gk-execute.md");
    expect(inv.hooks).toContain("gk.ts");
    expect(inv.tools).toContain("Task");
  });

  test("codex target parses TOML agents and discovers skills in sibling .agents/skills", () => {
    const inv = runInventory({ cwd: tmp, target: "codex", userDir: join(tmp, "user") });
    const byName = new Map(inv.agents.map((a) => [a.name, a.model]));
    expect(byName.get("reviewer")).toBe("gpt-5.3-codex-spark");
    expect(inv.skills).toContain("codex-skill");
    // Instruction-based hooks and prompt-driven commands: no artifacts to list.
    expect(inv.hooks).toEqual([]);
  });

  test("pi target lists fragments by name, prompts as commands, extensions as hooks", () => {
    const inv = runInventory({ cwd: tmp, target: "pi", userDir: join(tmp, "user") });
    expect(inv.agents.map((a) => a.name)).toContain("pi-fragment");
    expect(inv.skills).toContain("pi-skill");
    expect(inv.commands).toContain("gk.md");
    expect(inv.hooks).toContain("gk-subagent.ts");
    expect(inv.tools).toContain("gk_dispatch_agent");
  });

  test("invalid target throws with the valid target list", () => {
    expect(() => runInventory({ cwd: tmp, target: "nope" })).toThrow(/claude.*cursor.*opencode.*codex.*pi/);
  });

  test("mcp server/tool names discovered from supported config; secrets excluded", () => {
    const inv = runInventory({ cwd: tmp, target: "claude", userDir: join(tmp, "user") });
    const srv = inv.mcpServers.find((s) => s.name === "codebase-memory");
    expect(srv).toBeDefined();
    expect(srv!.tools).toContain("search_graph");
    expect(srv!.tools).toContain("get_code");
    expect(JSON.stringify(inv)).not.toMatch(/https?:\/\//);
    expect(JSON.stringify(inv)).not.toMatch(/API_KEY|CONTEXT7|BIGQUERY|12041|dhub-adtech/);
    expect(JSON.stringify(inv)).not.toMatch(/ctx7sk|codebase-memory-mcp/);
  });

  test("cursor mcp config discovered from .cursor/mcp.json", () => {
    const inv = runInventory({ cwd: tmp, target: "cursor", userDir: join(tmp, "user") });
    const ctx = inv.mcpServers.find((s) => s.name === "context7");
    expect(ctx).toBeDefined();
    expect(ctx!.tools).toContain("search");
    expect(ctx!.tools).toContain("fetch");
    expect(JSON.stringify(inv)).not.toMatch(/CONTEXT7_API_KEY|ctx7sk/);
  });

  test("malformed optional files warn but preserve valid inventory", () => {
    const inv = runInventory({ cwd: tmp, target: "claude", userDir: join(tmp, "user") });
    expect(inv.warnings.length).toBeGreaterThan(0);
    expect(inv.warnings.join(" ")).toMatch(/bad\.md|bad-skill/);
    expect(inv.agents.some((a) => a.name === "local-agent")).toBe(true);
    expect(inv.skills).toContain("local-skill");
  });

  test("no subprocess/network/install path is executed", () => {
    const inv = runInventory({ cwd: tmp, target: "claude", userDir: join(tmp, "user") });
    // Only synchronous fs + JSON/YAML parse; nothing spawned, connected, or installed.
    expect(inv.mcpServers.some((s) => s.tools.length > 0)).toBe(true);
    expect(inv.warnings.length).toBeGreaterThan(0);
  });
});

describe("gk inventory agent-parsing internals", () => {
  test("malformed frontmatter yields a warning and no agent entry", () => {
    const dir = mkdtempSync(join(tmpdir(), "gk-inv-parse-"));
    try {
      mkdirSync(join(dir, ".claude", "agents"), { recursive: true });
      writeFileSync(join(dir, ".claude", "agents", "ok.md"), "---\nname: ok\nmodel: opus\n---\nbody\n");
      writeFileSync(join(dir, ".claude", "agents", "bad.md"), "model: [unclosed,\n");
      const inv = runInventory({ cwd: dir, target: "claude", userDir: join(dir, "empty-user") });
      expect(inv.agents.map((a) => a.name)).toEqual(["ok"]);
      expect(inv.warnings.join(" ")).toMatch(/bad\.md/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
