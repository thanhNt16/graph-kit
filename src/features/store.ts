// The feature list: one JSON document the initializer session writes and
// every worker session reads — a durable backlog the loop can't forget
// (Anthropic's long-running-agent harness pattern: every item starts
// `passes: false`, workers flip exactly one flag per pass).
//
// Filesystem contract: <path> holds { items: [...] } in declared order;
// "highest priority" = first item still failing — order IS the priority
// queue, so the store never re-sorts. All writes are tmp-file + rename so
// a worker crash mid-write can never tear the file a gate is reading.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { formatZodIssues } from "../cli/diagnostics.js";
import { GraphKitError } from "../errors.js";
import type { Graph } from "../schemas/graph.schema.js";

export const DEFAULT_FEATURE_LIST_PATH = ".graphkit/feature-list.json";

const FeatureItemSchema = z
  .object({
    id: z.string().min(1),
    description: z.string().min(1),
    category: z.string().optional(),
    steps: z.array(z.string()).default([]),
    passes: z.boolean().default(false),
    note: z.string().optional(),
    // Predeclared evidence key expected to mark the item done — set at add
    // time so the closing `pass` can cite the artifact that proved it.
    evidence: z.string().optional(),
  })
  .strict();

export const FeatureListSchema = z
  .object({
    items: z.array(FeatureItemSchema).default([]),
  })
  .strict()
  .superRefine((list, ctx) => {
    // `gk features pass <id>` addresses items by id — a duplicate id makes
    // the flip ambiguous, so the file is invalid, not first-match-wins.
    const seen = new Set<string>();
    for (const item of list.items) {
      if (seen.has(item.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["items"],
          message: `duplicate feature id "${item.id}" — ids must be unique`,
        });
      }
      seen.add(item.id);
    }
  });

export type FeatureItem = z.infer<typeof FeatureItemSchema>;
export type FeatureList = z.infer<typeof FeatureListSchema>;

/** Where the list lives: graph-declared `features.path`, else the default
 *  under .graphkit/. The project root is the base — the file is shared
 *  run state, not a per-run artifact. */
export function featureListPath(cwd: string, graph?: Pick<Graph, "features"> | null): string {
  return resolve(cwd, graph?.features?.path ?? DEFAULT_FEATURE_LIST_PATH);
}

/** Read + validate the list. Missing file and malformed content are distinct
 *  codes: MISSING means "initialize it" (a gate can still plan), INVALID
 *  means "a writer corrupted it" (surface loudly, never silently reset). */
export function readFeatureList(path: string): FeatureList {
  if (!existsSync(path)) {
    throw new GraphKitError("FEATURE_LIST_MISSING", `feature list not found: ${path}`, {
      path,
      hint: "run `gk features init` to create it, or let an initializer-role node write it",
    });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch (e) {
    throw new GraphKitError(
      "FEATURE_LIST_INVALID",
      `feature list at ${path} is not valid JSON: ${String((e as Error)?.message ?? e)}`,
      { path },
    );
  }
  const parsed = FeatureListSchema.safeParse(raw);
  if (!parsed.success) {
    throw new GraphKitError("FEATURE_LIST_INVALID", `feature list at ${path} failed validation`, {
      path,
      issues: formatZodIssues(parsed.error, FeatureListSchema),
    });
  }
  return parsed.data;
}

/** Atomic write: tmp sibling + rename. Readers never observe a partial file. */
export function writeFeatureList(path: string, list: FeatureList): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(list, null, 2)}\n`);
  renameSync(tmp, path);
}

/** Create the list. Refuses to clobber an existing one without `force` — the
 *  list is the backlog's single source of truth; silently resetting `passes`
 *  flags would reopen completed work. */
export function initFeatureList(path: string, items: FeatureItem[] = [], opts?: { force?: boolean }): FeatureList {
  if (existsSync(path) && !opts?.force) {
    throw new GraphKitError("FEATURE_LIST_EXISTS", `feature list already exists: ${path}`, {
      path,
      hint: "pass --force to overwrite, or edit it directly",
    });
  }
  const parsed = FeatureListSchema.safeParse({ items });
  if (!parsed.success) {
    throw new GraphKitError("FEATURE_LIST_INVALID", "seed items failed feature-list validation", {
      issues: formatZodIssues(parsed.error, FeatureListSchema),
    });
  }
  writeFeatureList(path, parsed.data);
  return parsed.data;
}

/** Next work item: first `passes: false` in declared order. Declared order is
 *  the priority — the initializer ranks once, workers never re-rank. */
export function nextFeature(list: FeatureList): FeatureItem | null {
  return list.items.find((item) => !item.passes) ?? null;
}

/** Cross-process mutex for read-modify-write list updates: an atomic
 *  mkdir lock dir beside the file. Workers in parallel waves share the
 *  list — without serialization, concurrent `pass` calls each rewrite the
 *  whole file from a stale snapshot and the last writer silently un-passes
 *  the other's item. Locks held > STALE_MS are reclaimed (a holder that
 *  died mid-write must not brick the backlog). */
const LOCK_SPIN_MS = 4000;
const LOCK_STALE_MS = 15_000;

export function withFeatureLock<T>(path: string, fn: () => T, errorCode = "FEATURE_LIST_LOCKED"): T {
  const lock = `${path}.lock`;
  mkdirSync(dirname(lock), { recursive: true }); // lock's parent may not exist yet
  const deadline = Date.now() + LOCK_SPIN_MS;
  for (;;) {
    try {
      mkdirSync(lock); // exclusive create — atomic across processes
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) {
          rmSync(lock, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue; // holder released between stat and rm — retry
      }
      if (Date.now() > deadline) {
        throw new GraphKitError(errorCode, `store is locked by another process: ${lock}`, {
          path,
          lock,
        });
      }
      const spinUntil = Date.now() + 5;
      while (Date.now() < spinUntil) {
        /* short busy spin — locks are held for microseconds */
      }
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

/** Flip one item's flag (+ optional provenance note). Idempotent: passing an
 *  already-passed id is a no-op reported as already_passed, not an error —
 *  a worker re-firing after a crash must not fail its own ledger line.
 *  Read-modify-write runs inside the per-list lock so parallel workers
 *  can't overwrite each other's completions. */
export function passFeature(path: string, id: string, note?: string): { item: FeatureItem; already_passed: boolean } {
  return withFeatureLock(path, () => {
    const list = readFeatureList(path);
    const item = list.items.find((i) => i.id === id);
    if (!item) {
      throw new GraphKitError("FEATURE_ITEM_NOT_FOUND", `no feature with id "${id}"`, {
        id,
        available: list.items.map((i) => i.id),
      });
    }
    const already = item.passes;
    item.passes = true;
    if (note !== undefined) item.note = note;
    if (!already || note !== undefined) writeFeatureList(path, list);
    return { item, already_passed: already };
  });
}

/** Append one item — the operate→build feedback path: an agent running the
 *  software feeds a missing capability back into the backlog without
 *  hand-editing the file. The item lands at the tail (declared order IS the
 *  priority queue) with `passes: false`. Runs inside the same lock as
 *  `pass` so a concurrent write can't clobber it. An explicit id that
 *  already exists fails FEATURE_EXISTS — silently merging would hide a
 *  duplicate backlog entry; an omitted id derives a collision-free slug. */
export function addFeature(
  path: string,
  item: Partial<FeatureItem> & { description: string },
): { item: FeatureItem; list: FeatureList } {
  return withFeatureLock(path, () => {
    const list = readFeatureList(path);
    let id = item.id;
    if (id !== undefined) {
      if (list.items.some((i) => i.id === id)) {
        throw new GraphKitError("FEATURE_EXISTS", `feature "${id}" already exists`, {
          path,
          id,
          hint: "omit --id to derive a unique slug from the description",
        });
      }
    } else {
      id = itemId(item.description, new Set(list.items.map((i) => i.id)), list.items.length);
    }
    const parsed = FeatureItemSchema.safeParse({ ...item, id });
    if (!parsed.success) {
      throw new GraphKitError("FEATURE_ITEM_INVALID", "new feature item failed validation", {
        path,
        issues: formatZodIssues(parsed.error, FeatureItemSchema),
      });
    }
    list.items.push(parsed.data);
    writeFeatureList(path, list);
    return { item: parsed.data, list };
  });
}

export function featureStatus(list: FeatureList): { total: number; done: number; open: number } {
  const done = list.items.filter((i) => i.passes).length;
  return { total: list.items.length, done, open: list.items.length - done };
}

/** Deterministic item id: slug of the description, `item-N` fallback,
 *  numeric suffix on collision. Ids are opaque to the gate — uniqueness is
 *  the only contract. */
function itemId(raw: string, used: Set<string>, index: number): string {
  const slug =
    raw
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || `item-${index + 1}`;
  let id = slug;
  for (let n = 2; used.has(id); n++) id = `${slug}-${n}`;
  used.add(id);
  return id;
}

/** `gk features init` seeding: array-typed graph inputs carry their backlog
 *  in `default:` — each entry becomes an item (string → description; object →
 *  validated item fields, id filled when absent). Declaration order is kept;
 *  it IS the priority order. No array inputs → empty list. */
export function seedFromGraph(graph: Graph): FeatureItem[] {
  const used = new Set<string>();
  const items: FeatureItem[] = [];
  // id optional here — FeatureItemSchema owns the stored contract; seeds get
  // ids minted from their description when the entry doesn't name one.
  const SeedItem = z
    .object({
      id: z.string().min(1).optional(),
      description: z.string().min(1),
      category: z.string().optional(),
      steps: z.array(z.string()).default([]),
      passes: z.boolean().default(false),
      note: z.string().optional(),
      evidence: z.string().optional(),
    })
    .strict();
  for (const input of Object.values(graph.inputs)) {
    if (input.type !== "array" || !Array.isArray(input.default)) continue;
    for (const entry of input.default as unknown[]) {
      const candidate = typeof entry === "string" ? { description: entry } : entry;
      const parsed = SeedItem.safeParse(candidate);
      if (!parsed.success) continue;
      const id = parsed.data.id ?? itemId(parsed.data.description, used, items.length);
      used.add(id);
      items.push({ ...parsed.data, id });
    }
  }
  return items;
}
