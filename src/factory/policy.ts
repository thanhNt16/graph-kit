/** Per-lane enforcement material: the LanePolicy JSON handed to
 *  gk-factory-guard.ts via GK_FACTORY_POLICY, and the credential-scrubbed
 *  child environment (laneEnv). Spec §3.4/§5. */
import type { FactoryConfig, LaneKey } from "./config.js";

export interface LanePolicy {
  card: string;
  lane: LaneKey;
  /** Absolute worktree path — all writes must resolve inside it. */
  worktree: string;
  /** Branch the lane owns; pushes/checkout of anything else are denied. */
  branch: string;
  /** Declared write scope (path globs relative to worktree); empty = whole tree. */
  owns: string[];
  /** Regex sources — a bash command matching any is blocked. */
  deny_bash: string[];
  /** JSONL audit sink the guard appends to. */
  log_path: string;
}

/** Provider-side / history-mutating operations workers may never run — the
 *  dispatcher owns all of them (spec §3.4). */
export const DEFAULT_DENY_BASH: string[] = [
  String.raw`gh\s+pr\s+(merge|close|ready|review|checkout|edit|comment|create)`,
  String.raw`gh\s+(issue|release|api|auth|repo)\b`,
  String.raw`glab\b`,
  String.raw`git\s+push`,
  String.raw`git\s+checkout\s+(-b\s+)?(main|master)\b`,
  String.raw`git\s+(reset|rebase|merge|commit)\s+.*(--amend|--hard|origin/)`,
  String.raw`git\s+worktree\s+(remove|prune)`,
  String.raw`curl\b.*api\.(github|gitlab)\.com`,
  String.raw`curl\b.*api\.atlassian\.net`,
  String.raw`curl\b.*api\.bitbucket\.org`,
];

/** Env names that must never reach a lane child (unless explicitly listed in
 *  dispatch.env_passthrough — e.g. a model API key the profile needs). */
const SECRETY =
  /(^|_)(TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIALS)(_|$)|^SSH_AUTH_SOCK$|^AWS_SESSION_TOKEN$/;

/** Names a child always needs. */
const BASE_ENV = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "TERM",
  "TMPDIR",
  "SHELL",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
];

export function policyFor(
  cfg: FactoryConfig,
  card: { id: string },
  lane: LaneKey,
  worktree: string,
  logPath: string,
  owns: string[] = [],
): LanePolicy {
  return {
    card: card.id,
    lane,
    worktree,
    branch: `${cfg.vcs.branch_prefix}${card.id}`,
    owns,
    deny_bash: DEFAULT_DENY_BASH,
    log_path: logPath,
  };
}

/** Scrubbed child env: base names + non-secrety extras + explicit
 *  passthrough. GIT_TERMINAL_PROMPT=0 makes credential prompts fail fast
 *  instead of hanging; GK_FACTORY_POLICY carries the guard contract. */
export function laneEnv(parent: NodeJS.ProcessEnv, cfg: FactoryConfig, policy: LanePolicy): Record<string, string> {
  const passthrough = new Set(cfg.dispatch.env_passthrough);
  const out: Record<string, string> = {};
  for (const name of BASE_ENV) {
    if (parent[name] !== undefined) out[name] = parent[name];
  }
  for (const [k, v] of Object.entries(parent)) {
    if (k in out || v === undefined) continue;
    if (SECRETY.test(k) && !passthrough.has(k)) continue;
    if (k.startsWith("GK_") || k.startsWith("OMP_") || k.startsWith("PI_")) continue;
    out[k] = v;
  }
  for (const name of passthrough) {
    if (parent[name] !== undefined) out[name] = parent[name];
  }
  out.GIT_TERMINAL_PROMPT = "0";
  out.GK_FACTORY_POLICY = JSON.stringify(policy);
  return out;
}
