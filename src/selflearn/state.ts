// Self-learning (AutoHarness port) — shared state layout + primitives.
//
// Everything lives under `.graphkit/selflearn/` — daemon-free, lazily
// driven: host hooks and `gk selflearn` leaves are the only writers, nothing
// runs resident. Learned skills land in the host's own skill tree
// (`.claude/skills/` or `.omp/skills/`) so recall is the host's, not ours.

import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { GraphKitError } from "../errors.js";

export const SELFLEARN_DIR = ".graphkit/selflearn";
export const SELFLEARN_TARGETS = ["claude", "omp"] as const;
export type SelflearnTarget = (typeof SELFLEARN_TARGETS)[number];

/** Host skill tree a learned skill lands in. */
export const SKILLS_DIRS: Record<SelflearnTarget, string> = {
  claude: ".claude/skills",
  omp: ".omp/skills",
};

export const selflearnDir = (cwd: string) => join(cwd, SELFLEARN_DIR);
export const watermarksDir = (cwd: string) => join(selflearnDir(cwd), "watermarks");
export const episodesDir = (cwd: string) => join(selflearnDir(cwd), "episodes");
export const intentsDir = (cwd: string) => join(selflearnDir(cwd), "intents");
export const runsDir = (cwd: string) => join(selflearnDir(cwd), "runs");
export const bundlesDir = (cwd: string) => join(selflearnDir(cwd), "bundles");
export const archiveDir = (cwd: string) => join(selflearnDir(cwd), "archive");
export const lastRunPath = (cwd: string) => join(selflearnDir(cwd), "last_run.json");

export const SKILLS_MARKER = ".selflearn.json";
export const SKILL_FILE = "SKILL.md";
export const LEDGER_FILE = ".ledger.jsonl";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Session ids and skill names interpolate into filenames — restrict to a
 *  path-safe shape so a state file can never resolve outside its dir. */
export function checkSafeId(kind: string, id: string): string {
  if (typeof id !== "string" || id.length > 120 || !SAFE_ID.test(id) || id.includes("..")) {
    throw new GraphKitError("SELFLEARN_ID", `unsafe ${kind}: ${JSON.stringify(id)}`);
  }
  return id;
}

/** Which host tree to write to: explicit flag wins; else the tree that
 *  already exists; `.claude` when both or neither exist (primary target). */
export function resolveTarget(cwd: string, explicit?: string): SelflearnTarget {
  if (explicit !== undefined) {
    if (!(SELFLEARN_TARGETS as readonly string[]).includes(explicit)) {
      throw new GraphKitError("SELFLEARN_TARGET", `unknown target "${explicit}"`, {
        available: [...SELFLEARN_TARGETS],
      });
    }
    return explicit as SelflearnTarget;
  }
  if (!existsSync(join(cwd, ".claude")) && existsSync(join(cwd, ".omp"))) return "omp";
  return "claude";
}

export const skillsDirFor = (cwd: string, target: SelflearnTarget) => join(cwd, SKILLS_DIRS[target]);
export const skillDirFor = (cwd: string, target: SelflearnTarget, name: string) =>
  join(skillsDirFor(cwd, target), checkSafeId("skill name", name));
export const skillFileFor = (cwd: string, target: SelflearnTarget, name: string) =>
  join(skillDirFor(cwd, target, name), SKILL_FILE);

/** POSIX atomic write: same-dir temp + fsync + rename — a crash leaves a
 *  `.tmp` orphan (swept on drain), never a half-written target. */
export function writeTextAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, text, null, "utf-8");
    closeSync(fd);
  } catch (e) {
    try {
      closeSync(fd);
    } catch {
      /* already closed */
    }
    rmSync(tmp, { force: true });
    throw e;
  }
  renameSync(tmp, path);
}

/** Append one JSON line; one write syscall keeps the line whole for sizes we handle. */
export function appendJsonl(path: string, record: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`, "utf-8");
}

export function readJsonl(path: string): unknown[] {
  if (!existsSync(path)) return [];
  const out: unknown[] = [];
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* a torn line is evidence the last write died — skip it, keep the rest */
    }
  }
  return out;
}

// Per-session watermark: byte offset into the host transcript (CAP), the
// PreToolUse activity counter, and the sticky reflect_due flag.
export interface Watermark {
  offset: number;
  count: number;
  reflect_due: boolean;
  /** Offset the first episode window started at — digest reads history before it. */
  first_offset: number;
}

const watermarkPath = (cwd: string, session: string) =>
  join(watermarksDir(cwd), `${checkSafeId("session id", session)}.json`);

export function readWatermark(cwd: string, session: string): Watermark {
  const path = watermarkPath(cwd, session);
  if (!existsSync(path)) return { offset: 0, count: 0, reflect_due: false, first_offset: 0 };
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as Partial<Watermark>;
    return {
      offset: Math.max(0, Number(raw.offset) || 0),
      count: Math.max(0, Number(raw.count) || 0),
      reflect_due: raw.reflect_due === true,
      first_offset: Math.max(0, Number(raw.first_offset) || 0),
    };
  } catch {
    return { offset: 0, count: 0, reflect_due: false, first_offset: 0 };
  }
}

export function writeWatermark(cwd: string, session: string, wm: Watermark): void {
  writeTextAtomic(watermarkPath(cwd, session), JSON.stringify(wm, null, 2));
}

export const episodePathFor = (cwd: string, session: string) =>
  join(episodesDir(cwd), `${checkSafeId("session id", session)}.jsonl`);

/** Crash-recovery sweep: remove same-dir `.tmp` orphans under selflearn state. */
export function sweepTmpFiles(cwd: string): string[] {
  const removed: string[] = [];
  const sweep = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) sweep(p);
      else if (e.name.endsWith(".tmp")) {
        rmSync(p, { force: true });
        removed.push(p);
      }
    }
  };
  sweep(selflearnDir(cwd));
  return removed;
}
