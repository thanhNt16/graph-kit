function nodeOpts(node) {
  return { model: node.model, tools: node.tools, skills: node.skills, refs: node.refs };
}

export function createGenerateFilterWorkflow(config) {
  const { nodes, topology_config } = config;
  const keepTop = topology_config.keep_top ?? 3;
  return async function generateAndFilter(context) {
    const genIds = topology_config.generators ?? Object.keys(nodes).filter(n => n.startsWith("generator"));
    const batches = await context.parallel(genIds.map(gid => () =>
      context.agent(nodes[gid].objective, nodeOpts(nodes[gid]))));
    // Filter is CODE: flatten + dedupe on dedup_keys
    const dedupKeys = topology_config.dedup_keys ?? [];
    const seen = new Set();
    const candidates = batches.filter(Boolean).flatMap(b => b.candidates ?? []).filter(c => {
      const key = dedupKeys.length ? dedupKeys.map(k => c[k]).join("|") : JSON.stringify(c);
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });
    // One scoring pass against the rubric (single agent call over the full set)
    const scorer = nodes[topology_config.scorer ?? "scorer"] ?? nodes[genIds[0]];
    const scored = await context.agent(
      `Score each candidate 1-10 against this rubric:\n${topology_config.rubric}\n\nCandidates:\n${JSON.stringify(candidates)}\n\nReturn [{candidate, score}] sorted desc.`,
      nodeOpts(scorer));
    return { kept: (scored.ranked ?? []).slice(0, keepTop), total_generated: candidates.length };
  };
}
