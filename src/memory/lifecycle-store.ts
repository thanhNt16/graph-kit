// src/memory/lifecycle-store.ts
// Filesystem half of the adherence lifecycle (evaluate() in lifecycle.ts is
// the pure half). The denominator is `.requests.jsonl` — one line per recall
// invocation (`expandedRecall`/`gk suggest`) — and archive is a rename into
// `.archive/`, never a delete.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { AdherenceSchema, MemoryLifecycleConfig } from "../schemas/memory.schema.js";
import { type Adherence, evaluate, type LifecycleConfig, type LifecycleVerdict } from "./lifecycle.js";
import { readMemoryFile, walkMemoryFiles, writeMemoryFile } from "./store.js";

/** Archive lives under a dot-dir: walkMemoryFiles skips dot-dirs, so archived
 *  items drop out of recall/suggest/injection with no filter changes. */
export const ARCHIVE_DIR = ".archive";
const REQUESTS_LOG = ".requests.jsonl";

export interface MemberRef {
  name: string;
  rel: string;
  path: string;
  adherence: Adherence;
}

const baseName = (rel: string) => rel.replace(/^.*\//, "").replace(/\.md$/, "");

/** The lifecycle's config, defaults applied. Accepts the raw
 *  `topology_config.memory.lifecycle` slice (undefined → all defaults). */
export function lifecycleConfig(raw: unknown): LifecycleConfig {
  return MemoryLifecycleConfig.parse(raw ?? {});
}

/** Append one recall-invocation line; returns the new request count. */
export function recordRequest(memDir: string, now = new Date().toISOString()): number {
  mkdirSync(memDir, { recursive: true });
  appendFileSync(join(memDir, REQUESTS_LOG), `${JSON.stringify({ ts: now })}\n`);
  return requestCount(memDir);
}

/** Total recall invocations recorded — the adherence denominator and the
 *  index `anchor` snapshots at adoption. */
export function requestCount(memDir: string): number {
  const path = join(memDir, REQUESTS_LOG);
  if (!existsSync(path)) return 0;
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter((l) => l.trim().length > 0).length;
}

/** Live store members carrying a valid `adherence` block — the lifecycle's
 *  population. Human notes and generated entries without adherence are not
 *  members: the lifecycle only bounds adopted artifacts. */
export function collectMembers(memDir: string): MemberRef[] {
  const out: MemberRef[] = [];
  for (const { rel, path } of walkMemoryFiles(memDir)) {
    const { fm, error } = readMemoryFile(path);
    if (error) continue;
    const parsed = AdherenceSchema.safeParse(fm.adherence);
    if (!parsed.success) continue;
    out.push({
      name: typeof fm.id === "string" && fm.id.trim() ? fm.id : baseName(rel),
      rel,
      path,
      adherence: parsed.data,
    });
  }
  return out;
}

function traceLine(memDir: string, entry: Record<string, unknown>): void {
  appendFileSync(join(memDir, "..", ".trace-log"), `${JSON.stringify(entry)}\n`);
}

/** Move a live member under `.archive/`, stamping the archive marker into its
 *  frontmatter (frontmatter + body ride along intact — revive restores them).
 *  cause: "graduation" | "capacity" | "manual". */
export function archiveMember(memDir: string, rel: string, cause: string, now = new Date().toISOString()): string {
  const src = join(memDir, rel);
  const dest = join(memDir, ARCHIVE_DIR, rel);
  const { fm, body, error } = readMemoryFile(src);
  if (error) throw new Error(`archiveMember: ${rel} unreadable (${error})`);
  fm.archived = { at: now, cause };
  writeMemoryFile(src, fm, body);
  mkdirSync(dirname(dest), { recursive: true });
  renameSync(src, dest);
  traceLine(memDir, { ts: now, id: fm.id ?? baseName(rel), action: "archived", cause });
  return join(ARCHIVE_DIR, rel);
}

/** Move an archived member back to its live path; `archived` marker cleared,
 *  counters preserved. Returns the restored rel path. */
export function reviveMember(memDir: string, rel: string, now = new Date().toISOString()): string {
  const src = join(memDir, ARCHIVE_DIR, rel);
  const dest = join(memDir, rel);
  if (existsSync(dest)) throw new Error(`reviveMember: ${rel} already exists in the live store`);
  const { fm, body, error } = readMemoryFile(src);
  if (error) throw new Error(`reviveMember: ${rel} unreadable (${error})`);
  delete fm.archived;
  writeMemoryFile(src, fm, body);
  mkdirSync(dirname(dest), { recursive: true });
  renameSync(src, dest);
  traceLine(memDir, { ts: now, id: fm.id ?? baseName(rel), action: "revived" });
  return rel;
}

/** Archived members under `.archive/` (same matching rules as the live walk). */
export function listArchived(memDir: string): { rel: string; path: string }[] {
  const dir = join(memDir, ARCHIVE_DIR);
  if (!existsSync(dir)) return [];
  const out: { rel: string; path: string }[] = [];
  for (const de of readdirSync(dir, { withFileTypes: true })) {
    if (de.isFile() && de.name.endsWith(".md")) {
      out.push({ rel: de.name, path: join(dir, de.name) });
    } else if (de.isDirectory() && !de.name.startsWith(".")) {
      for (const f of readdirSync(join(dir, de.name), { withFileTypes: true })) {
        if (f.isFile() && f.name.endsWith(".md")) {
          out.push({ rel: `${de.name}/${f.name}`, path: join(dir, de.name, f.name) });
        }
      }
    }
  }
  return out;
}

/** Resolve an id (frontmatter id or file basename) to a live member's rel path. */
export function findLiveMember(memDir: string, id: string): MemberRef | null {
  for (const m of collectMembers(memDir)) {
    if (m.name === id || baseName(m.rel) === id) return m;
  }
  return null;
}

/** Resolve an id to an archived rel path. */
export function findArchived(memDir: string, id: string): string | null {
  for (const { rel, path } of listArchived(memDir)) {
    const { fm, error } = readMemoryFile(path);
    if (error) continue;
    if (fm.id === id || baseName(rel) === id) return rel;
  }
  return null;
}

/** Bump one adherence counter (`view` on recall-surface, `use` via touch,
 *  `patch` on adopt revisions) for the file at `rel` — no-op for entries
 *  without a valid adherence block (not lifecycle members). */
export function bumpAdherence(memDir: string, rel: string, key: "use" | "view" | "patch"): void {
  const path = join(memDir, rel);
  const { fm, body, error } = readMemoryFile(path);
  if (error) return;
  const parsed = AdherenceSchema.safeParse(fm.adherence);
  if (!parsed.success) return;
  parsed.data[key] += 1;
  fm.adherence = parsed.data;
  writeMemoryFile(path, fm, body);
}

export interface LifecycleRun {
  requests: number;
  members: number;
  probation: number;
  archived: number;
  dry_run: boolean;
  verdicts: LifecycleVerdict[];
}

/** `gk memory lifecycle`: one lazy evaluate() pass; archive every verdict it
 *  returns (`--dry-run` reports without moving). */
export function runLifecycle(
  cwd: string,
  cfg: LifecycleConfig,
  opts: { dryRun?: boolean; now?: string } = {},
): LifecycleRun {
  const memDir = join(cwd, ".graphkit", "memory");
  const now = opts.now ?? new Date().toISOString();
  const members = collectMembers(memDir);
  const requests = requestCount(memDir);
  const verdicts = evaluate(members, requests, cfg);
  let archived = 0;
  for (const v of verdicts) {
    if (v.action !== "archive") continue;
    archived++;
    if (opts.dryRun) continue;
    const member = members.find((m) => m.name === v.name);
    if (member) archiveMember(memDir, member.rel, v.reason, now);
  }
  return {
    requests,
    members: members.length,
    probation: verdicts.filter((v) => v.reason === "probation").length,
    archived,
    dry_run: opts.dryRun === true,
    verdicts,
  };
}

/** The lifecycle block `gk memory trace` reports alongside ACT-R decay. */
export function lifecycleCounts(
  memDir: string,
  cfg: LifecycleConfig,
): { probation: number; mature: number; archived: number; graduated: number; capacity_evicted: number } {
  const counts = { probation: 0, mature: 0, archived: 0, graduated: 0, capacity_evicted: 0 };
  const requests = requestCount(memDir);
  for (const v of evaluate(collectMembers(memDir), requests, cfg)) {
    if (v.reason === "probation") counts.probation++;
    else if (v.reason === "mature" || v.action === "archive") counts.mature++;
  }
  for (const { path } of listArchived(memDir)) {
    const { fm, error } = readMemoryFile(path);
    if (error) continue;
    counts.archived++;
    const cause = (fm.archived as { cause?: string } | undefined)?.cause;
    if (cause === "graduation") counts.graduated++;
    else if (cause === "capacity") counts.capacity_evicted++;
  }
  return counts;
}
