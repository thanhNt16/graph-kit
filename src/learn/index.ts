// Learned-items index (autoharness IDX pattern): a compact, grouped index of
// what `gk learn` has landed, injected into node briefs as `## Learned
// patterns` alongside the `## Progress so far` recitation — so "whether the
// library is offered" is our own config, not host behavior. Entries come from
// adopted learn proposals plus memory items stamped `adopted_by: "gk-learn"`.

import { basename, dirname, join } from "node:path";
import { readMemoryFile, walkMemoryFiles } from "../memory/store.js";
import { listProposals, readAllProposals } from "./learn.js";

const DESC_MAX = 60;

const fit = (text: string): string => {
  const flat = text.split(/\s+/).join(" ").trim();
  return flat.length <= DESC_MAX ? flat : `${flat.slice(0, DESC_MAX - 3)}...`;
};

const firstBodyLine = (body: string): string =>
  body
    .split("\n")
    .find((l) => l.trim())
    ?.trim() ?? "";

interface IndexEntry {
  name: string;
  desc: string;
  group: string;
  at: string;
}

/** The `## Learned patterns` block appended to node briefs and resume-derived
 *  objectives — null when disabled (tail <= 0) or nothing has landed yet.
 *  Newest entries first, capped at `tail`, grouped by proposal_kind /
 *  memory category. */
export function learnIndex(cwd: string, tail: number): string | null {
  if (tail <= 0) return null;
  const entries: IndexEntry[] = [];

  for (const p of readAllProposals(cwd)) {
    if (p.status !== "adopted") continue;
    const skillDir = p.adopted?.installed.find((i) => i.endsWith("SKILL.md"));
    entries.push({
      name: skillDir ? basename(dirname(skillDir)) : p.id,
      desc: fit(p.hypothesis || "(no description)"),
      group: p.proposal_kind,
      at: p.adopted?.at ?? p.created,
    });
  }

  const memDir = join(cwd, ".graphkit", "memory");
  for (const f of walkMemoryFiles(memDir)) {
    const { fm, body, error } = readMemoryFile(f.path);
    if (error) continue;
    // Only learned items the store itself marked adopted — archived, expired,
    // or superseded memory stays out of the index.
    if (fm.adopted_by !== "gk-learn") continue;
    if (fm.expired === true || fm.superseded_by != null || fm.status === "deprecated" || fm.archived === true) continue;
    entries.push({
      name: String(fm.id ?? basename(f.rel, ".md")),
      desc: fit(String(fm.description ?? "") || firstBodyLine(body) || "(no description)"),
      group: String(fm.category ?? "memory"),
      at: String(fm.adopted_at ?? fm.recorded_at ?? fm.created_at ?? ""),
    });
  }

  if (entries.length === 0) return null;
  entries.sort((a, b) => b.at.localeCompare(a.at));
  const top = entries.slice(0, tail);
  const groups = new Map<string, IndexEntry[]>();
  for (const e of top) groups.set(e.group, [...(groups.get(e.group) ?? []), e]);

  const lines = [
    "## Learned patterns",
    "Learned improvements adopted via `gk learn` — apply a line when it matches the task at hand.",
    "",
  ];
  for (const group of [...groups.keys()].sort()) {
    lines.push(`### ${group}`);
    for (const e of groups.get(group) ?? []) lines.push(`- ${e.name}: ${e.desc}`);
  }
  return lines.join("\n");
}

/** `gk run status` learn section: proposals the run produced and where they
 *  landed — null when the run has none (rejected proposals stay visible). */
export function learnRunSummary(
  cwd: string,
  runId: string,
): { proposals: number; landed: number; rejected: number } | null {
  const props = listProposals(cwd).filter((p) => p.source_run === runId);
  if (props.length === 0) return null;
  return {
    proposals: props.length,
    landed: props.filter((p) => p.status === "adopted").length,
    rejected: props.filter((p) => p.status === "rejected").length,
  };
}
