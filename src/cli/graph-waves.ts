// Kahn levelization shared by the executor (`graph waves`) and the renderers
// (`graph ascii`) so renderers cannot disagree with the executor. Wave index of
// a node = 1 + max(wave index of its deps): a node is ready exactly when every
// dep finished in an earlier wave.
export function topoWaves(nodes: Record<string, { depend_on?: string[] } | undefined>): {
  waves: string[][];
  unresolved: string[];
} {
  const ids = Object.keys(nodes);
  const done = new Set<string>();
  const waves: string[][] = [];
  for (;;) {
    const ready = ids.filter((id) => !done.has(id) && (nodes[id]?.depend_on ?? []).every((d) => done.has(d)));
    if (ready.length === 0) break;
    waves.push(ready);
    for (const id of ready) done.add(id);
  }
  return { waves, unresolved: ids.filter((id) => !done.has(id)) };
}
