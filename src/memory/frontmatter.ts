// src/memory/frontmatter.ts
// The single frontmatter reader for the memory store: one parser, one legacy
// coercion rule (string `tags:` → array), one malformed convention (drop the
// entry, never abort the pass). Every module that reads .graphkit/memory goes
// through parseMemoryFile/walkMemoryStore so legacy stores behave identically
// everywhere — before this module, touchMemory silently dropped string-tags
// entries that traceMemory happily scored.
import { type Dirent, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import type { z } from "zod";
import { MemoryFileSchema } from "../schemas/memory.schema.js";

export type MemoryFile = z.infer<typeof MemoryFileSchema>;

export interface ParsedMemoryFile<Z extends z.ZodType = typeof MemoryFileSchema> {
  fm: z.output<Z>;
  /** everything after the closing `---` delimiter, verbatim */
  body: string;
}

export interface MemoryStoreEntry<Z extends z.ZodType = typeof MemoryFileSchema> extends ParsedMemoryFile<Z> {
  /** schema-validated id (defaults to the filename base when absent/empty) */
  id: string;
  /** path relative to the store root: "note.md" or "patterns/p1.md" */
  file: string;
  /** absolute path on disk — the single-file reinforcement target */
  path: string;
  raw: string;
}

// Legacy stores wrote `tags: "[one, two]"` (stringified flow sequence) or a
// bare scalar; coerce like traceMemory always has. Unparseable → [].
function legacyTags(value: unknown): string[] {
  if (Array.isArray(value)) return value as string[];
  if (typeof value === "string") {
    try {
      const parsed = YAML.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * Parse one memory file: frontmatter match → YAML → legacy tags coercion →
 * id/type defaults → schema validation. Returns null on any malformation
 * (missing frontmatter, broken YAML, schema miss) — callers drop and continue,
 * matching the store-wide malformed convention.
 *
 * The schema is parameterizable because suggestion entries carry
 * `status: proposed|accepted|dismissed`, which MemoryFileSchema rejects;
 * suggest.ts validates them with SuggestionFileSchema, links.ts with a
 * permissive shape.
 */
export function parseMemoryFile(raw: string, fallbackId: string): ParsedMemoryFile | null;
export function parseMemoryFile<Z extends z.ZodType>(
  raw: string,
  fallbackId: string,
  schema: Z,
): ParsedMemoryFile<Z> | null;
export function parseMemoryFile(
  raw: string,
  fallbackId: string,
  schema?: z.ZodType,
): ParsedMemoryFile<z.ZodType> | null {
  const m = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  let fm: Record<string, unknown>;
  try {
    const parsedYaml = YAML.parse(m[1]);
    // Syntax-broken frontmatter (e.g. `tags: [unclosed`) follows the same
    // malformed convention as a schema miss below: dropped, never fatal —
    // one bad file must not kill a whole store pass.
    fm = (parsedYaml && typeof parsedYaml === "object" ? parsedYaml : {}) as Record<string, unknown>;
  } catch {
    return null;
  }
  const validated = (schema ?? MemoryFileSchema).safeParse({
    ...fm,
    tags: legacyTags(fm.tags),
    id: typeof fm.id === "string" && fm.id.trim() ? fm.id : fallbackId,
    type: typeof fm.type === "string" && fm.type.trim() ? fm.type : "knowledge",
  });
  if (!validated.success) return null;
  return { fm: validated.data, body: raw.slice(m[0].length) };
}

/** Schema-agnostic walker entry: fm is whatever the caller's schema produced. */
interface AnyEntry {
  id: string;
  file: string;
  path: string;
  raw: string;
  fm: unknown;
  body: string;
}

function walkStore(
  memDir: string,
  opts?: { skip?: string[]; schema?: z.ZodType },
): { entries: AnyEntry[]; malformed: number } {
  let root: Dirent[];
  try {
    root = readdirSync(memDir, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { entries: [], malformed: 0 };
    throw error;
  }
  const skip = new Set(opts?.skip ?? []);
  const entries: AnyEntry[] = [];
  let malformed = 0;
  for (const de of root) {
    if (de.isFile() && de.name.endsWith(".md") && !skip.has(de.name)) {
      if (pushEntry(entries, de.name, join(memDir, de.name), de.name.replace(/\.md$/, ""), opts?.schema))
        malformed += 1;
    } else if (de.isDirectory() && !de.name.startsWith(".")) {
      const sub = join(memDir, de.name);
      for (const f of readdirSync(sub, { withFileTypes: true })) {
        if (f.isFile() && f.name.endsWith(".md") && !skip.has(f.name)) {
          const rel = `${de.name}/${f.name}`;
          if (pushEntry(entries, rel, join(sub, f.name), f.name.replace(/\.md$/, ""), opts?.schema)) malformed += 1;
        }
      }
    }
  }
  return { entries, malformed };
}

/** Returns true when the file was malformed (dropped, counted — never fatal). */
function pushEntry(out: AnyEntry[], file: string, path: string, fallbackId: string, schema?: z.ZodType): boolean {
  const raw = readFileSync(path, "utf-8");
  const parsed = schema ? parseMemoryFile(raw, fallbackId, schema) : parseMemoryFile(raw, fallbackId);
  if (!parsed) return true; // malformed: dropped, never fatal
  out.push({
    id: String((parsed.fm as Record<string, unknown>).id),
    file,
    path,
    raw,
    fm: parsed.fm,
    body: parsed.body,
  });
  return false;
}

/**
 * Walk the memory store: root plus one sublevel (patterns/, suggestions/),
 * skipping dot-dirs. `opts.skip` removes extra filenames at every level (the
 * reserved index.md/log.md workflow indexes). Missing/unlistable directories
 * yield [] (ENOENT/ENOTDIR); other fs errors propagate — a locked store must
 * surface, not silently score empty.
 */
export function walkMemoryStore<Z extends z.ZodType = typeof MemoryFileSchema>(
  memDir: string,
  opts?: { skip?: string[]; schema?: Z },
): MemoryStoreEntry<Z>[] {
  return walkStore(memDir, opts).entries as MemoryStoreEntry<Z>[];
}

/** Same walk, plus the malformed-drop count (the gk-recall contract reports it). */
export function walkMemoryStoreStats<Z extends z.ZodType = typeof MemoryFileSchema>(
  memDir: string,
  opts?: { skip?: string[]; schema?: Z },
): { entries: MemoryStoreEntry<Z>[]; malformed: number } {
  const { entries, malformed } = walkStore(memDir, opts);
  return { entries: entries as MemoryStoreEntry<Z>[], malformed };
}
