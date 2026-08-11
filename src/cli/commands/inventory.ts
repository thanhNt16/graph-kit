import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CAC } from "cac";
import YAML from "yaml";
import { fail, ok } from "../output.js";
import type { KitTarget } from "./kit.js";

export interface InventoryAgent {
  name: string;
  model?: string;
}
export interface McpServerInventory {
  name: string;
  tools: string[];
}
export interface InventoryResult {
  target: KitTarget;
  tools: string[];
  agents: InventoryAgent[];
  skills: string[];
  mcpServers: McpServerInventory[];
  warnings: string[];
}

// Versioned built-in host tool allowlist. Add new host tools here, never by parsing config.
const BUILTIN_TOOLS_CLAUDE = [
  "Read",
  "Write",
  "Edit",
  "NotebookEdit",
  "Bash",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "Agent",
  "Task",
  "TodoWrite",
  "AskUserQuestion",
  "ExitPlanMode",
  "Skill",
  "TaskStop",
  "Monitor",
  "EnterWorktree",
  "ExitWorktree",
  "SendMessage",
];
const BUILTIN_TOOLS_CURSOR = [
  "Bash",
  "Read",
  "Edit",
  "Write",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "Agent",
  "Task",
  "TodoWrite",
  "AskUserQuestion",
  "ExitPlanMode",
  "Skill",
];

const TOOLS_BY_TARGET: Record<KitTarget, string[]> = {
  claude: BUILTIN_TOOLS_CLAUDE,
  cursor: BUILTIN_TOOLS_CURSOR,
};

// Only these keys are ever read from MCP config. Everything else is secret/excluded.
const MCP_TOOL_KEY = "tools";
const MCP_MAX_TOOLS = 64;

function parseFrontmatterModel(content: string): { model?: string; name?: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  let data: Record<string, unknown>;
  try {
    data = YAML.parse(match[1]) ?? {};
  } catch {
    return { model: undefined, name: undefined };
  }
  const model = data.model;
  const name = data.name;
  return {
    model: typeof model === "string" && model.trim() ? model.trim() : undefined,
    name: typeof name === "string" && name.trim() ? name.trim() : undefined,
  };
}

function collectAgents(dir: string, warnings: string[]): Map<string, InventoryAgent> {
  const out = new Map<string, InventoryAgent>();
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".md")) continue;
    const file = join(dir, entry);
    let content: string;
    try {
      content = readFileSync(file, "utf-8");
    } catch (e) {
      warnings.push(`Failed to read agent "${entry}": ${String(e)}`);
      continue;
    }
    const { model, name } = parseFrontmatterModel(content);
    if (!name) {
      warnings.push(`Skipped agent "${entry}": missing or malformed frontmatter`);
      continue;
    }
    const base = entry.replace(/\.md$/, "");
    out.set(base, { name: base, model });
  }
  return out;
}

function collectSkills(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const dirent of readdirSync(dir, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue; // loose files (e.g. .pdf) are not skills
    const sub = join(dir, dirent.name);
    // A skill is a directory containing SKILL.md (kept read-only; never read contents).
    if (existsSync(join(sub, "SKILL.md"))) out.push(dirent.name);
  }
  return out.sort();
}

function collectMcpFromJson(file: string, warnings: string[]): McpServerInventory[] {
  const out: McpServerInventory[] = [];
  if (!existsSync(file)) return out;
  let raw: string;
  try {
    raw = readFileSync(file, "utf-8");
  } catch (e) {
    warnings.push(`Failed to read MCP config "${file}": ${String(e)}`);
    return out;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    warnings.push(`Malformed MCP config "${file}": ${String(e)}`);
    return out;
  }
  const servers = (parsed as { mcpServers?: Record<string, unknown> })?.mcpServers;
  if (!servers || typeof servers !== "object") return out;
  for (const [serverName, cfg] of Object.entries(servers)) {
    if (!cfg || typeof cfg !== "object") continue;
    // Only the configured "tools" array is reported. Commands, args, URLs, headers, env are excluded.
    const tools = (cfg as Record<string, unknown>)[MCP_TOOL_KEY];
    const toolNames: string[] = [];
    if (Array.isArray(tools)) {
      for (const t of tools.slice(0, MCP_MAX_TOOLS)) {
        if (typeof t === "string" && t.trim()) toolNames.push(t.trim());
      }
    }
    out.push({ name: serverName, tools: toolNames });
  }
  return out;
}

export function runInventory(opts: { cwd?: string; target?: KitTarget; userDir?: string }): InventoryResult {
  const target: KitTarget = opts.target === "cursor" ? "cursor" : "claude";
  const cwd = opts.cwd ?? process.cwd();
  const warnings: string[] = [];

  const kitDir = target === "cursor" ? ".cursor" : ".claude";
  const home = opts.userDir ?? homedir();

  // Project agents/skills, then user-global; project overrides user by name.
  const projectAgents = collectAgents(join(cwd, kitDir, "agents"), warnings);
  const userAgents = collectAgents(join(home, kitDir, "agents"), warnings);
  const agents = new Map<string, InventoryAgent>();
  for (const [k, v] of userAgents) agents.set(k, v);
  for (const [k, v] of projectAgents) agents.set(k, v); // project wins

  const projectSkills = collectSkills(join(cwd, kitDir, "skills"));
  const userSkills = collectSkills(join(home, kitDir, "skills"));
  const skills = [...new Set([...userSkills, ...projectSkills])].sort();

  // MCP discovery: project .mcp.json (Claude) / .cursor/mcp.json (Cursor), then user-global.
  const mcpServers: McpServerInventory[] = [];
  const projectMcp = target === "cursor" ? join(cwd, ".cursor", "mcp.json") : join(cwd, ".mcp.json");
  const userMcp = target === "cursor" ? join(home, ".cursor", "mcp.json") : join(home, ".claude.json");
  mcpServers.push(...collectMcpFromJson(projectMcp, warnings));
  mcpServers.push(...collectMcpFromJson(userMcp, warnings));

  return {
    target,
    tools: TOOLS_BY_TARGET[target],
    agents: [...agents.values()].sort((a, b) => a.name.localeCompare(b.name)),
    skills,
    mcpServers,
    warnings,
  };
}

export function registerInventoryCommands(cli: CAC) {
  cli
    .command("inventory", "Inventory installed agents, skills, tools, and MCP servers")
    .option("--target <target>", "Kit target: claude or cursor (default: claude)", { default: "claude" })
    .option("--json", "JSON output")
    .action((opts) => {
      if (!["claude", "cursor"].includes(opts.target)) {
        console.log(JSON.stringify(fail("BAD_TARGET", `Invalid target: ${opts.target}. Must be "claude" or "cursor"`)));
        process.exit(1);
        return;
      }
      try {
        const result = runInventory({ target: opts.target });
        console.log(JSON.stringify(ok(result)));
      } catch (e) {
        console.log(JSON.stringify(fail("INVENTORY_FAILED", String(e))));
        process.exit(1);
      }
    });
}
