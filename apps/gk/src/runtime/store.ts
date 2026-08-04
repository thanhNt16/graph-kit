import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { GraphKitError } from "../errors.js";
import { type Event, type Lease, LeaseSchema, type Run, RunSchema } from "../schemas.js";
import { writeJsonAtomic, writeTextAtomic } from "../shared/files.js";
import { withDirectoryLock } from "../shared/lock.js";

/** The three mutable run documents. */
export interface RunDocuments {
  run: Run;
  state: Record<string, unknown>;
  leases: Lease[];
}
export interface RunProvenance {
  run_id: string;
  node: string;
  lease?: string;
  actor?: string;
  timestamp: string;
  checkpoint: string;
}
export interface RunCheckpoint extends RunDocuments {
  provenance: RunProvenance;
}
export type RunEventInput = Omit<Event, "run_id" | "checkpoint"> & { run_id?: string; checkpoint?: string };
export interface MutationResult {
  documents: RunDocuments;
  event: RunEventInput;
  /** Return current documents without writing event/checkpoint (stale optimistic mutation). */
  skip?: boolean;
}
export type RunMutator = (documents: RunDocuments) => MutationResult | RunDocuments;

function runsDir(project: string): string {
  return join(project, ".graphkit", "runs");
}
function runDir(project: string, id: string): string {
  return join(runsDir(project), id);
}
function checkpointDir(project: string, id: string): string {
  return join(runDir(project, id), "checkpoints");
}
function checkpointName(n: number, node: string): string {
  return `${String(n).padStart(4, "0")}-${node}`;
}

async function readJson<T>(path: string, parse: (value: unknown) => T): Promise<T> {
  return parse(JSON.parse(await readFile(path, "utf8")));
}

/**
 * Append one whole event line to the run event log. Only call while holding
 * the run directory lock (via `withDirectoryLock`); reuses the exported atomic
 * text writer so the append is crash-safe. Kept private to store.ts so the
 * unsafe read-modify-write append is never exposed as a public shared primitive.
 */
async function appendEventWithinLock(path: string, event: unknown): Promise<void> {
  const existing = await readFile(path, "utf8").catch((err: unknown) => {
    if ((err as { code?: string }).code === "ENOENT") return "";
    throw err;
  });
  await writeTextAtomic(path, `${existing}${JSON.stringify(event)}\n`, false);
}

async function readDocs(dir: string): Promise<RunDocuments> {
  const [run, state, leases] = await Promise.all([
    readJson(join(dir, "run.json"), (value) => RunSchema.parse(value)),
    readJson(join(dir, "state.json"), (value) => value as Record<string, unknown>),
    readJson(join(dir, "leases.json"), (value) =>
      Array.isArray(value) ? value.map((lease) => LeaseSchema.parse(lease)) : [],
    ),
  ]);
  return { run, state, leases };
}

/** Create a run with checkpoint `0000-start`. Throws MODIFIED_TARGET if the run already exists. */
export async function createRun(
  project: string,
  run: Run,
  state: Record<string, unknown> = {},
  leases: Lease[] = [],
): Promise<Run> {
  const parsed = RunSchema.parse(run);
  const dir = runDir(project, parsed.run_id);
  await mkdir(runsDir(project), { recursive: true });
  const existing = await readFile(join(dir, "run.json"), "utf8").catch((err: unknown) => {
    if ((err as { code?: string }).code === "ENOENT") return "";
    throw err;
  });
  if (existing) throw new GraphKitError("MODIFIED_TARGET", `MODIFIED_TARGET: run already exists: ${parsed.run_id}`);
  await mkdir(checkpointDir(project, parsed.run_id), { recursive: true });
  await writeJsonAtomic(join(dir, "run.json"), parsed);
  await writeJsonAtomic(join(dir, "state.json"), state);
  await writeJsonAtomic(join(dir, "leases.json"), leases);
  await writeTextAtomic(join(dir, "events.jsonl"), "");
  const checkpoint = "0000-start";
  const provenance: RunProvenance = {
    run_id: parsed.run_id,
    node: "start",
    actor: "system",
    timestamp: new Date().toISOString(),
    checkpoint,
  };
  await writeJsonAtomic(
    join(dir, "checkpoints", `${checkpoint}.json`),
    { run: parsed, state, leases, provenance },
    true,
  );
  return parsed;
}

export async function readRun(project: string, runId: string): Promise<RunDocuments> {
  return readDocs(runDir(project, runId));
}

/**
 * Append one event to the event log. Acquires the run directory lock to stay
 * atomic against `mutateRun`.
 */
export async function appendRunEvent(project: string, runId: string, event: Event): Promise<void> {
  const dir = runDir(project, runId);
  await withDirectoryLock(dir, () => appendEventWithinLock(join(dir, "events.jsonl"), { ...event, run_id: runId }));
}

/**
 * One mutation, one lock: reads current documents, applies the pure mutator,
 * writes current documents atomically, appends exactly one event, then writes
 * the next immutable numbered checkpoint. Writes the checkpoint and current
 * documents before appending the event, so a crash before the event append
 * leaves durable state and a durable checkpoint but no ghost event referencing
 * an absent checkpoint.
 */
export async function mutateRun(project: string, runId: string, mutator: RunMutator): Promise<MutationResult> {
  const dir = runDir(project, runId);
  return withDirectoryLock(dir, async () => {
    const before = await readDocs(dir);
    const raw = mutator(before);
    const result: MutationResult =
      "event" in raw
        ? raw
        : { documents: raw, event: { type: "command", run_id: runId, timestamp: new Date().toISOString() } };
    const docs = {
      run: RunSchema.parse(result.documents.run),
      state: result.documents.state,
      leases: result.documents.leases.map((lease) => LeaseSchema.parse(lease)),
    };
    if (result.skip) return { documents: docs, event: result.event };
    const numbers = (await readdir(checkpointDir(project, runId)))
      .filter((name) => /^\d{4}-/.test(name))
      .map((name) => Number(name.slice(0, 4)));
    const number = numbers.length ? Math.max(...numbers) + 1 : 0;
    const node = docs.run.current_nodes[0] ?? "start";
    const checkpoint = checkpointName(number, node);
    const event = { ...result.event, run_id: runId, checkpoint } as Event;
    await writeJsonAtomic(join(dir, "run.json"), docs.run);
    await writeJsonAtomic(join(dir, "state.json"), docs.state);
    await writeJsonAtomic(join(dir, "leases.json"), docs.leases);
    const provenance: RunProvenance = {
      run_id: runId,
      node,
      lease: event.lease,
      actor: event.actor,
      timestamp: event.timestamp,
      checkpoint,
    };
    await writeJsonAtomic(join(dir, "checkpoints", `${checkpoint}.json`), { ...docs, provenance }, true);
    await appendEventWithinLock(join(dir, "events.jsonl"), event);
    return { documents: docs, event };
  });
}

/**
 * Restore run documents. Prefers the live documents; if any is corrupt, walks
 * numbered checkpoints newest-first and rewrites documents from the newest
 * valid checkpoint. Rewrites happen while holding the run directory lock so
 * resume mutations serialize against `mutateRun`. Never repeats a node already
 * settled in that checkpoint.
 */
export async function resumeRun(project: string, runId: string): Promise<RunDocuments> {
  const dir = runDir(project, runId);
  return withDirectoryLock(dir, async () => {
    try {
      return await readDocs(dir);
    } catch {
      const files = (await readdir(join(dir, "checkpoints")))
        .filter((name) => /^\d{4}-.*\.json$/.test(name))
        .sort()
        .reverse();
      for (const file of files) {
        try {
          const value = JSON.parse(await readFile(join(dir, "checkpoints", file), "utf8")) as RunCheckpoint;
          const docs = {
            run: RunSchema.parse(value.run),
            state: value.state,
            leases: Array.isArray(value.leases) ? value.leases.map((lease) => LeaseSchema.parse(lease)) : [],
          };
          await writeJsonAtomic(join(dir, "run.json"), docs.run);
          await writeJsonAtomic(join(dir, "state.json"), docs.state);
          await writeJsonAtomic(join(dir, "leases.json"), docs.leases);
          return docs;
        } catch {
          // corrupt checkpoint; walk backward
        }
      }
      throw new Error(`No valid checkpoint for run ${runId}`);
    }
  });
}
