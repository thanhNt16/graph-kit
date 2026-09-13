import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { splitFrontmatter } from "../frontmatter.js";

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
    // Shared CRLF-tolerant split (the same one validate.ts uses for these
    // files): the private /^---\n/ regex here used to silently miss on a
    // Windows-checkout file — kind degraded to "report" and the raw
    // frontmatter leaked into the rendered description.
    const split = splitFrontmatter(body);
    if (split) {
      try {
        fm = (YAML.parse(split.fmText) ?? {}) as Record<string, unknown>;
      } catch {
        fm = {};
      }
      body = split.body;
    }
    const kind = KINDS.includes(fm.kind as CriterionKind) ? (fm.kind as CriterionKind) : "report";
    out.set(id, { id, description: body.trim(), kind });
  }
  return out;
}
