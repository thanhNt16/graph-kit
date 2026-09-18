// Filesystem primitives for the memory store: one frontmatter reader/writer,
// one store walk (root + one sublevel), one tokenizer. Every memory consumer
// reuses these instead of hand-rolling its own parser.

import type { Dirent } from "node:fs";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";

export interface MemoryFile {
  fm: Record<string, unknown>;
  /** Raw frontmatter text between the --- fences ("" when absent). */
  head: string;
  /** File content after the frontmatter block (whole file when absent). */
  body: string;
  error?: "unreadable" | "no_frontmatter" | "unparseable";
}

const FRONTMATTER = /^---\n([\s\S]*?)\n---/;

/** Read one memory file. Never throws — callers apply their own tolerance
 *  policy to `error` (skip, count as malformed, or fail loud). */
export function readMemoryFile(path: string): MemoryFile {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return { fm: {}, head: "", body: "", error: "unreadable" };
  }
  const m = raw.match(FRONTMATTER);
  if (!m) return { fm: {}, head: "", body: raw, error: "no_frontmatter" };
  let parsed: unknown;
  try {
    parsed = YAML.parse(m[1]);
  } catch {
    return { fm: {}, head: m[1], body: raw.slice(m[0].length), error: "unparseable" };
  }
  return {
    fm: parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {},
    head: m[1],
    body: raw.slice(m[0].length),
  };
}

/** Rewrite a memory file's frontmatter, preserving the body. */
export function writeMemoryFile(path: string, fm: Record<string, unknown>, body: string): void {
  writeFileSync(path, `---\n${YAML.stringify(fm)}---\n${body}`);
}
const RESERVED: Record<string, true> = { "index.md": true, "log.md": true };

export interface MemoryFileRef {
  /** Path relative to the memory root (e.g. "patterns/abc123.md"). */
  rel: string;
  /** Absolute path on disk. */
  path: string;
}

/** Walk the memory root plus one sublevel (patterns/, suggestions/) — the
 *  consolidate layout. Reserved names (index.md, log.md) are workflow indexes,
 *  not memories. ENOENT/ENOTDIR on the root returns []; a store that exists
 *  but is unreadable throws — never silently empty. */
export function walkMemoryFiles(memDir: string): MemoryFileRef[] {
  let root: Dirent[];
  try {
    root = readdirSync(memDir, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw error;
  }
  const out: MemoryFileRef[] = [];
  for (const de of root) {
    if (de.isFile() && de.name.endsWith(".md") && !RESERVED[de.name]) {
      out.push({ rel: de.name, path: join(memDir, de.name) });
    } else if (de.isDirectory() && !de.name.startsWith(".")) {
      for (const f of readdirSync(join(memDir, de.name), { withFileTypes: true })) {
        if (f.isFile() && f.name.endsWith(".md") && !RESERVED[f.name]) {
          out.push({ rel: `${de.name}/${f.name}`, path: join(memDir, de.name, f.name) });
        }
      }
    }
  }
  return out;
}

/** The store's one token convention: lowercase, split on non-word chars, drop
 *  tokens of ≤2 chars. Shared by ranking, the explain lens, and the write gate. */
export function tokenizeList(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2);
}

export function tokenize(text: string): Set<string> {
  return new Set(tokenizeList(text));
}
