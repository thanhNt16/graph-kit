// src/memory/consolidate.ts
// The free layer: turn the run ledger into patterns, suggestions, links, and an
// index. Pure filesystem + counting; the dream graph consumes this output rather
// than re-deriving it, which is what keeps the dream prompt cheap.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { PatternFileSchema, SuggestionFileSchema } from "../schemas/memory.schema.js";
import { listRunIds, readAdvisorEvents, readRunIndex, readTrace, type AdvisorEvent, type TraceLine } from "./ledger.js";
import { buildLinks, writeLinks } from "./links.js";
import { extractPatterns, type Pattern } from "./patterns.js";

export interface ConsolidateResult {
  runs: number;
  patterns: number;
  suggestions: number;
  links: number;
  pruned: number;
}

export interface SuggestionDraft {
  id: string;
  action: "materialize-template" | "capture-skill" | "review-failure";
  rationale: string;
  based_on: string[];
  salience: number;
}

const GENERATOR = "process:gk-memory-consolidate";
const INDEX_MAX_LINES = 200; // Claude Code's cap: an index nobody can read is not an index

/** One suggestion per pattern that implies an action. Deterministic, no model. */
export function suggestionsFor(patterns: Pattern[]): SuggestionDraft[] {
  const out: SuggestionDraft[] = [];
  for (const p of patterns) {
    const based = [`pattern-${p.signature}`];
    const id = `suggestion-${createHash("sha1").update(`${p.kind}:${p.signature}`).digest("hex").slice(0, 8)}`;
    if (p.kind === "graph-reuse") {
      out.push({
        id,
        action: "materialize-template",
        rationale: `Graph "${p.label}" ran ${p.count} times unchanged. Package it: \`gk template pack\`, then materialize instead of re-authoring.`,
        based_on: based,
        salience: p.salience,
      });
    } else if (p.kind === "node-sequence" && p.members.length >= 3) {
      out.push({
        id,
        action: "capture-skill",
        rationale: `The chain "${p.label}" recurred across ${p.runs.length} runs. Capture it as a skill or a template sub-graph.`,
        based_on: based,
        salience: p.salience,
      });
    } else if (p.kind === "failure-recurrence") {
      out.push({
        id,
        action: "review-failure",
        rationale: `Node "${p.label}" failed ${p.count} times across ${p.runs.length} runs. Fix the node objective or its agent binding.`,
        based_on: based,
        salience: p.salience,
      });
    } else if (p.kind === "advisor-repeat") {
      out.push({
        id,
        action: "review-failure",
        rationale: `raise ${p.members[0]} model tier or loosen its stop_when — it needed advisor help in ${p.runs.length} runs`,
        based_on: based,
        salience: p.salience,
      });
    }
  }
  return out;
}

function writeEntry(dir: string, file: string, frontmatter: Record<string, unknown>, body: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), `---\n${YAML.stringify(frontmatter)}---\n${body}`);
}

/** Delete generated files in `dir` whose basename is not in `keep`. Hand-written
 *  files (no `generated.by` of ours) are never touched. */
function prune(dir: string, keep: Set<string>): number {
  if (!existsSync(dir)) return 0;
  let pruned = 0;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".md") || keep.has(f)) continue;
    const raw = readFileSync(join(dir, f), "utf-8");
    if (!raw.includes(GENERATOR)) continue;
    rmSync(join(dir, f));
    pruned += 1;
  }
  return pruned;
}

export function consolidate(cwd: string, now = new Date().toISOString()): ConsolidateResult {
  const memDir = join(cwd, ".graphkit", "memory");
  mkdirSync(memDir, { recursive: true });

  const runs = readRunIndex(cwd);
  if (runs.length === 0) return { runs: 0, patterns: 0, suggestions: 0, links: 0, pruned: 0 };

  const traces = new Map<string, TraceLine[]>();
  const advisors = new Map<string, AdvisorEvent[]>();
  for (const id of listRunIds(cwd)) {
    traces.set(id, readTrace(cwd, id));
    advisors.set(id, readAdvisorEvents(cwd, id));
  }

  const patterns = extractPatterns(runs, traces, advisors, now);
  const patternsDir = join(memDir, "patterns");
  const keptPatterns = new Set<string>();
  for (const p of patterns) {
    const file = `${p.signature}.md`;
    keptPatterns.add(file);
    const frontmatter = {
      id: `pattern-${p.signature}`,
      type: "pattern",
      kind: p.kind,
      label: p.label,
      members: p.members,
      runs: p.runs,
      count: p.count,
      last_seen: p.last_seen,
      signature: p.signature,
      created_at: now,
      valid_from: now,
      salience: Number(p.salience.toFixed(4)),
      expired: false,
      tags: [p.kind],
      generated: { by: GENERATOR, at: now },
      recorded_at: now,
      status: "stable",
    };
    // Invariant guard: generated entries must satisfy the published schemas (fail loud on drift).
    const parsed = PatternFileSchema.safeParse(frontmatter);
    if (!parsed.success)
      throw new Error(
        `consolidate: ${file} violates PatternFileSchema: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
      );
    writeEntry(
      patternsDir,
      file,
      frontmatter,
      `${p.label}\n\nObserved in ${p.runs.length} run(s): ${p.runs.join(", ")}.\n`,
    );
  }

  const drafts = suggestionsFor(patterns);
  const suggestionsDir = join(memDir, "suggestions");
  const keptSuggestions = new Set<string>();
  for (const s of drafts) {
    const file = `${s.id}.md`;
    keptSuggestions.add(file);
    // Preserve a human's dismissal across re-consolidation.
    const existingPath = join(suggestionsDir, file);
    let status = "proposed";
    if (existsSync(existingPath)) {
      const prior = readFileSync(existingPath, "utf-8").match(/^status:\s*(\w+)$/m)?.[1];
      if (prior === "dismissed" || prior === "accepted") status = prior;
    }
    const frontmatter = {
      id: s.id,
      type: "suggestion",
      action: s.action,
      rationale: s.rationale,
      based_on: s.based_on,
      status,
      created_at: now,
      valid_from: now,
      salience: Number(s.salience.toFixed(4)),
      expired: false,
      tags: [s.action],
      generated: { by: GENERATOR, at: now },
      recorded_at: now,
    };
    // Invariant guard: generated entries must satisfy the published schemas (fail loud on drift).
    const parsed = SuggestionFileSchema.safeParse(frontmatter);
    if (!parsed.success)
      throw new Error(
        `consolidate: ${file} violates SuggestionFileSchema: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
      );
    writeEntry(suggestionsDir, file, frontmatter, `${s.rationale}\n`);
  }

  const pruned = prune(patternsDir, keptPatterns) + prune(suggestionsDir, keptSuggestions);

  const linkGraph = buildLinks(memDir, now);
  writeLinks(memDir, linkGraph);

  const topPatterns = patterns.slice(0, 20);
  const indexLines = [
    "# Memory Index",
    "",
    `Generated ${now} by ${GENERATOR}. Regenerate with \`gk memory consolidate\`.`,
    "",
    `- runs: ${runs.length}`,
    `- patterns: ${patterns.length}`,
    `- suggestions: ${drafts.length}`,
    `- linked entries: ${Object.keys(linkGraph.links).length}`,
    "",
    "## Top patterns",
    "",
    ...topPatterns.map((p) => `- \`${p.signature}\` (${p.kind}, ×${p.count}) ${p.label}`),
    "",
    "## Open suggestions",
    "",
    ...drafts.slice(0, 20).map((s) => `- ${s.action}: ${s.rationale}`),
    "",
  ].slice(0, INDEX_MAX_LINES);
  writeFileSync(join(memDir, "index.md"), `${indexLines.join("\n")}\n`);

  return {
    runs: runs.length,
    patterns: patterns.length,
    suggestions: drafts.length,
    links: Object.keys(linkGraph.links).length,
    pruned,
  };
}
