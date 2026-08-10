export function createDiamondWorkflow(config) {
  const { nodes, limits, topology_config } = config;

  return async function diamond(context) {
    const scoutResult = await context.agent(nodes.scouter.objective, {
      model: nodes.scouter.model,
      tools: nodes.scouter.tools,
      skills: nodes.scouter.skills,
    });

    const items = scoutResult.items || context.inputs;

    // parallel() takes thunks: () => Promise — a thrown agent resolves to null, not a batch failure
    const workerResults = await context.parallel(
      items.map(
        (item) => () =>
          context.agent(nodes.worker.objective + `\n\nAssigned item: ${item}`, {
            model: nodes.worker.model,
            tools: nodes.worker.tools,
            skills: nodes.worker.skills,
          }),
      ),
    );

    // Reduce: deterministic code (dedup, rank) — NOT an agent call
    const reduced = workerResults.filter(Boolean).flat();

    const synthesized = await context.agent(nodes.synthesizer.objective, {
      model: nodes.synthesizer.model,
      refs: [...nodes.synthesizer.refs, ...context.evidence],
      tools: nodes.synthesizer.tools,
    });

    return synthesized;
  };
}
