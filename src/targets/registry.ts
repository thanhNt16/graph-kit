import { join } from "node:path";
import type { TargetDescriptor, TargetId } from "./types.js";

const TARGETS: Record<TargetId, TargetDescriptor> = {
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
};

export function isValidTarget(s: string): s is TargetId {
  return Object.hasOwn(TARGETS, s);
}

export function getTarget(id: TargetId): TargetDescriptor {
  return TARGETS[id];
}

export function listTargets(): TargetDescriptor[] {
  return Object.values(TARGETS);
}

// THE agent-binding name rule: "Software Architect" -> software-architect.md.
// validate (does the bound agent exist on disk?) and node-agents
// materialization (which fragment does a node read?) both resolve through
// this so the two sides can never disagree.
export function agentFileName(agent: string): string {
  return `${agent.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.md`;
}

// Agent directories to probe, first-installed target first. validate resolves
// against the first existing dir; materialization always uses the pi dir.
export function agentDirsFor(cwd: string): string[] {
  return listTargets().map((t) => join(cwd, t.installDir, t.agents.dir));
}
