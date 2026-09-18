// Derived connection graph. Disposable by contract: always rebuildable from the
// memory files, never hand-edited. Authored [[wikilinks]] are canonical; shared
// entity mentions (paths, evidence keys, graph/node ids) add the rest — no model.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readMemoryFile, walkMemoryFiles } from "./store.js";

export interface LinkGraph {
  generated_at: string;
  links: Record<string, string[]>;
}

const WIKILINK = /\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g;
// Entities worth linking on: repo-ish paths and dotted/slashed identifiers.
const ENTITY = /(?:[\w.-]+\/)+[\w.-]+/g;

interface Entry {
  id: string;
  wikilinks: string[];
  entities: Set<string>;
}

function parseEntry(path: string, fallbackId: string): Entry | null {
  const { fm, head, body, error } = readMemoryFile(path);
  if (error === "unreadable") return null;
  const id = typeof fm.id === "string" && fm.id.trim() ? fm.id.trim() : fallbackId;
  const text = `${head}\n${body}`;
  const wikilinks = Array.from(body.matchAll(WIKILINK), (w) => w[1].trim()).filter(Boolean);
  const entities = new Set<string>();
  if (typeof fm.source === "string" && fm.source.trim()) entities.add(fm.source.trim());
  for (const e of text.matchAll(ENTITY)) entities.add(e[0]);
  return { id, wikilinks, entities };
}

/** Walk the memory root plus one level of subfolders (patterns/, suggestions/). */
function collect(memDir: string): Entry[] {
  const out: Entry[] = [];
  for (const { rel, path } of walkMemoryFiles(memDir)) {
    const e = parseEntry(path, rel.replace(/^.*\//, "").replace(/\.md$/, ""));
    if (e) out.push(e);
  }
  return out;
}

export function buildLinks(memDir: string, now = new Date().toISOString()): LinkGraph {
  const entries = collect(memDir);
  const known = new Set(entries.map((e) => e.id));
  const links: Record<string, Set<string>> = {};
  const add = (a: string, b: string) => {
    if (a === b) return;
    if (!links[a]) links[a] = new Set();
    if (!links[b]) links[b] = new Set();
    links[a].add(b);
    links[b].add(a);
  };

  for (const e of entries) {
    links[e.id] ??= new Set();
    for (const target of e.wikilinks) if (known.has(target)) add(e.id, target);
  }

  // Shared entity mention → derived edge.
  const byEntity = new Map<string, string[]>();
  for (const e of entries) {
    for (const ent of e.entities) byEntity.set(ent, [...(byEntity.get(ent) ?? []), e.id]);
  }
  for (const ids of byEntity.values()) {
    if (ids.length < 2) continue;
    for (let i = 0; i < ids.length; i += 1) for (let j = i + 1; j < ids.length; j += 1) add(ids[i], ids[j]);
  }

  return {
    generated_at: now,
    links: Object.fromEntries(
      Object.entries(links)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, Array.from(v).sort()]),
    ),
  };
}

export function writeLinks(memDir: string, graph: LinkGraph): void {
  writeFileSync(join(memDir, ".links.json"), `${JSON.stringify(graph, null, 2)}\n`);
}

export function readLinks(memDir: string): LinkGraph {
  const f = join(memDir, ".links.json");
  const empty: LinkGraph = { generated_at: "", links: {} };
  if (!existsSync(f)) return empty;
  try {
    const parsed = JSON.parse(readFileSync(f, "utf-8"));
    return parsed && typeof parsed === "object" && parsed.links ? (parsed as LinkGraph) : empty;
  } catch {
    return empty; // disposable by contract — a corrupt file rebuilds, never blocks
  }
}

export function neighborsOf(graph: LinkGraph, id: string): string[] {
  return graph.links[id] ?? [];
}
