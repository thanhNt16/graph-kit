function nodeOpts(n) {
  return { model: n.model, tools: n.tools, skills: n.skills, refs: n.refs };
}

export function createCustomWorkflow(config) {
  const { nodes } = config;
  const ids = Object.keys(nodes);

  // Kahn's algorithm → topological levels (schema already guarantees acyclic)
  const levelOf = {};
  const computeLevels = () => {
    let wave = ids.filter(id => (nodes[id].depend_on || []).length === 0);
    let lvl = 0;
    const levels = [];
    while (wave.length) {
      levels.push(wave);
      for (const id of wave) levelOf[id] = lvl;
      const next = [];
      for (const id of ids) {
        if (levelOf[id] !== undefined) continue;
        const ready = (nodes[id].depend_on || []).every(d => levelOf[d] !== undefined);
        if (ready) next.push(id);
      }
      wave = next; lvl++;
    }
    return levels;
  };
  const levels = computeLevels();

  return async function custom(context) {
    const results = {};

    for (const layer of levels) {
      // Nodes within a layer are independent → run in parallel
      const thunks = layer.map(id => async () => {
        try {
          const node = nodes[id];
          const depResults = {};
          for (const d of (node.depend_on || [])) depResults[d] = results[d];

          const basePrompt = node.objective +
            (Object.keys(depResults).length > 0 ? `\n\nUpstream results: ${JSON.stringify(depResults)}` : "");

          // Node-level loop support
          if (node.loop && node.loop.enabled) {
            const maxRounds = node.loop.max_rounds || 3;
            let loopResult;
            for (let round = 1; round <= maxRounds; round++) {
              loopResult = await context.agent(
                basePrompt + `\n\n[Loop round ${round}/${maxRounds}. Stop when: ${node.loop.stop_when || "done"}]`,
                nodeOpts(node)
              );
            }
            results[id] = loopResult;
            return loopResult;
          }

          const result = await context.agent(basePrompt, nodeOpts(node));
          results[id] = result;
          return result;
        } catch (e) {
          const error = { ok: false, error: String(e?.message ?? e) };
          results[id] = error;
          return error;
        }
      });

      await context.parallel(thunks);
      const failed = layer.filter(id => {
        const result = results[id];
        return !result || (typeof result === "object" && result.ok === false);
      });
      if (failed.length) {
        throw new Error(`GK_WAVE_FAILED: node(s) ${failed.join(", ")} failed; later waves not dispatched`);
      }
    }

    // Terminal nodes = nodes no other node depends on
    const hasParent = new Set();
    for (const id of ids) {
      for (const d of (nodes[id].depend_on || [])) hasParent.add(d);
    }
    const terminals = ids.filter(id => !hasParent.has(id));
    return Object.fromEntries(terminals.map(id => [id, results[id]]));
  };
}
