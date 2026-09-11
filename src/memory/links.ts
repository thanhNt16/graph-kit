// Derived connection graph. Disposable by contract: always rebuildable from the
// memory files, never hand-edited. Authored [[wikilinks]] are canonical; shared
// entity mentions (paths, evidence keys, graph/node ids) add the rest — no model.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { walkMemoryStore } from "../frontmatter.js";
import { atomicWrite } from "../fs.js";

export interface LinkGraph {
  generated_at: string;
  links: Record<string, string[]>;
}

const RESERVED = ["index.md", "log.md"];
const WIKILINK = /\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g;
// Entities worth linking on: repo-ish paths and dotted/slashed identifiers.
const ENTITY = /(?:[\w.-]+\/)+[\w.-]+/g;
// An entity mentioned by more than this many entries carries no discriminative
// signal (a ubiquitous `source:` value, a path every entry cites) and would
// link every pair — O(m²) adds, measured 5.8s at n=5000 for one entity shared
// by all entries. Skip it: [[wikilinks]] remain the explicit-connectivity
// channel for hub entities.
const MAX_ENTITY_SUPPORT = 50;

interface Entry {
  id: string;
  wikilinks: string[];
  entities: Set<string>;
}

// Any frontmatter'd markdown participates in the link graph: suggestion and
// pattern files carry fields outside MemoryFileSchema (their own status enums
// and pattern-only fields), so links validate with a permissive shape and lean
// on parseMemoryFile's id/type defaults only.
const LINK_FILE_SCHEMA = z.object({}).passthrough();

/** Walk the memory root plus one level of subfolders (patterns/, suggestions/). */
function collect(memDir: string): Entry[] {
  return walkMemoryStore(memDir, { skip: RESERVED, schema: LINK_FILE_SCHEMA }).map((entry) => {
    const wikilinks = Array.from(entry.body.matchAll(WIKILINK), (w) => w[1].trim()).filter(Boolean);
    const entities = new Set<string>();
    const source = entry.fm.source == null ? undefined : String(entry.fm.source);
    if (source) entities.add(source);
    for (const e of entry.raw.matchAll(ENTITY)) entities.add(e[0]);
    return { id: entry.id, wikilinks, entities };
  });
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

  // Shared entity mention → derived edge. Entity lists grow by push — the old
  // `[...arr, id]` spread copied the accumulated array on every insert (O(m²)
  // per entity before any edge exists).
  const byEntity = new Map<string, string[]>();
  for (const e of entries) {
    for (const ent of e.entities) {
      const ids = byEntity.get(ent);
      if (ids) ids.push(e.id);
      else byEntity.set(ent, [e.id]);
    }
  }
  for (const ids of byEntity.values()) {
    if (ids.length < 2 || ids.length > MAX_ENTITY_SUPPORT) continue;
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
  // F6: derived graph is rewritten in place — atomic, readers never see a torn
  // JSON. Compact (not pretty) — the file is re-parsed on every recall and
  // disposable/rebuildable by contract, so byte size beats human diffing.
  atomicWrite(join(memDir, ".links.json"), `${JSON.stringify(graph)}\n`);
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
