function nodeOpts(node) {
  return { model: node.model, tools: node.tools, skills: node.skills, refs: node.refs };
}

export function createTournamentWorkflow(config) {
  const { nodes, topology_config } = config;
  return async function tournament(context) {
    const candIds = topology_config.candidates ?? Object.keys(nodes).filter((n) => n.startsWith("candidate"));
    const judge = nodes[topology_config.judge ?? "judge"];
    // Each candidate produces its attempt in parallel
    let pool = await context.parallel(
      candIds.map((cid) => async () => ({
        id: cid,
        attempt: await context.agent(nodes[cid].objective, nodeOpts(nodes[cid])),
      })),
    );
    pool = pool.filter(Boolean);
    // Pairwise elimination rounds until one champion
    while (pool.length > 1) {
      const next = [];
      for (let i = 0; i < pool.length; i += 2) {
        if (i + 1 >= pool.length) {
          next.push(pool[i]);
          continue;
        } // bye
        const [a, b] = [pool[i], pool[i + 1]];
        const verdict = await context.agent(
          judge.objective +
            `\n\nCompare:\nA (${a.id}): ${JSON.stringify(a.attempt)}\nB (${b.id}): ${JSON.stringify(b.attempt)}\n\nReturn {"winner": "A"|"B", "reason": "..."}`,
          nodeOpts(judge),
        );
        next.push(verdict.winner === "B" ? b : a);
      }
      pool = next;
    }
    return { champion: pool[0] };
  };
}
