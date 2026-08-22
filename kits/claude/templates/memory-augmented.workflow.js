// Inner-topology function lookup. Each base template inlines its own createXxxWorkflow,
// so these are in scope in the compiled output.
const INNER_FN = {
  diamond: createDiamondWorkflow,
  "classify-and-act": createClassifyWorkflow,
  "adversarial-verification": createAdversarialWorkflow,
  "loop-until-done": createLoopWorkflow,
  "generate-and-filter": createGenerateFilterWorkflow,
  tournament: createTournamentWorkflow,
};

export function createMemoryAugmentedWorkflow(config) {
  const { nodes, topology_config } = config;
  const memory = topology_config.memory || {};
  const innerName = topology_config.inner?.__subgraph;
  const innerFn = INNER_FN[innerName];
  if (!innerFn) throw new Error(`memory-augmented: unknown inner topology "${innerName}"`);

  // Build the inner workflow from the inner sub-config (resolver already set __subgraph)
  const innerWorkflow = innerFn({ ...config, topology_config: topology_config.inner || {} });
  const curatorNode = nodes[memory.curator_node || "curator"];
  const cadence = memory.cadence || "on_node_complete";
  const every = memory.every || 1;

  return async function memoryAugmented(context) {
    let calls = 0;
    // Wrap context.agent so the Curator runs at cadence after each action call.
    const wrappedAgent = async (prompt, opts = {}) => {
      const result = await context.agent(prompt, opts);
      calls++;
      const shouldCurate =
        cadence === "on_node_complete" || (cadence === "every" && calls % every === 0);
      if (shouldCurate && curatorNode) {
        await context.agent(curatorNode.objective, {
          model: curatorNode.model || "opus",
          tools: curatorNode.tools,
          skills: ["gk-recall"],
        });
      }
      return result;
    };
    return innerWorkflow({ ...context, agent: wrappedAgent });
  };
}
