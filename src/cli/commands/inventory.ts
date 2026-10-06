import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CAC } from "cac";
import YAML from "yaml";
import { getTarget, isValidTarget, listTargets } from "../../targets/index.js";
import type { TargetId } from "../../targets/types.js";
import { emit, fail, ok } from "../output.js";

export interface InventoryAgent {
  name: string;
  model?: string;
}
export interface McpServerInventory {
  name: string;
  tools: string[];
}
export interface InventoryResult {
  target: TargetId;
  tools: string[];
  agents: InventoryAgent[];
  skills: string[];
  hooks: string[];
  commands: string[];
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
// pi registers gk_dispatch_agent via .omp/extensions/gk-subagent.ts.
const BUILTIN_TOOLS_PI = [
  "Read",
  "Write",
  "Edit",
  "Bash",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "gk_dispatch_agent",
];

const TOOLS_BY_TARGET: Record<TargetId, string[]> = {
  claude: BUILTIN_TOOLS_CLAUDE,
  pi: BUILTIN_TOOLS_PI,
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

function collectAgents(dir: string, format: string, warnings: string[]): Map<string, InventoryAgent> {
  const out = new Map<string, InventoryAgent>();
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".md")) continue;
    const base = entry.replace(/\.md$/, "");
    if (format === "prompt-fragment") {
      // pi fragments have no frontmatter — basename is the agent name.
      out.set(base, { name: base });
      continue;
    }
    const file = join(dir, entry);
    let content: string;
    try {
      content = readFileSync(file, "utf-8");
    } catch (e) {
      warnings.push(`Failed to read agent "${entry}": ${String(e)}`);
      continue;
    }
    const parsed = parseFrontmatterModel(content);
    if (!parsed.name) {
      warnings.push(`Skipped agent "${entry}": missing or malformed frontmatter`);
      continue;
    }
    out.set(base, { name: base, model: parsed.model });
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

// Names of hook artifacts on disk for the target's hook kind; instruction-based hosts report none.
function collectHooks(installDir: string, hooksKind: string): string[] {
  const dir =
    hooksKind === "extension-ts"
      ? join(installDir, "extensions")
      : hooksKind === "settings-json"
        ? join(installDir, "hooks")
        : null;
  if (!dir || !existsSync(dir)) return [];
  return readdirSync(dir).sort();
}

// Names of command artifacts per kind; slash-skill hosts surface commands via their skills dir instead.
function collectCommands(installDir: string, commandsKind: string): string[] {
  if (commandsKind === "slash-skill") return [];
  const dir = join(installDir, "prompts");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).sort();
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

export function runInventory(opts: { cwd?: string; target?: string; userDir?: string }): InventoryResult {
  const requested = opts.target ?? "claude";
  if (!isValidTarget(requested)) {
    const valid = listTargets()
      .map((t) => t.id)
      .join(", ");
    throw new Error(`Invalid target: ${requested}. Must be one of: ${valid}`);
  }
  const target = requested as TargetId;
  const desc = getTarget(target);
  const cwd = opts.cwd ?? process.cwd();
  const warnings: string[] = [];

  const installDir = (base: string) => join(base, desc.installDir);
  const home = opts.userDir ?? homedir();

  // Project agents/skills, then user-global; project overrides user by name.
  const projectAgents = collectAgents(join(installDir(cwd), desc.agents.dir), desc.agents.format, warnings);
  const userAgents = collectAgents(join(installDir(home), desc.agents.dir), desc.agents.format, warnings);
  const agents = new Map<string, InventoryAgent>();
  for (const [k, v] of userAgents) agents.set(k, v);
  for (const [k, v] of projectAgents) agents.set(k, v); // project wins

  // skills.dir may point outside installDir (a host may install into a sibling dir).
  const projectSkills = collectSkills(join(cwd, desc.installDir, desc.skills.dir));
  const userSkills = collectSkills(join(home, desc.installDir, desc.skills.dir));
  const skills = [...new Set([...userSkills, ...projectSkills])].sort();

  const hooks = [
    ...new Set([...collectHooks(installDir(home), desc.hooksKind), ...collectHooks(installDir(cwd), desc.hooksKind)]),
  ].sort();
  const commands = [
    ...new Set([
      ...collectCommands(installDir(home), desc.commandsKind),
      ...collectCommands(installDir(cwd), desc.commandsKind),
    ]),
  ].sort();

  // MCP discovery is defined per-host: project .mcp.json, then user-global.
  // pi has no JSON MCP config to inventory yet.
  const mcpServers: McpServerInventory[] = [];
  if (target === "claude") {
    mcpServers.push(...collectMcpFromJson(join(cwd, ".mcp.json"), warnings));
    mcpServers.push(...collectMcpFromJson(join(home, ".claude.json"), warnings));
  }

  return {
    target,
    tools: TOOLS_BY_TARGET[target],
    agents: [...agents.values()].sort((a, b) => a.name.localeCompare(b.name)),
    skills,
    hooks,
    commands,
    mcpServers,
    warnings,
  };
}

export function registerInventoryCommands(cli: CAC) {
  cli
    .command("inventory", "Inventory installed agents, skills, tools, and MCP servers")
    .option(
      "--target <target>",
      `Kit target: ${listTargets()
        .map((t) => t.id)
        .join(" | ")} (default: claude)`,
      {
        default: "claude",
      },
    )
    .option("--json", "JSON output")
    .action((opts) => {
      if (typeof opts.target !== "string" || !isValidTarget(opts.target)) {
        const valid = listTargets()
          .map((t) => t.id)
          .join(", ");
        emit(fail("BAD_TARGET", `Invalid target: ${opts.target}. Must be one of: ${valid}`));
        return;
      }
      try {
        const result = runInventory({ target: opts.target });
        emit(ok(result));
      } catch (e) {
        emit(fail("INVENTORY_FAILED", String(e)));
      }
    });
}
