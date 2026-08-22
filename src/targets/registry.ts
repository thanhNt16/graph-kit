import type { TargetDescriptor } from "./types.js";

const TARGETS: Record<string, TargetDescriptor> = {
  claude: {
    id: "claude",
    kitDirName: "claude",
    installDir: ".claude",
    agents: { dir: "agents", format: "md-frontmatter" },
    skills: { dir: "skills" },
    rulesStrategy: "rules-dir",
    hooksKind: "settings-json",
    commandsKind: "slash-skill",
    execution: { workflowTool: true, subagentDispatch: "task-tool" },
  },
  cursor: {
    id: "cursor",
    kitDirName: "cursor",
    installDir: ".cursor",
    agents: { dir: "agents", format: "mdc" },
    skills: { dir: "skills" },
    rulesStrategy: "rules-dir",
    hooksKind: "hooks-json",
    commandsKind: "slash-skill",
    execution: { workflowTool: false, subagentDispatch: "task-tool" },
  },
  opencode: {
    id: "opencode",
    kitDirName: "opencode",
    installDir: ".opencode",
    agents: { dir: "agent", format: "md-frontmatter" },
    skills: { dir: "skill" },
    rulesStrategy: "agents-md-sections",
    hooksKind: "plugin-ts",
    commandsKind: "command-md",
    execution: { workflowTool: false, subagentDispatch: "task-tool" },
  },
  codex: {
    id: "codex",
    kitDirName: "codex",
    installDir: ".codex",
    agents: { dir: "agents", format: "toml" },
    skills: { dir: "../.agents/skills" }, // installed into sibling .agents/skills
    rulesStrategy: "agents-md-sections",
    hooksKind: "instructions",
    commandsKind: "prompts-dir",
    execution: { workflowTool: false, subagentDispatch: "spawn-prompt" },
  },
  pi: {
    id: "pi",
    kitDirName: "pi",
    installDir: ".pi",
    agents: { dir: "agents", format: "prompt-fragment" },
    skills: { dir: "skills" },
    rulesStrategy: "instructions-md",
    hooksKind: "extension-ts",
    commandsKind: "prompt-template",
    execution: { workflowTool: false, subagentDispatch: "extension" },
  },
};

const VALID = new Set(Object.keys(TARGETS));

export function isValidTarget(s: string): s is keyof typeof TARGETS & string {
  return VALID.has(s);
}

export function getTarget(id: string): TargetDescriptor {
  const t = TARGETS[id];
  if (!t) throw new Error(`Unknown target: ${id}`);
  return t;
}

export function listTargets(): TargetDescriptor[] {
  return Object.values(TARGETS);
}
