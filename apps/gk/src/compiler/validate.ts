import { existsSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import type { z } from "zod";
import type { GraphSchema } from "../schemas/graph.schema.js";

export interface Finding {
  check: string;
  path: string;
  message: string;
}

export type Graph = z.infer<typeof GraphSchema>;

// Agent names resolve to kebab-case filenames: "Software Architect" → software-architect.md
export function agentFileName(agent: string): string {
  return `${agent.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.md`;
}

export function validateGraph(graph: Graph, projectRoot: string): Finding[] {
  const findings: Finding[] = [];

  // 1. Agent binding: node.agent must exist in claude/agents/
  const agentDir = join(projectRoot, "claude", "agents");
  const available = existsSync(agentDir) ? readdirSync(agentDir).map((f) => basename(f, ".md")) : [];

  for (const [id, node] of Object.entries(graph.nodes)) {
    const expected = agentFileName(node.agent).replace(/\.md$/, "");
    if (existsSync(agentDir) && !available.includes(expected)) {
      findings.push({
        check: "agent-binding",
        path: `nodes.${id}.agent`,
        message: `Agent "${node.agent}" not found. Available: ${available.join(", ")}`,
      });
    }

    // 2. Refs exist on disk
    for (const ref of node.refs) {
      if (!existsSync(join(projectRoot, ref.path))) {
        findings.push({
          check: "refs-exist",
          path: `nodes.${id}.refs`,
          message: `Ref "${ref.path}" does not exist`,
        });
      }
    }

    // 3. Loop exit: enabled loops need a stop_when or exit_condition
    if (node.loop?.enabled && !node.loop.stop_when && !node.loop.exit_condition) {
      findings.push({
        check: "loop-exit",
        path: `nodes.${id}.loop`,
        message: "Loop enabled but no stop_when or exit_condition declared",
      });
    }
  }

  // 4. Evidence coverage: every required key must be produced by some node
  const produced = new Set(Object.values(graph.nodes).flatMap((n) => n.evidence));
  for (const key of graph.evidence.required_keys) {
    if (!produced.has(key)) {
      findings.push({
        check: "evidence-keys",
        path: "evidence.required_keys",
        message: `Required evidence key "${key}" is not produced by any node`,
      });
    }
  }

  // 5. memory-augmented topology contract
  if (graph.topology === "memory-augmented") {
    const tc = graph.topology_config as Record<string, any>;
    const inner = tc?.inner;
    if (!inner || typeof inner !== "object" || !("template" in inner)) {
      findings.push({
        check: "memory-inner",
        path: "topology_config.inner",
        message: "memory-augmented requires topology_config.inner.template (a base topology)",
      });
    }
    const mem = tc?.memory as Record<string, any> | undefined;
    const curatorNode = mem?.curator_node ?? "curator";
    if (!graph.nodes[curatorNode]) {
      findings.push({
        check: "memory-curator-node",
        path: `nodes.${curatorNode}`,
        message: `memory-augmented memory.curator_node "${curatorNode}" is not defined in nodes`,
      });
    }
  }

  // 6. eval-gate node role contract
  for (const [id, node] of Object.entries(graph.nodes)) {
    if ((node as any).role === "eval-gate") {
      if (!(node as any).eval) {
        findings.push({
          check: "eval-gate-config",
          path: `nodes.${id}.eval`,
          message: "eval-gate node requires an `eval` config block",
        });
      }
      if (!node.depend_on || node.depend_on.length === 0) {
        findings.push({
          check: "eval-gate-depend_on",
          path: `nodes.${id}.depend_on`,
          message: "eval-gate node must depend_on at least one producer node",
        });
      }
    }
  }

  return findings;
}
