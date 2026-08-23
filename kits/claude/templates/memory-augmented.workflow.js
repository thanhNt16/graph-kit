// Inner-topology function lookup. Each base template inlines its own createXxxWorkflow,
// so these are in scope in the compiled output.
const INNER_FN = {
  diamond: () => (typeof createDiamondWorkflow === "function" ? createDiamondWorkflow : null),
  "classify-and-act": () => (typeof createClassifyWorkflow === "function" ? createClassifyWorkflow : null),
  "adversarial-verification": () => (typeof createAdversarialWorkflow === "function" ? createAdversarialWorkflow : null),
  "loop-until-done": () => (typeof createLoopWorkflow === "function" ? createLoopWorkflow : null),
  "generate-and-filter": () => (typeof createGenerateFilterWorkflow === "function" ? createGenerateFilterWorkflow : null),
  tournament: () => (typeof createTournamentWorkflow === "function" ? createTournamentWorkflow : null),
};

// Terminal INJECTION contract: the curator's final non-empty line is exactly
// `INJECTION: <reminder>` or `INJECTION: null`. Parse only that line. Parse
// failure logs a diagnostic and acts as null. Non-null reminders are prepended
// as `[memory] ...` to the next action dispatch.
function parseInjection(output, nullAllowed = true) {
  if (typeof output !== "string") {
    console.error("[memory] curator output not a string; no terminal INJECTION line — acting null");
    return null;
  }
  const lines = output
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0);
  const last = lines[lines.length - 1];
  if (!last || !last.startsWith("INJECTION:")) {
    console.error("[memory] curator output missing terminal INJECTION line — acting null");
    return null;
  }
  const value = last.slice("INJECTION:".length).trim();
  if (value === "" || value === "null") {
    if (!nullAllowed) {
      const error = new Error("null intervention is forbidden by memory.null_intervention_allowed=false");
      error.code = "NULL_INTERVENTION_FORBIDDEN";
      throw error;
    }
    return null;
  }
  return value;
}

export function createMemoryAugmentedWorkflow(config) {
  const { nodes, topology_config } = config;
  const memory = topology_config.memory || {};
  const innerName = topology_config.inner?.__subgraph;
  const innerFn = INNER_FN[innerName];
  if (!innerFn) throw new Error(`memory-augmented: unknown inner topology "${innerName}"`);

  // Build the inner workflow from the inner sub-config (resolver already set __subgraph).
  // Normalize optional node arrays consumed by base templates; graph schema leaves
  // these optional, while compiled templates spread them.
  const normalizedNodes = Object.fromEntries(
    Object.entries(nodes).map(([id, node]) => [id, {
      ...node,
      refs: node.refs || [],
      tools: node.tools || [],
      skills: node.skills || [],
    }]),
  );
  const innerWorkflow = innerFn()({
    ...config,
    nodes: normalizedNodes,
    topology_config: topology_config.inner || {},
    evidence: config.evidence || [],
  });
  const curatorNode = nodes[memory.curator_node || "curator"];
  const cadence = memory.cadence || "on_node_complete";
  const every = memory.every || 1;
  const nullAllowed = memory.null_intervention_allowed !== false;

  return async function memoryAugmented(context) {
    let actionCalls = 0;
    let pendingInjection = null;
    const curatorPrompt = nullAllowed
      ? curatorNode.objective
      : `${curatorNode.objective}\n\nMUST end your response with a final line "INJECTION: <reminder>". Null intervention is forbidden.`;

    // Wrap context.agent so the Curator runs at cadence after each action call.
    // Cadence counts completed ACTION nodes only — curator dispatches go through
    // context.agent directly and never increment actionCalls.
    const wrappedAgent = async (prompt, opts = {}) => {
      const effectivePrompt = pendingInjection ? `[memory] ${pendingInjection}\n\n${prompt}` : prompt;
      pendingInjection = null;
      const result = await context.agent(effectivePrompt, opts);
      actionCalls++;
      const shouldCurate =
        cadence === "on_node_complete" || (cadence === "every" && actionCalls % every === 0);
      if (shouldCurate && curatorNode) {
        try {
          const curation = await context.agent(curatorPrompt, {
            model: curatorNode.model || "opus",
            tools: curatorNode.tools,
            skills: ["gk-recall"],
          });
          pendingInjection = parseInjection(curation, nullAllowed);
        } catch (error) {
          if (error?.code === "NULL_INTERVENTION_FORBIDDEN") throw error;
          // curator failure is advisory — never blocks the action pipeline
          console.error("[memory] curator dispatch failed — acting null");
          pendingInjection = null;
        }
      }
      return result;
    };
    return innerWorkflow({ ...context, evidence: context.evidence || [], agent: wrappedAgent });
  };
}