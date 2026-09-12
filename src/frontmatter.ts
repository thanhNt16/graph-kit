// src/frontmatter.ts
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
import { MemoryFileSchema } from "./schemas/memory.schema.js";

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

// YAML 1.2 core scalar resolution, restricted to the forms a flat `key: value`
// line can carry (see tryParseFlatFrontmatter). Dates stay strings — the yaml
// package's core schema resolves `2026-09-11` to string too. Dot-leading
// values (.5, .nan, .inf) are NOT resolved here: the yaml package's exact
// handling is surprising (.nan → null), so they fall back to YAML.parse.
function parseFlatScalar(value: string): unknown {
  if (value === "~" || value === "null" || value === "Null" || value === "NULL") return null;
  if (value === "true" || value === "True" || value === "TRUE") return true;
  if (value === "false" || value === "False" || value === "FALSE") return false;
  if (/^[-+]?\d+$/.test(value)) return Number.parseInt(value, 10);
  if (/^[-+]?(\d+\.\d*|\d+)([eE][-+]?\d+)?$/.test(value)) return Number.parseFloat(value);
  return value;
}

// Flat-scalar fast path: every line must be exactly `key: value` with a value
// free of YAML-significant characters. The yaml package costs ~69µs per tiny
// frontmatter file — ~93% of store-walk cost at n=5000 — while curator-authored
// frontmatter is flat in practice. Any line the whitelist can't prove flat
// (nesting, flow, quotes, comments, duplicate keys, exotic scalars) returns
// null and the caller falls back to YAML.parse, so parity holds by
// construction, not by imitation.
function tryParseFlatFrontmatter(fmText: string): Record<string, unknown> | null {
  const fm: Record<string, unknown> = {};
  for (const rawLine of fmText.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.trim() === "") continue;
    const m = line.match(/^([A-Za-z0-9][A-Za-z0-9_-]*): (.+)$/);
    if (!m) return null;
    const value = m[2];
    // `:#'"` and flow/indicator chars can change meaning (comments, nested
    // maps, anchors, aliases, block scalars, quotes); a trailing space or any
    // tab can too (multi-line plain scalars). Undecidable here → YAML.parse.
    if (/[:#'"{}[\]&*!|>%@`\t]/.test(value) || /[ ]$/.test(value)) return null;
    // `key:  value` (extra spaces) must re-join to the plain scalar YAML
    // sees, and a value opening with `- ` / `-` / `? ` is a block-sequence
    // or mapping indicator, not a scalar (YAML rejects it outright). Neither
    // is provable here → YAML.parse, so a dropped-vs-kept verdict can never
    // silently diverge (a `salience:  0.8` string once fell out as a schema
    // miss and the entry vanished).
    if (/^ /.test(value) || /^[-?]( |$)/.test(value)) return null;
    if (/^[-+]?0[xXoObB]/.test(value)) return null; // hex/oct/bin ints resolve in YAML, not here
    if (value.startsWith(".") || value.startsWith("-.") || value.startsWith("+.")) return null;
    if (m[1] in fm) return null; // YAML keeps the last duplicate key — don't guess
    fm[m[1]] = parseFlatScalar(value);
  }
  return fm;
}

/**
 * Split raw text into frontmatter + body at the `---` fences. CRLF-tolerant:
 * a Windows-checkout memory/criteria/marker file must parse, not silently
 * register as "no frontmatter" and drop out of every store pass. Returns null
 * when no frontmatter block is present. The one split rule for the repo —
 * memory entries, agent frontmatter, criteria registry files, and evidence
 * markers all share it.
 */
export function splitFrontmatter(raw: string): { fmText: string; body: string } | null {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  return { fmText: m[1], body: raw.slice(m[0].length) };
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
  const split = splitFrontmatter(raw);
  if (!split) return null;
  let fm: Record<string, unknown>;
  const flat = tryParseFlatFrontmatter(split.fmText);
  if (flat) {
    fm = flat;
  } else {
    try {
      const parsedYaml = YAML.parse(split.fmText);
      // Syntax-broken frontmatter (e.g. `tags: [unclosed`) follows the same
      // malformed convention as a schema miss below: dropped, never fatal —
      // one bad file must not kill a whole store pass.
      fm = (parsedYaml && typeof parsedYaml === "object" ? parsedYaml : {}) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  const validated = (schema ?? MemoryFileSchema).safeParse({
    ...fm,
    tags: legacyTags(fm.tags),
    id: typeof fm.id === "string" && fm.id.trim() ? fm.id : fallbackId,
    type: typeof fm.type === "string" && fm.type.trim() ? fm.type : "knowledge",
  });
  if (!validated.success) return null;
  return { fm: validated.data, body: split.body };
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
