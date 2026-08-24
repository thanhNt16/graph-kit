import type { TargetDescriptor, TargetId } from "./types.js";

const TARGETS: Record<TargetId, TargetDescriptor> = {
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
    installDir: ".omp",
    agents: { dir: "agents", format: "prompt-fragment" },
    skills: { dir: "skills" },
    rulesStrategy: "agents-md-sections",
    hooksKind: "extension-ts",
    commandsKind: "prompt-template",
    execution: { workflowTool: false, subagentDispatch: "extension" },
  },
};

const VALID = new Set<TargetId>(Object.keys(TARGETS) as TargetId[]);

export function isValidTarget(s: string): s is TargetId {
  return (VALID as Set<string>).has(s);
}

export function getTarget(id: TargetId): TargetDescriptor {
  return TARGETS[id];
}

export function listTargets(): TargetDescriptor[] {
  return Object.values(TARGETS);
}
