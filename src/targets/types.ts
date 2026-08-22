export type Tier = "opus" | "sonnet" | "haiku" | "fable";

export type AgentFormat = "md-frontmatter" | "mdc" | "toml" | "prompt-fragment";
export type RulesStrategy = "rules-dir" | "agents-md-sections" | "instructions-md";
export type HooksKind = "settings-json" | "hooks-json" | "plugin-ts" | "extension-ts" | "instructions";
export type CommandsKind = "slash-skill" | "command-md" | "prompts-dir" | "prompt-template";
export type SubagentDispatch = "task-tool" | "spawn-prompt" | "extension" | "none";

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
