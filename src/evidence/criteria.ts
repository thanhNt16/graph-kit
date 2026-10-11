import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";

export type CriterionKind = "report" | "screenshot" | "json" | "metrics" | "text";
export interface Criterion {
  id: string;
  description: string;
  kind: CriterionKind;
  holdout: boolean;
}

const KINDS: CriterionKind[] = ["report", "screenshot", "json", "metrics", "text"];

// Sealed holdout scenarios (anti-gaming): a criterion whose rubric builders
// must never see lives at `criteria/<id>.holdout.md` instead of
// `criteria/<id>.md`. Any path ending `criteria/<name>.holdout.md` is a
// sealed path; a refs entry may also seal an arbitrary path with
// `holdout: true`. Only `role: eval-gate` nodes may reference either form.
export const HOLDOUT_SUFFIX = ".holdout.md";
const HOLDOUT_PATH_RE = /(?:^|[/\\])criteria[/\\][^/\\]+\.holdout\.md$/;

/** True when a ref path matches the `criteria/<id>.holdout.md` convention. */
export function isHoldoutPath(path: string): boolean {
  return HOLDOUT_PATH_RE.test(path);
}

/** True when a refs entry is sealed — explicit flag or holdout filename. */
export function isHoldoutRef(ref: { path: string; holdout?: boolean }): boolean {
  return ref.holdout === true || isHoldoutPath(ref.path);
}

/** The refs a node may see in its dispatch payload: eval-gate nodes see all
 * refs; every other node (builders) has sealed entries stripped. */
export function visibleRefs<T extends { path: string; holdout?: boolean }>(role: string | undefined, refs: T[]): T[] {
  if (role === "eval-gate") return refs;
  return refs.filter((r) => !isHoldoutRef(r));
}

/**
 * Resolve a criterion id to its registry file. `criteria/<id>.md` wins; the
 * sealed twin `criteria/<id>.holdout.md` answers when no public file exists.
 */
export function registryFileFor(cwd: string, id: string): { path: string; holdout: boolean } | null {
  const pub = join(cwd, "criteria", `${id}.md`);
  if (existsSync(pub)) return { path: pub, holdout: false };
  const sealed = join(cwd, "criteria", `${id}${HOLDOUT_SUFFIX}`);
  if (existsSync(sealed)) return { path: sealed, holdout: true };
  return null;
}

/** True when criterion `<id>`'s registry file is the sealed variant. */
export function isHoldoutCriterion(cwd: string, id: string): boolean {
  return registryFileFor(cwd, id)?.holdout === true;
}

/**
 * Load criterion registry entries by id from `criteria/<id>.md` (or the sealed
 * `criteria/<id>.holdout.md` twin; frontmatter `kind`, optional frontmatter
 * `id`, body = description). Never throws — `gk validate`'s `criteria-file`
 * check is the layer that reports missing/unreadable files.
 */
export function loadCriteria(cwd: string, ids: string[]): Map<string, Criterion> {
  const out = new Map<string, Criterion>();
  for (const id of ids) {
    const file = registryFileFor(cwd, id);
    if (!file) {
      out.set(id, { id, description: "", kind: "report", holdout: false });
      continue;
    }
    let fm: Record<string, unknown> = {};
    let body = readFileSync(file.path, "utf-8");
    const m = body.match(/^---\n([\s\S]*?)\n---\n?/);
    if (m) {
      try {
        fm = (YAML.parse(m[1]) ?? {}) as Record<string, unknown>;
      } catch {
        fm = {};
      }
      body = body.slice(m[0].length);
    }
    const kind = KINDS.includes(fm.kind as CriterionKind) ? (fm.kind as CriterionKind) : "report";
    out.set(id, { id, description: body.trim(), kind, holdout: file.holdout });
  }
  return out;
}
