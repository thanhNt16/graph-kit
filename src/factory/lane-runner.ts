/** LaneRunner — executes one lane pass for a card: worktree ensure, policy
 *  env, prompt assembly, omp dispatch (--mode json + guard extension),
 *  verdict extraction, run record. Spec §3.7. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnDispatch } from "../exec/spawn.js";
import type { FactoryConfig, LaneKey } from "./config.js";
import type { CardJournal } from "./journal.js";
import { laneEnv, policyFor } from "./policy.js";
import type { IIssueBoardProvider, IssueTask, Workspace } from "./providers/types.js";

export interface LaneOutcome {
  run_id: string;
  verdict: "MERGE" | "BLOCK";
  note?: string;
  /** Raw fenced-block JSON when present. */
  block?: Record<string, unknown>;
  /** Guard-blocked tool calls observed in the stream. */
  blocked_calls: Array<{ tool: string; reason: string }>;
  events_path?: string;
  text: string;
}

export function runsDir(cwd: string): string {
  const dir = join(cwd, ".graphkit", "factory", "runs");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export interface LaneRunRecord {
  run_id: string;
  card: string;
  lane: LaneKey;
  at: string;
  verdict: "MERGE" | "BLOCK" | null;
  note?: string;
  /** null while running — file presence is "settled" only when verdict != null
   *  or `crashed` is true. */
  crashed?: boolean;
  blocked_calls?: Array<{ tool: string; reason: string }>;
  events_path?: string;
}

export function runRecordPath(cwd: string, runId: string): string {
  return join(runsDir(cwd), `${runId}.json`);
}

export function saveRunRecord(cwd: string, rec: LaneRunRecord): void {
  writeFileSync(runRecordPath(cwd, rec.run_id), JSON.stringify(rec, null, 2));
}

export function loadRunRecord(cwd: string, runId: string): LaneRunRecord | null {
  const p = runRecordPath(cwd, runId);
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as LaneRunRecord) : null;
}

/** Extract a fenced ```gk-<name> {...}``` JSON block from agent output. */
export function extractBlock(text: string, name: string): Record<string, unknown> | null {
  const re = new RegExp(`\`\`\`gk-${name}\\s*\\n([\\s\\S]*?)\`\`\``, "m");
  const m = re.exec(text);
  if (!m) return null;
  try {
    return JSON.parse(m[1]) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Map a lane's fenced block to a MERGE/BLOCK verdict. */
export function laneVerdict(
  lane: LaneKey,
  block: Record<string, unknown> | null,
): { verdict: "MERGE" | "BLOCK"; note?: string } {
  if (!block) return { verdict: "BLOCK", note: `no gk-${lane === "ready" ? "intake" : lane} block in output` };
  switch (lane) {
    case "ready":
      return block.ambiguous === true
        ? { verdict: "BLOCK", note: `ambiguous: ${(block.questions as string[] | undefined)?.join("; ") ?? ""}` }
        : { verdict: "MERGE" };
    case "building":
      return block.blocked === true
        ? { verdict: "BLOCK", note: String(block.reason ?? "build blocked") }
        : { verdict: "MERGE" };
    case "qa":
      return block.verdict === "pass"
        ? { verdict: "MERGE" }
        : { verdict: "BLOCK", note: `qa verdict ${String(block.verdict ?? "missing")}` };
    case "review":
      return block.verdict === "approve"
        ? { verdict: "MERGE" }
        : { verdict: "BLOCK", note: `review ${String(block.verdict ?? "missing")}` };
    default:
      return { verdict: "BLOCK", note: `lane ${lane} has no verdict semantics` };
  }
}

const BLOCK_NAME: Partial<Record<LaneKey, string>> = { ready: "intake", building: "build", qa: "qa", review: "review" };

export interface LaneRunnerDeps {
  workspace: Workspace;
  board: IIssueBoardProvider;
  /** Guard extension path loaded via `-e`. */
  guardExtension: string;
  /** Agent prompt fragments: agent name → markdown. Resolved under
   *  templates/factory/agents/ by default. */
  agentFragment: (agent: string) => string;
  /** Inject for tests; defaults to spawnDispatch. */
  dispatch?: typeof spawnDispatch;
  /** Extra context injected into the prompt (intake JSON, prior failures). */
  contextFor?: (card: IssueTask, lane: LaneKey) => string;
}

const LANE_AGENTS: Partial<Record<LaneKey, string>> = {
  ready: "factory-intake",
  building: "factory-worker",
  qa: "factory-qa",
  review: "factory-reviewer",
};

/** Run one lane synchronously. Returns the outcome and mutates nothing on the
 *  board — the executor does side effects. */
export async function runLane(
  cwd: string,
  cfg: FactoryConfig,
  card: IssueTask,
  journal: CardJournal,
  lane: LaneKey,
  deps: LaneRunnerDeps,
): Promise<LaneOutcome> {
  const binding =
    lane === "ready"
      ? cfg.lanes.ready
      : lane === "building"
        ? cfg.lanes.building
        : lane === "qa"
          ? cfg.lanes.qa
          : cfg.lanes.review;
  if (!binding) throw new Error(`lane ${lane} has no binding`);
  const profile = cfg.agents[binding.agent];
  if (!profile) throw new Error(`agent ${binding.agent} not defined`);

  const { path: wtPath } = await deps.workspace.ensure(card.id, cfg.vcs.base_branch);
  const logPath = join(runsDir(cwd), `${card.id}-${lane}-guard.jsonl`);
  const policy = policyFor(cfg, card, lane, wtPath, logPath);

  const fragment = deps.agentFragment(LANE_AGENTS[lane] ?? binding.agent);
  const extra = deps.contextFor?.(card, lane) ?? "";
  const objective = [
    `Board card ${card.id} ("${card.title}").`,
    card.description ? `Card body:\n${card.description}` : "",
    extra ? `Lane context:\n${extra}` : "",
    lane === "qa" ? `qa.commands to run:\n${cfg.qa.commands.join("\n")}` : "",
    lane === "review" ? `Merge base: ${cfg.vcs.base_branch}. Run: git diff ${cfg.vcs.base_branch}...HEAD` : "",
    `Emit exactly one fenced \`\`\`gk-${BLOCK_NAME[lane] ?? lane} JSON block per your skills.`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const runId = `lane-${lane}-${card.id}-${Date.now().toString(36)}`;
  const env = laneEnv(process.env, cfg, policy);
  const dispatch = deps.dispatch ?? spawnDispatch;
  const outcome = await dispatch({
    agent: fragment,
    model: profile.model,
    objective,
    cwd: wtPath,
    child_cwd: wtPath,
    skills: profile.skills,
    thinking: profile.thinking,
    max_time: profile.max_time,
    extensions: [deps.guardExtension],
    role_prompt: "append",
    mode_json: true,
    env,
    approval_mode: profile.approval_mode,
    no_session: true,
    node: `factory-${lane}-${card.id}`,
    attempt: journal.round + 1,
  });

  const text = outcome.output ?? "";
  const block = extractBlock(text, BLOCK_NAME[lane] ?? lane);
  const { verdict, note } = laneVerdict(lane, block);
  const blockedCalls = outcome.blocked ?? [];
  const blockedNote = blockedCalls.length > 0 ? `guard blocked ${blockedCalls.length} call(s)` : undefined;
  return {
    run_id: runId,
    verdict: verdict === "BLOCK" && !note && blockedNote ? "BLOCK" : verdict,
    note: note ?? blockedNote,
    block: block ?? undefined,
    blocked_calls: blockedCalls,
    events_path: outcome.eventsPath,
    text,
  };
}
