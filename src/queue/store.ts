// The task queue: a durable intake surface for the software factory. Where
// `gk schedule` starts a whole graph on a cadence, `gk queue` intakes
// discrete work items — an orchestrator appends tasks, worker sessions
// claim them in dependency order, and terminal outcomes (done/failed) are
// journaled back so dependents and dashboards can see the state.
//
// Filesystem contract: one YAML file per task at
// .graphkit/queue/items/<id>.yaml carrying a `state` field that walks
// queued → claimed → done|failed. All writes are tmp-file + rename inside
// the shared mkdir lock (the same pattern as the feature list), so a crash
// mid-write can never tear a file a claimer is reading.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { formatZodIssues } from "../cli/diagnostics.js";
import { GraphKitError } from "../errors.js";
import { withFeatureLock } from "../features/store.js";

export const QUEUE_DIR = ".graphkit/queue";

export const QueueStateSchema = z.enum(["queued", "claimed", "done", "failed"]);
export type QueueState = z.infer<typeof QueueStateSchema>;

/** Ids are interpolated into item filenames — restrict to a path-safe shape
 *  so a task file can never resolve outside items/ (same discipline as
 *  session-graph ids in src/store). */
const TaskIdSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "task id must be alphanumeric plus . _ -");

/** What `gk queue add` accepts: the work contract only — id, state, hash,
 *  and lifecycle fields are store-owned. */
export const QueueTaskInputSchema = z
  .object({
    id: TaskIdSchema.optional(),
    objective: z.string().min(1),
    acceptance_criteria: z.array(z.string()).default([]),
    depends_on: z.array(TaskIdSchema).default([]),
    budget_tokens: z.number().int().positive().optional(),
    graph: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

/** The stored item: the input contract plus store-owned lifecycle fields. */
export const QueueItemSchema = z
  .object({
    id: TaskIdSchema,
    objective: z.string().min(1),
    acceptance_criteria: z.array(z.string()).default([]),
    depends_on: z.array(TaskIdSchema).default([]),
    budget_tokens: z.number().int().positive().optional(),
    graph: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    state: QueueStateSchema,
    content_hash: z.string(),
    created_at: z.string(),
    claimed_by: z.string().optional(),
    claimed_at: z.string().optional(),
    completed_at: z.string().optional(),
    note: z.string().optional(),
    evidence: z.array(z.string()).optional(),
  })
  .strict();

export type QueueTaskInput = z.infer<typeof QueueTaskInputSchema>;
export type QueueItem = z.infer<typeof QueueItemSchema>;

/** States that still "hold" a task identity: re-adding an id or identical
 *  content while one of these exists would double-execute the same work.
 *  `failed` is deliberately excluded — a failed task may be re-queued. */
const DEDUP_STATES: readonly QueueState[] = ["queued", "claimed", "done"];

export function queueDir(cwd: string): string {
  return resolve(cwd, QUEUE_DIR);
}

const itemsDir = (dir: string) => join(dir, "items");
const itemPath = (dir: string, id: string) => join(itemsDir(dir), `${id}.yaml`);

/** Deterministic content fingerprint: canonical JSON (object keys sorted at
 *  every depth) of the work contract — id, state, and lifecycle fields are
 *  excluded so "the same task again" dedups regardless of when it lands. */
export function taskContentHash(input: Omit<QueueTaskInput, "id">): string {
  const canonical = JSON.stringify(input, (_key, value) =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(
          Object.keys(value as Record<string, unknown>)
            .sort()
            .map((k) => [k, value[k]]),
        )
      : value,
  );
  return createHash("sha256").update(canonical).digest("hex");
}

function writeItem(dir: string, item: QueueItem): void {
  mkdirSync(itemsDir(dir), { recursive: true });
  const path = itemPath(dir, item.id);
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, YAML.stringify(item), "utf-8");
  renameSync(tmp, path);
}

function readItemFile(path: string): QueueItem {
  let raw: unknown;
  try {
    raw = YAML.parse(readFileSync(path, "utf-8"));
  } catch (e) {
    throw new GraphKitError(
      "QUEUE_ITEM_INVALID",
      `queue item at ${path} is not valid YAML: ${String((e as Error)?.message ?? e)}`,
      { path },
    );
  }
  const parsed = QueueItemSchema.safeParse(raw);
  if (!parsed.success) {
    throw new GraphKitError("QUEUE_ITEM_INVALID", `queue item at ${path} failed validation`, {
      path,
      issues: formatZodIssues(parsed.error, QueueItemSchema),
    });
  }
  return parsed.data;
}

/** All items, oldest first: created_at asc, id as tiebreak. Declaration
 *  order in the filesystem IS the priority order — the store never re-ranks. */
export function listItems(dir: string): QueueItem[] {
  const dir_ = itemsDir(dir);
  if (!existsSync(dir_)) return [];
  return readdirSync(dir_)
    .filter((f) => f.endsWith(".yaml"))
    .map((f) => readItemFile(join(dir_, f)))
    .sort((a, b) => (a.created_at === b.created_at ? a.id.localeCompare(b.id) : a.created_at < b.created_at ? -1 : 1));
}

export function readItem(dir: string, id: string): QueueItem {
  const path = itemPath(dir, id);
  if (!existsSync(path)) {
    throw new GraphKitError("QUEUE_ITEM_NOT_FOUND", `no queue item with id "${id}"`, {
      id,
      available: listItems(dir).map((i) => i.id),
    });
  }
  return readItemFile(path);
}

const lock = <T>(dir: string, fn: () => T): T => withFeatureLock(dir, fn, "QUEUE_LOCKED");

/** Append a task. Dedup is on identity AND content: an id already live in
 *  queued|claimed|done, or a byte-identical work contract under any id in
 *  those states, fails QUEUE_DUPLICATE — the factory must never execute the
 *  same task twice. `depends_on` must reference known item ids at add time;
 *  forward references are rejected as QUEUE_UNKNOWN_DEP. A `failed` item may
 *  be re-added (its file is replaced with a fresh queued entry). */
export function addTask(dir: string, input: QueueTaskInput): QueueItem {
  return lock(dir, () => {
    const items = listItems(dir);
    const { id: requestedId, ...contract } = input;
    const contentHash = taskContentHash(contract);
    const id = requestedId ?? mintId(contentHash, items);
    const dupe =
      items.find((i) => i.id === id && DEDUP_STATES.includes(i.state)) ??
      items.find((i) => i.content_hash === contentHash && DEDUP_STATES.includes(i.state));
    if (dupe) {
      throw new GraphKitError("QUEUE_DUPLICATE", `task already exists in the queue: ${dupe.id}`, {
        id,
        existing_id: dupe.id,
        existing_state: dupe.state,
      });
    }
    const unknown = input.depends_on.filter((dep) => !items.some((i) => i.id === dep));
    if (unknown.length > 0) {
      throw new GraphKitError("QUEUE_UNKNOWN_DEP", `depends_on references unknown task ids: ${unknown.join(", ")}`, {
        id,
        unknown,
        available: items.map((i) => i.id),
      });
    }
    const item = QueueItemSchema.parse({
      ...input,
      id,
      state: "queued",
      content_hash: contentHash,
      created_at: new Date().toISOString(),
    });
    writeItem(dir, item);
    return item;
  });
}

function mintId(contentHash: string, items: QueueItem[]): string {
  const base = `task-${Date.now()}-${contentHash.slice(0, 6)}`;
  let id = base;
  for (let n = 2; items.some((i) => i.id === id); n += 1) id = `${base}-${n}`;
  return id;
}

const depsDone = (item: QueueItem, byId: Map<string, QueueItem>) =>
  item.depends_on.every((dep) => byId.get(dep)?.state === "done");

/** Claim the oldest queued item whose dependencies are all done. An empty
 *  queue — or one where every queued item is still blocked — is NOT an
 *  error: the caller gets null and simply has no work this pass. The
 *  read-modify-write runs inside the queue lock so two workers can never
 *  claim the same item. */
export function claimTask(dir: string, claimer: string): QueueItem | null {
  return lock(dir, () => {
    const items = listItems(dir);
    const byId = new Map(items.map((i) => [i.id, i]));
    const next = items.find((i) => i.state === "queued" && depsDone(i, byId));
    if (!next) return null;
    next.state = "claimed";
    next.claimed_by = claimer;
    next.claimed_at = new Date().toISOString();
    writeItem(dir, next);
    return next;
  });
}

/** Terminal transition to `done`. Requires `claimed` — completing an
 *  unclaimed task would let a caller forge outcomes for work nobody ran. */
export function doneTask(dir: string, id: string, opts?: { note?: string; evidence?: string[] }): QueueItem {
  return lock(dir, () => {
    const item = readItem(dir, id);
    if (item.state !== "claimed") {
      throw new GraphKitError(
        "QUEUE_NOT_CLAIMED",
        `task "${id}" is ${item.state}, not claimed — done requires a claim first`,
        {
          id,
          state: item.state,
        },
      );
    }
    item.state = "done";
    item.completed_at = new Date().toISOString();
    if (opts?.note !== undefined) item.note = opts.note;
    if (opts?.evidence !== undefined) item.evidence = opts.evidence;
    writeItem(dir, item);
    return item;
  });
}

/** Terminal transition to `failed` from any non-terminal state. A failed
 *  task stays on the board as a `blocked` signal for `gk queue status`. */
export function failTask(dir: string, id: string, opts?: { note?: string }): QueueItem {
  return lock(dir, () => {
    const item = readItem(dir, id);
    if (item.state === "done" || item.state === "failed") {
      throw new GraphKitError("QUEUE_INVALID_STATE", `task "${id}" is already ${item.state}`, {
        id,
        state: item.state,
      });
    }
    item.state = "failed";
    item.completed_at = new Date().toISOString();
    if (opts?.note !== undefined) item.note = opts.note;
    writeItem(dir, item);
    return item;
  });
}

export interface QueueStatusRow {
  id: string;
  state: QueueState;
  claimer: string | null;
  /** Queued item whose depends_on are not all done yet — cannot be claimed this pass. */
  deps_blocked: boolean;
}

export interface QueueStatus {
  counts: Record<QueueState | "total", number>;
  /** Items that can never proceed without intervention: failed tasks, and
   *  live items waiting on a failed or vanished dependency. */
  blocked: Array<{ id: string; reason: string }>;
  items: QueueStatusRow[];
}

export function queueStatus(dir: string): QueueStatus {
  const items = listItems(dir);
  const byId = new Map(items.map((i) => [i.id, i]));
  const counts: QueueStatus["counts"] = { queued: 0, claimed: 0, done: 0, failed: 0, total: items.length };
  const blocked: QueueStatus["blocked"] = [];
  const rows: QueueStatusRow[] = [];
  for (const item of items) {
    counts[item.state] += 1;
    const badDep = item.depends_on.find((dep) => {
      const depItem = byId.get(dep);
      return depItem === undefined || depItem.state === "failed";
    });
    if (item.state === "failed") {
      blocked.push({ id: item.id, reason: "task failed" });
    } else if ((item.state === "queued" || item.state === "claimed") && badDep !== undefined) {
      const depItem = byId.get(badDep);
      blocked.push({
        id: item.id,
        reason: depItem === undefined ? `depends_on ${badDep}: missing` : `depends_on ${badDep}: failed`,
      });
    }
    rows.push({
      id: item.id,
      state: item.state,
      claimer: item.claimed_by ?? null,
      deps_blocked: item.state === "queued" && !depsDone(item, byId),
    });
  }
  return { counts, blocked, items: rows };
}
