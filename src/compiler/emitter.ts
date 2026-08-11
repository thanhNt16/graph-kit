import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveTopologyConfig } from "./resolver.js";
import type { Graph } from "./validate.js";

// Presets that delegate to the custom executor must also resolve to custom.workflow.js
const EFFECTIVE_TOPOLOGY: Record<string, string> = {
  sdd: "custom",
  superpowers: "custom",
  "research-and-build": "custom",
};

const TEMPLATE_FN: Record<string, string> = {
  diamond: "createDiamondWorkflow",
  "classify-and-act": "createClassifyWorkflow",
  "adversarial-verification": "createAdversarialWorkflow",
  "loop-until-done": "createLoopWorkflow",
  "generate-and-filter": "createGenerateFilterWorkflow",
  tournament: "createTournamentWorkflow",
  "memory-augmented": "createMemoryAugmentedWorkflow",
  custom: "createCustomWorkflow",
  sdd: "createCustomWorkflow",
  superpowers: "createCustomWorkflow",
  "research-and-build": "createCustomWorkflow",
};

export function compileGraph(graph: Graph, templatesDir: string): string {
  const resolved = resolveTopologyConfig(graph.topology, graph.topology_config, templatesDir);

  // Collect the root template + every referenced subgraph template (deduped)
  const effectiveTopology = EFFECTIVE_TOPOLOGY[graph.topology] ?? graph.topology;
  const templateFiles = new Set<string>([`${effectiveTopology}.workflow.js`]);
  const collectSubgraphs = (obj: unknown) => {
    if (obj && typeof obj === "object") {
      for (const v of Object.values(obj as Record<string, unknown>)) {
        if (v && typeof v === "object" && "__subgraph" in v) {
          templateFiles.add(`${(v as { __subgraph: string }).__subgraph}.workflow.js`);
        }
        if (v && typeof v === "object") collectSubgraphs(v);
      }
    }
  };
  collectSubgraphs(resolved);

  // Inline all needed template sources (deduped, root last)
  // Strip 'export ' keyword — the Workflow tool only allows export on the meta block
  const sources = [...templateFiles]
    .filter((f, i, arr) => arr.indexOf(f) === i)
    .map((f) => readFileSync(join(templatesDir, f), "utf-8").replace(/^export /gm, ""));
  const fnName = TEMPLATE_FN[graph.topology];

  const config = {
    metadata: graph.metadata,
    nodes: graph.nodes,
    limits: graph.limits,
    evidence: graph.evidence,
    topology_config: resolved,
    outputs: graph.outputs,
  };

  return [
    `export const meta = ${JSON.stringify({ name: graph.metadata.name, description: graph.metadata.description ?? `${graph.topology} graph` }, null, 2)};`,
    ``,
    ...sources, // inlined template definitions (export stripped)
    ``,
    `const graphConfig = ${JSON.stringify(config, null, 2)};`,
    ``,
    `// Build workflow and execute with Workflow runtime context`,
    `// The runtime provides agent(), parallel(), pipeline() as globals`,
    `const _ctx = {`,
    `  agent: typeof agent !== "undefined" ? agent : undefined,`,
    `  parallel: typeof parallel !== "undefined" ? parallel : undefined,`,
    `  pipeline: typeof pipeline !== "undefined" ? pipeline : undefined,`,
    `  inputs: typeof inputs !== "undefined" ? inputs : {},`,
    `};`,
    `const _wf = ${fnName}(graphConfig);`,
    `return await _wf(_ctx);`,
  ].join("\n");
}
