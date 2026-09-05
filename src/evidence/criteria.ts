import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";

export type CriterionKind = "report" | "screenshot" | "json" | "metrics" | "text";
export interface Criterion {
  id: string;
  description: string;
  kind: CriterionKind;
}

const KINDS: CriterionKind[] = ["report", "screenshot", "json", "metrics", "text"];

/**
 * Load criterion registry entries by id from `criteria/<id>.md` (frontmatter `kind`,
 * optional frontmatter `id`, body = description). Never throws — `gk validate`'s
 * `criteria-file` check is the layer that reports missing/unreadable files.
 */
export function loadCriteria(cwd: string, ids: string[]): Map<string, Criterion> {
  const out = new Map<string, Criterion>();
  for (const id of ids) {
    const p = join(cwd, "criteria", `${id}.md`);
    if (!existsSync(p)) {
      out.set(id, { id, description: "", kind: "report" });
      continue;
    }
    let fm: Record<string, unknown> = {};
    let body = readFileSync(p, "utf-8");
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
    out.set(id, { id, description: body.trim(), kind });
  }
  return out;
}
