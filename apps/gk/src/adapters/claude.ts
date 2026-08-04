import type { LoadedTemplate } from "../templates/loader.js";

export interface RenderedSkill {
  relativePath: string;
  content: string;
}

const protocol = `## Authority protocol

- Start by calling \`gk workflow start\` only when no run exists.
- At every step call \`gk workflow next\`; GraphKit chooses all edges and limits.
- Submit structured output only with \`gk workflow submit\` for the returned contract.
- Execute deterministic work only with \`gk workflow execute\`; never replace it with a guessed command.
- Never infer edges, skip nodes, raise limits, or invent evidence.
- For parallel dispatch, spawn only the leased work items and never exceed the returned concurrency ceiling. Use subagents or an Agent Team only for those leases; submit each result with its lease.
`;

export function renderClaudeSkill(loaded: LoadedTemplate, skill: string): string {
  const description = `Run the ${loaded.manifest.name} GraphKit workflow through Claude Code`;
  return `---
name: graphkit-${skill}
description: ${description}
when_to_use: Use when executing the ${loaded.manifest.name} workflow.
user-invocable: true
---

${protocol}`;
}

export async function renderClaudeSkills(loaded: LoadedTemplate): Promise<RenderedSkill[]> {
  const skills = new Set<string>();
  for (const node of Object.values(loaded.workflow.nodes)) if (node.type === "agent") skills.add(node.skill);
  return [...skills]
    .sort()
    .map((skill) => ({ relativePath: `graphkit-${skill}/SKILL.md`, content: renderClaudeSkill(loaded, skill) }));
}
