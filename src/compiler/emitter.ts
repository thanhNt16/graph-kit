import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Graph } from "../schemas/graph.schema.js";
import type { TopologyName } from "../schemas/topology/index.js";
import { resolveTopologyConfig } from "./resolver.js";

// Presets that delegate to the custom executor resolve to custom.workflow.js;
// `fn` is the workflow factory the emitted script calls. Keyed by TopologyName
// so adding a topology without an emitter entry is a compile error, not a
// silent fallback that emits a broken script.
const TOPOLOGY_TABLE: Record<TopologyName, { effective: string; fn: string }> = {
  diamond: { effective: "diamond", fn: "createDiamondWorkflow" },
  "classify-and-act": { effective: "classify-and-act", fn: "createClassifyWorkflow" },
  "adversarial-verification": { effective: "adversarial-verification", fn: "createAdversarialWorkflow" },
  "loop-until-done": { effective: "loop-until-done", fn: "createLoopWorkflow" },
  "generate-and-filter": { effective: "generate-and-filter", fn: "createGenerateFilterWorkflow" },
  tournament: { effective: "tournament", fn: "createTournamentWorkflow" },
  "memory-augmented": { effective: "memory-augmented", fn: "createMemoryAugmentedWorkflow" },
  custom: { effective: "custom", fn: "createCustomWorkflow" },
  sdd: { effective: "custom", fn: "createCustomWorkflow" },
  superpowers: { effective: "custom", fn: "createCustomWorkflow" },
  "research-and-build": { effective: "custom", fn: "createCustomWorkflow" },
};

export function compileGraph(graph: Graph, templatesDir: string): string {
  const resolved = resolveTopologyConfig(graph.topology_config, templatesDir);

  // Collect the root template + every referenced subgraph template (deduped)
  const { effective, fn } = TOPOLOGY_TABLE[graph.topology];
  const templateFiles = new Set<string>([`${effective}.workflow.js`]);
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

  // Inline all needed template sources (root last).
  // Strip 'export ' keyword — the Workflow tool only allows export on the meta block
  const sources = [...templateFiles].map((f) => readFileSync(join(templatesDir, f), "utf-8").replace(/^export /gm, ""));

  const config = {
    metadata: graph.metadata,
    nodes: graph.nodes,
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
    `const _wf = ${fn}(graphConfig);`,
    `return await _wf(_ctx);`,
  ].join("\n");
}
