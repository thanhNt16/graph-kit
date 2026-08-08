function nodeOpts(node) {
  return { model: node.model, tools: node.tools, skills: node.skills, refs: node.refs };
}

export function createClassifyWorkflow(config) {
  const { nodes, topology_config } = config;
  return async function classifyAndAct(context) {
    const cls = nodes[topology_config.classifier ?? "classifier"];
    const label = await context.agent(
      cls.objective + "\n\nReturn ONLY the category label.", nodeOpts(cls));
    const route = (topology_config.routes ?? []).find(r => label.includes(r.condition));
    const handlerId = route ? route.handler : topology_config.fallback;
    if (!handlerId || !nodes[handlerId])
      return { verdict: "failed", error: `No handler for label "${label}"` };
    const handler = nodes[handlerId];
    const result = await context.agent(handler.objective + `\n\nClassified as: ${label}`, nodeOpts(handler));
    return { label, handler: handlerId, result };
  };
}
