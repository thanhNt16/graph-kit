export const TIERS = ["opus", "sonnet", "haiku", "fable"] as const;

export type Tier = (typeof TIERS)[number];

export type TargetId = "claude" | "pi";

export type AgentFormat = "md-frontmatter" | "prompt-fragment";
export type RulesStrategy = "rules-dir" | "agents-md-sections";
export type HooksKind = "settings-json" | "extension-ts";
export type CommandsKind = "slash-skill" | "prompt-template";
export type SubagentDispatch = "task-tool" | "extension";

export interface TargetDescriptor {
  id: string;
  kitDirName: string;
  installDir: string;
  agents: { dir: string; format: AgentFormat };
  skills: { dir: string };
  rulesStrategy: RulesStrategy;
  hooksKind: HooksKind;
  commandsKind: CommandsKind;
  execution: { workflowTool: boolean; subagentDispatch: SubagentDispatch };
}
