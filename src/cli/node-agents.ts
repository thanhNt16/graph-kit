import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GraphKitError } from "../errors.js";
import type { Graph } from "../schemas/graph.schema.js";
import { agentFileName, getTarget } from "../targets/registry.js";

// Native-dispatch bridge (pi/omp): omp's task tool discovers agents from
// .omp/agents/*.md — but only files with valid frontmatter (name +
// description). Graph nodes bind a base fragment to a specific model, tool
// set, and skill list, so we materialize one derived agent per node:
// .omp/agents/gk-<node-id>.md. The orchestrator then dispatches natively via
// the task tool ({ agent: "gk-<node-id>" }) instead of spawning `omp -p`
// child processes through gk_dispatch_agent.

export const GK_AGENT_PREFIX = "gk-";

const READ_ONLY_TOOLS = ["read", "grep", "glob"];
const NO_WRITE_TOOLS = [...READ_ONLY_TOOLS, "bash"];

// Node tools are declared in Claude-style names (WebSearch, Read); omp tool
// ids are snake_case (web_search, read). Normalize CamelCase → snake_case.
const toOmpTool = (t: string) => t.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();

function nodeTools(node: Graph["nodes"][string]): string[] | null {
  // Explicit node.tools wins; else supervisor role forces read-only review
  // (a supervisor never writes code, regardless of constraints); else
  // constraint-derived restriction; else omit (full toolset). Other
  // constraint keys are advisory prose, not tool gates.
  if (node.tools.length > 0) return node.tools.map(toOmpTool);
  if (node.role === "supervisor") return READ_ONLY_TOOLS;
  const flags = new Set<string>();
  // tools_allowlist accepts "Read, Grep" (comma-separated) or [Read, Grep];
  // it narrows any flag-derived restriction rather than widening it.
  let allow: string[] | null = null;
  for (const c of node.constraints) {
    for (const [k, v] of Object.entries(c)) {
      if (v === true) flags.add(k);
      if (k === "tools_allowlist" && (typeof v === "string" || Array.isArray(v))) {
        const list = Array.from(
          new Set((typeof v === "string" ? v.split(",") : v).map((t) => toOmpTool(t.trim())).filter(Boolean)),
        );
        allow = allow === null ? list : allow.filter((t) => list.includes(t));
      }
    }
  }
  const base = flags.has("no_exec") ? READ_ONLY_TOOLS : flags.has("no_write") ? NO_WRITE_TOOLS : null;
  if (allow !== null) {
    if (base === null) return allow;
    // Allowlist ∩ flag-derived base; a restriction flag also vetoes
    // re-granting the exec tool through an explicit list (bash rides on
    // no_write's best-effort grace — a deliberate allowlist may not widen it).
    return allow.filter((t) => base.includes(t) && t !== "bash");
  }
  return base;
}

function scopeSection(title: string, intro: string, items: string[]): string {
  return `\n## ${title}\n${intro}\n${items.map((i) => `- ${i}`).join("\n")}\n`;
}

function yamlArray(items: string[]): string {
  return `[${items.map((i) => JSON.stringify(i)).join(", ")}]`;
}

// Materialization target: the pi target's agent dir from the target table.
export function piAgentsDir(cwd: string): string {
  const t = getTarget("pi");
  return join(cwd, t.installDir, t.agents.dir);
}

export function materializeNodeAgents(cwd: string, graph: Graph): Record<string, string> {
  const agentsDir = piAgentsDir(cwd);
  if (!existsSync(agentsDir)) {
    throw new GraphKitError("AGENTS_DIR_MISSING", `No .omp/agents directory at ${agentsDir}`, {
      hint: "Run `gk init --target pi` first.",
    });
  }
  const nodes = graph.nodes ?? {};
  const mapping: Record<string, string> = {};
  const wanted = new Set<string>();

  for (const [nodeId, node] of Object.entries(nodes)) {
    const fragmentPath = join(agentsDir, agentFileName(node.agent));
    if (!existsSync(fragmentPath)) {
      throw new GraphKitError("AGENT_NOT_FOUND", `Agent '${node.agent}' not found for node '${nodeId}'`, {
        hint: `Expected ${fragmentPath}. Available: ${readdirSync(agentsDir)
          .filter((f) => f.endsWith(".md") && !f.startsWith(GK_AGENT_PREFIX))
          .map((f) => f.slice(0, -3))
          .join(", ")}`,
      });
    }

    const agentName = `${GK_AGENT_PREFIX}${nodeId}`;
    wanted.add(`${agentName}.md`);

    // Scope/assumption sections ride the body (role prompt), not the
    // description, so long lists are never truncated.
    const body =
      readFileSync(fragmentPath, "utf8").replace(/^---\n[\s\S]*?\n---\n*/, "") +
      (node.assumptions.length > 0
        ? scopeSection(
            "Challengeable assumptions",
            "Premises you may challenge with evidence; not mandatory requirements.",
            node.assumptions,
          )
        : "") +
      (node.owns.length > 0
        ? scopeSection("Owned scope", "You may edit only paths matching these globs; read anything.", node.owns)
        : "");
    const fm: string[] = [
      "---",
      `name: ${agentName}`,
      `description: ${JSON.stringify(`Graph node '${nodeId}' (${node.agent}) — ${node.objective.trim().split("\n")[0].slice(0, 120)}`)}`,
    ];
    if (node.model) fm.push(`model: ${JSON.stringify(node.model)}`);
    const tools = nodeTools(node);
    if (tools) fm.push(`tools: ${yamlArray(tools)}`);
    if (node.skills.length > 0) fm.push(`autoloadSkills: ${yamlArray(node.skills)}`);
    fm.push("---", "");
    writeFileSync(join(agentsDir, `${agentName}.md`), `${fm.join("\n")}${body}`);
    mapping[nodeId] = agentName;
  }

  // Prune materialized agents from earlier graph revisions — stale gk-* files
  // would shadow nothing but pollute discovery and the /agents roster.
  const pruned: string[] = [];
  for (const f of readdirSync(agentsDir)) {
    if (f.startsWith(GK_AGENT_PREFIX) && f.endsWith(".md") && !wanted.has(f)) {
      rmSync(join(agentsDir, f));
      pruned.push(f);
    }
  }
  mkdirSync(agentsDir, { recursive: true });
  return mapping;
}
