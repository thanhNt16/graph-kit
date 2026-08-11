import type { ViewerGraph, ViewerNode } from "./normalize.js";

/**
 * Pure, dependency-free rules for the interactive viewer. These are the
 * browser-visible behaviors that the design doc specifies (search/filter
 * emphasis, path emphasis, selection preservation, initial-fit policy). Kept
 * free of DOM so they can be unit-tested without a browser automation runtime.
 */

/** Model / agent / loop filter selection. */
export interface Filters {
  model: string;
  agent: string;
  loop: boolean;
}

/** Does the node match the free-text search across its searchable fields? */
export function matchesSearch(node: ViewerNode, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  const hay = [node.id, node.agent, node.objective]
    .concat(node.skills || [])
    .concat(node.tools || [])
    .join("\n")
    .toLowerCase();
  return hay.indexOf(q) !== -1;
}

/** Does the node pass the model / agent / loop filters? */
export function passesFilters(node: ViewerNode, f: Filters): boolean {
  if (f.model && node.model !== f.model) return false;
  if (f.agent && node.agent !== f.agent) return false;
  if (f.loop && !node.loop?.enabled) return false;
  return true;
}

/** Nodes visible under the current search + filters (emphasis-policy set). */
export function visibleNodeIds(graph: ViewerGraph, query: string, f: Filters): Set<string> {
  const out = new Set<string>();
  for (const id of Object.keys(graph.nodes)) {
    const node = graph.nodes[id];
    if (matchesSearch(node, query) && passesFilters(node, f)) out.add(id);
  }
  return out;
}

/**
 * The set of node IDs emphasized along a focus path: the focused node plus its
 * direct dependencies and dependents. Returns null when nothing is focused (or
 * the focus target no longer exists) — the caller dims nothing.
 */
export function emphasisIds(graph: ViewerGraph, focusId: string | null): Set<string> | null {
  if (!focusId) return null;
  const node = graph.nodes[focusId];
  if (!node) return null;
  const conn = new Set<string>([focusId]);
  for (const d of node.depend_on) conn.add(d);
  for (const d of node.dependents) conn.add(d);
  return conn;
}

/**
 * When a valid graph update arrives over SSE, keep the current selection only
 * if the node still exists in the new graph; otherwise clear it.
 */
export function retainedSelection(prevSelected: string | null, graph: ViewerGraph): string | null {
  return prevSelected && graph.nodes[prevSelected] ? prevSelected : null;
}

/**
 * The server's key gate requires the access key on every request, but the
 * bundled index.html references its assets as "./app.js" without a key. Rewrite
 * relative src/href attributes to carry the key so browser asset requests
 * authenticate. Every request still passes the per-request key gate; this only
 * makes the page's own asset URLs valid.
 */
export function injectAssetKeys(html: string, key: string): string {
  return html.replace(/(src|href)="([^"]+)"/g, (m, attr: string, url: string) => {
    if (!url.startsWith("./")) return m;
    const sep = url.includes("?") ? "&" : "?";
    return `${attr}="${url}${sep}key=${key}"`;
  });
}

/**
 * Fit the viewport only on the initial load (no prior graph). Subsequent valid
 * updates preserve the current viewport.
 */
export function shouldFit(prevGraph: ViewerGraph | null): boolean {
  return prevGraph === null;
}
