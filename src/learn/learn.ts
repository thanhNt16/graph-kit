import { execFileSync, execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import YAML from "yaml";
import { GraphKitError } from "../errors.js";
import { scoreWorkProduct } from "../eval/rubrics.js";
import { registryFileFor } from "../evidence/criteria.js";
import { listRunIds, RUN_ID_PATTERN, readRunMeta } from "../runs/ledger.js";
import { GraphSchema } from "../schemas/graph.schema.js";
import {
  type CriterionVerdict,
  type LearnProposal,
  LearnProposalSchema,
  type SourceCase,
  SourceCaseSchema,
} from "./schema.js";

/**
 * Continual learning (`gk learn`) — the second half of the promote loop.
 * `gk evidence promote` freezes a blocked run into a regression scenario;
 * learn records *why verification missed it* as an improvement proposal,
 * evaluates the proposal's criteria before adoption (`evaluate`), gates the
 * terminal transitions on that evaluation (`adopt`/`reject`), and keeps the
 * change reversible (`revert`).
 */

const learnDir = (cwd: string) => join(cwd, ".graphkit", "learn");
const proposalPath = (cwd: string, id: string) => join(learnDir(cwd), `${id}.yaml`);

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

function resolveRun(cwd: string, requested?: string): string {
  const runsDir = join(cwd, ".graphkit", "runs");
  if (requested) {
    const valid = RUN_ID_PATTERN.test(requested) && existsSync(join(runsDir, requested));
    if (!valid) throw new GraphKitError("RUN_NOT_FOUND", `no run "${requested}" under ${runsDir}`);
    return requested;
  }
  const all = listRunIds(cwd);
  if (all.length === 0)
    throw new GraphKitError("NO_RUNS", `no runs under ${runsDir} — start one with \`gk run start\``);
  return all[all.length - 1];
}

/** The promoted case.yaml for a run, if `gk evidence promote` froze one. */
function findSourceCase(cwd: string, run: string): string | null {
  const dir = join(cwd, "scenarios", "promoted");
  if (!existsSync(dir)) return null;
  const hit = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith(`${run}-`))
    .map((e) => join(dir, e.name, "case.yaml"))
    .find((p) => existsSync(p));
  return hit ? hit.slice(cwd.length + 1) : null;
}

function nextProposalId(cwd: string, run: string): string {
  const base = `learn-${run}`;
  if (!existsSync(proposalPath(cwd, base))) return base;
  let n = 2;
  while (existsSync(proposalPath(cwd, `${base}-${n}`))) n++;
  return `${base}-${n}`;
}

export function loadProposal(cwd: string, id: string): LearnProposal {
  const path = proposalPath(cwd, id);
  if (!existsSync(path)) throw new GraphKitError("LEARN_NOT_FOUND", `no learn proposal "${id}" under ${learnDir(cwd)}`);
  const parsed = LearnProposalSchema.safeParse(YAML.parse(readFileSync(path, "utf-8")));
  if (!parsed.success)
    throw new GraphKitError("LEARN_INVALID", `learn proposal "${id}" does not parse`, {
      issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    });
  return parsed.data;
}

function writeProposal(cwd: string, p: LearnProposal): string {
  mkdirSync(learnDir(cwd), { recursive: true });
  const path = proposalPath(cwd, p.id);
  writeFileSync(path, YAML.stringify(p));
  return path.slice(cwd.length + 1);
}

/** `outputs.evidence_dir` of a graph file, or null when it can't be read. */
function graphEvidenceDir(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = GraphSchema.safeParse(YAML.parse(readFileSync(path, "utf-8")));
    return parsed.success ? parsed.data.outputs.evidence_dir : null;
  } catch {
    return null;
  }
}

/**
 * The evidence dir a case's verdicts replay against: the recorded graph of the
 * source run first (the dir promote actually read), then ./graph.yaml, then
 * the schema default.
 */
function evidenceDirFor(cwd: string, proposal: LearnProposal): string {
  try {
    const meta = readRunMeta(cwd, proposal.source_run);
    const fromRun = meta.graph_path ? graphEvidenceDir(meta.graph_path) : null;
    if (fromRun) return fromRun;
  } catch {
    /* fall through to cwd graph */
  }
  return graphEvidenceDir(join(cwd, "graph.yaml")) ?? ".graphkit/evidence/";
}

/**
 * Per-criterion verdicts via the same read the evidence gate makes:
 * `<evidenceDir>/<id>.md` exists and is non-empty (scoreWorkProduct strict).
 * `root` is the tree to evaluate (repo root, or the fix worktree).
 */
function evalCriteria(root: string, evidenceDirRel: string, ids: string[]): CriterionVerdict[] {
  const evidence: Record<string, string | undefined> = {};
  for (const id of ids) {
    const p = join(root, evidenceDirRel, `${id}.md`);
    evidence[id] = existsSync(p) ? readFileSync(p, "utf-8") : undefined;
  }
  const scorecard = scoreWorkProduct({ required_keys: ids }, evidence, "strict").scorecard;
  return ids.map((id) => {
    const criterionFile = registryFileFor(root, id);
    const status = scorecard[id];
    const note =
      status !== "ok"
        ? `evidence ${status}${criterionFile ? "" : "; no criterion file under criteria/"}`
        : criterionFile
          ? undefined
          : "no criterion file under criteria/";
    return { criterion: id, pass: status === "ok", ...(note ? { note } : {}) };
  });
}

/** Apply the recorded fix inside a throwaway worktree, then hand back the
 *  worktree path (caller evaluates inside it, then removes it). */
function applyFixInWorktree(cwd: string, proposal: LearnProposal): string {
  const fix = proposal.fix;
  if (!fix) throw new GraphKitError("LEARN_FIX_FAILED", "no fix recorded on the proposal");
  const worktree = join(cwd, ".graphkit", "learn", `worktree-${slugify(proposal.id)}`);
  rmSync(worktree, { recursive: true, force: true });
  try {
    execFileSync("git", ["worktree", "add", "--detach", worktree], { cwd, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    const detail = (e as { stderr?: Buffer }).stderr?.toString().trim() ?? String(e);
    throw new GraphKitError(
      "LEARN_WORKTREE",
      `git worktree add failed — a fix can only be rehearsed inside a git repository\n${detail}`,
      { worktree },
    );
  }
  try {
    if (fix.kind === "patch") {
      const patch = isAbsolute(fix.value) ? fix.value : resolve(cwd, fix.value);
      execFileSync("git", ["apply", patch], { cwd: worktree, stdio: ["ignore", "pipe", "pipe"] });
    } else {
      execSync(fix.value, { cwd: worktree, stdio: "pipe" });
    }
  } catch (e) {
    try {
      execFileSync("git", ["worktree", "remove", "--force", worktree], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      /* leave the worktree for inspection */
    }
    const detail = (e as { stderr?: Buffer }).stderr?.toString().trim() ?? (e instanceof Error ? e.message : String(e));
    throw new GraphKitError("LEARN_FIX_FAILED", `recorded fix did not apply\n${detail}`, { fix });
  }
  return worktree;
}

function criteriaIds(sourceCase: SourceCase): string[] {
  const ids = sourceCase.failed_criteria.length > 0 ? sourceCase.failed_criteria : sourceCase.input.required_keys;
  return [...new Set(ids)].sort();
}

export interface ProposeOptions {
  run?: string;
  note?: string;
}

export interface ProposeResult {
  id: string;
  file: string;
  source_case: string | null;
  warnings: string[];
}

export function propose(cwd: string, opts: ProposeOptions): ProposeResult {
  const run = resolveRun(cwd, opts.run);
  const sourceCase = findSourceCase(cwd, run);
  const warnings: string[] = [];
  if (!sourceCase)
    warnings.push(
      `no promoted scenario found for run "${run}" under scenarios/promoted/ — drafting with source_case: null; run \`gk evidence promote --run ${run}\` first to freeze the failure`,
    );
  const id = nextProposalId(cwd, run);
  const proposal: LearnProposal = {
    id,
    created: new Date().toISOString(),
    source_run: run,
    source_case: sourceCase,
    hypothesis: opts.note ?? "",
    proposal_kind: "procedure",
    proposes: null,
    fix: null,
    status: "proposed",
    evaluation: null,
    adopted: null,
    rejected: null,
    reverted: null,
  };
  return { id, file: writeProposal(cwd, proposal), source_case: sourceCase, warnings };
}

export interface EvaluateResult {
  id: string;
  file: string;
  status: "evaluated";
  evidence_dir: string | null;
  verdicts: CriterionVerdict[];
  after_fix: CriterionVerdict[] | null;
  warnings: string[];
}

export function evaluateProposal(cwd: string, id: string): EvaluateResult {
  const proposal = loadProposal(cwd, id);
  if (proposal.status !== "proposed" && proposal.status !== "evaluated")
    throw new GraphKitError(
      "LEARN_STATE",
      `proposal "${id}" is ${proposal.status} — only proposed/evaluated proposals can be evaluated`,
      { status: proposal.status },
    );

  const warnings: string[] = [];
  let ids: string[] = [];
  let evidenceDirRel: string | null = null;
  if (proposal.source_case) {
    const casePath = join(cwd, proposal.source_case);
    if (!existsSync(casePath))
      throw new GraphKitError("LEARN_CASE_MISSING", `source case ${proposal.source_case} is gone`, {
        source_case: proposal.source_case,
      });
    const parsed = SourceCaseSchema.safeParse(YAML.parse(readFileSync(casePath, "utf-8")));
    if (!parsed.success)
      throw new GraphKitError("LEARN_INVALID", `source case ${proposal.source_case} does not parse`, {
        source_case: proposal.source_case,
      });
    const sourceCase = parsed.data;
    ids = criteriaIds(sourceCase);
    evidenceDirRel = evidenceDirFor(cwd, proposal);
    if (ids.length === 0) warnings.push("source case links no criteria — verdicts will be empty");
  } else {
    warnings.push("no source case — evaluation records an empty verdict set");
  }

  const verdicts = ids.length > 0 && evidenceDirRel ? evalCriteria(cwd, evidenceDirRel, ids) : [];

  let afterFix: CriterionVerdict[] | null = null;
  if (proposal.fix) {
    const worktree = applyFixInWorktree(cwd, proposal);
    try {
      afterFix = evidenceDirRel ? evalCriteria(worktree, evidenceDirRel, ids) : [];
    } finally {
      execFileSync("git", ["worktree", "remove", "--force", worktree], {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
      });
    }
  }

  const next: LearnProposal = {
    ...proposal,
    status: "evaluated",
    evaluation: { at: new Date().toISOString(), evidence_dir: evidenceDirRel, verdicts, after_fix: afterFix },
  };
  return {
    id,
    file: writeProposal(cwd, next),
    status: "evaluated",
    evidence_dir: evidenceDirRel,
    verdicts,
    after_fix: afterFix,
    warnings,
  };
}

/** The verdict set adopt gates on: after_fix when a fix was rehearsed, else baseline. */
function effectiveVerdicts(p: LearnProposal): CriterionVerdict[] {
  return p.evaluation?.after_fix ?? p.evaluation?.verdicts ?? [];
}

export interface AdoptResult {
  id: string;
  file: string;
  status: "adopted";
  installed: string[];
  kit_regen: string;
}

export function adoptProposal(cwd: string, id: string): AdoptResult {
  const proposal = loadProposal(cwd, id);
  if (proposal.status !== "evaluated")
    throw new GraphKitError(
      "LEARN_NOT_EVALUATED",
      `proposal "${id}" is ${proposal.status} — run \`gk learn evaluate ${id}\` first`,
      { status: proposal.status },
    );
  const failing = effectiveVerdicts(proposal).filter((v) => !v.pass);
  if (failing.length > 0)
    throw new GraphKitError("LEARN_FAILING", `proposal "${id}" still fails ${failing.length} criterion(s)`, {
      failing: failing.map((v) => v.criterion),
    });

  const installed: string[] = [];
  let kitRegen = "skipped";
  const skillPath = proposal.proposes?.skill_path;
  if (skillPath) {
    const src = isAbsolute(skillPath) ? skillPath : resolve(cwd, skillPath);
    if (!existsSync(src))
      throw new GraphKitError("LEARN_SKILL_MISSING", `proposed skill file ${skillPath} does not exist`);
    const name = basename(src) === "SKILL.md" ? basename(dirname(src)) : slugify(basename(src).replace(/\.[^.]+$/, ""));
    const dest = join(cwd, "kits", "_core", "skills", name, "SKILL.md");
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(src, dest);
    installed.push(dest.slice(cwd.length + 1));

    kitRegen = "needed";
    const genScript = join(cwd, "scripts", "gen-kits.ts");
    if (existsSync(genScript)) {
      try {
        execFileSync("bun", [genScript], { cwd, stdio: ["ignore", "pipe", "pipe"] });
        kitRegen = "ok";
      } catch (e) {
        const detail = (e as { stderr?: Buffer }).stderr?.toString().trim() ?? String(e);
        kitRegen = `failed:${detail.split("\n")[0]}`;
      }
    }
  }

  const next: LearnProposal = {
    ...proposal,
    status: "adopted",
    adopted: { at: new Date().toISOString(), installed, kit_regen: kitRegen },
  };
  return { id, file: writeProposal(cwd, next), status: "adopted", installed, kit_regen: kitRegen };
}

export function rejectProposal(
  cwd: string,
  id: string,
  reason?: string,
): { id: string; file: string; status: "rejected" } {
  const proposal = loadProposal(cwd, id);
  if (proposal.status === "adopted" || proposal.status === "rejected" || proposal.status === "reverted")
    throw new GraphKitError("LEARN_STATE", `proposal "${id}" is already ${proposal.status}`, {
      status: proposal.status,
    });
  const next: LearnProposal = {
    ...proposal,
    status: "rejected",
    rejected: { at: new Date().toISOString(), reason: reason ?? null },
  };
  return { id, file: writeProposal(cwd, next), status: "rejected" };
}

export function revertProposal(
  cwd: string,
  id: string,
): { id: string; file: string; status: "reverted"; removed: string[] } {
  const proposal = loadProposal(cwd, id);
  if (proposal.status !== "adopted")
    throw new GraphKitError(
      "LEARN_NOT_ADOPTED",
      `proposal "${id}" is ${proposal.status} — only an adopted proposal can be reverted`,
      { status: proposal.status },
    );
  const removed: string[] = [];
  for (const rel of proposal.adopted?.installed ?? []) {
    const p = join(cwd, rel);
    if (existsSync(p)) {
      rmSync(p, { force: true });
      removed.push(rel);
      // Drop the skill dir when the installed file was its only member.
      if (existsSync(dirname(p)) && readdirSync(dirname(p)).length === 0) rmSync(dirname(p), { recursive: true });
    }
  }
  const next: LearnProposal = {
    ...proposal,
    status: "reverted",
    reverted: { at: new Date().toISOString() },
  };
  return { id, file: writeProposal(cwd, next), status: "reverted", removed };
}

export interface ListedProposal {
  id: string;
  created: string;
  source_run: string;
  source_case: string | null;
  proposal_kind: string;
  status: string;
}

export function listProposals(cwd: string): ListedProposal[] {
  const dir = learnDir(cwd);
  if (!existsSync(dir)) return [];
  const out: ListedProposal[] = [];
  for (const f of readdirSync(dir)
    .filter((f) => f.endsWith(".yaml"))
    .sort()) {
    const parsed = LearnProposalSchema.safeParse(YAML.parse(readFileSync(join(dir, f), "utf-8")));
    if (!parsed.success) continue;
    const p = parsed.data;
    out.push({
      id: p.id,
      created: p.created,
      source_run: p.source_run,
      source_case: p.source_case,
      proposal_kind: p.proposal_kind,
      status: p.status,
    });
  }
  return out;
}
