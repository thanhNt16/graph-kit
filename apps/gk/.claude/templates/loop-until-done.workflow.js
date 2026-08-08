function nodeOpts(node) {
  return { model: node.model, tools: node.tools, skills: node.skills, refs: node.refs };
}

export function createLoopWorkflow(config) {
  const { nodes, limits, topology_config } = config;
  const dryThreshold = topology_config.dry_threshold ?? 2;
  const maxRounds = limits.max_iterations ?? 10;
  return async function loopUntilDone(context) {
    const seen = new Set();
    const all = [];
    let dry = 0;
    let round = 0;
    const scouter = nodes[topology_config.scouter ?? "scouter"];
    const worker = nodes[topology_config.worker_batch ?? "worker"];
    while (dry < dryThreshold && round < maxRounds) {
      round++;
      const found = await context.agent(
        scouter.objective + `\n\nRound ${round}. Already found: ${all.length} items. Find NEW items only.`,
        nodeOpts(scouter),
      );
      const fresh = (found.items ?? []).filter((i) => !seen.has(JSON.stringify(i)));
      if (fresh.length === 0) {
        dry++;
        continue;
      }
      dry = 0;
      fresh.forEach((i) => seen.add(JSON.stringify(i)));
      const results = await context.parallel(
        fresh.map(
          (item) => () => context.agent(worker.objective + `\n\nAssigned: ${JSON.stringify(item)}`, nodeOpts(worker)),
        ),
      );
      all.push(...results.filter(Boolean));
    }
    return { rounds: round, results: all };
  };
}
