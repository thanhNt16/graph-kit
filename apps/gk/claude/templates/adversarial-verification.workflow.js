function nodeOpts(node) {
  return { model: node.model, tools: node.tools, skills: node.skills, refs: node.refs };
}

export function createAdversarialWorkflow(config) {
  const { nodes, topology_config } = config;
  const threshold = topology_config.survive_threshold ?? 2;
  return async function adversarialVerification(context) {
    const producer = nodes[topology_config.producer ?? "producer"];
    const produced = await context.agent(producer.objective, nodeOpts(producer));
    const items = Array.isArray(produced.items) ? produced.items : [produced];
    const refuterIds = topology_config.refuters ?? Object.keys(nodes).filter(n => n.startsWith("refuter"));

    const judged = await context.parallel(items.map(item => async () => {
      const votes = await context.parallel(refuterIds.map(rid => async () => {
        const r = nodes[rid];
        // Refuters get ONLY the item — fresh context, no producer reasoning
        return context.agent(
          r.objective + `\n\nTry to REFUTE this finding. Default to refuted if uncertain:\n${JSON.stringify(item)}`,
          nodeOpts(r));
      }));
      const survivals = votes.filter(Boolean).filter(v => !v.refuted).length;
      return { item, survived: survivals >= threshold };
    }));
    return { kept: judged.filter(j => j?.survived).map(j => j.item),
             rejected: judged.filter(j => j && !j.survived).map(j => j.item) };
  };
}
