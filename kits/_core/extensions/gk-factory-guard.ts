// gk-factory-guard — omp extension enforcing the factory lane boundary.
// Loaded via `-e <path>` for every factory dispatch; reads the lane policy from
// GK_FACTORY_POLICY (JSON, written by `gk factory lane`). Absent → no-op so the
// extension is safe to load in non-factory sessions.
//
//   tool_call → { block: true, reason } for:
//     - bash commands matching policy.deny_bash (gh/glab/curl-to-provider,
//       git push, base-branch checkout, history rewrites)
//     - write/edit/ast_edit whose resolved path escapes policy.worktree or
//       policy.owns (realpath — symlink escapes count)
//   every decision appends one JSONL line to policy.log_path (the audit lane).

import { appendFileSync, existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

interface MinimalPiAPI {
  on(event: "tool_call", handler: (ctx: ToolCallCtx) => unknown): void;
}

interface ToolCallCtx {
  type?: string;
  toolCallId?: string;
  toolName?: string;
  input?: Record<string, unknown>;
}

interface FactoryPolicy {
  card: string;
  lane: string;
  worktree: string;
  branch: string;
  owns: string[];
  deny_bash: string[];
  log_path: string;
}

export default function gkFactoryGuard(pi: MinimalPiAPI): void {
  const raw = process.env.GK_FACTORY_POLICY;
  if (!raw) return; // non-factory session — inert
  let policy: FactoryPolicy;
  try {
    policy = JSON.parse(raw) as FactoryPolicy;
  } catch {
    return;
  }
  const denies = (policy.deny_bash ?? []).map((s) => new RegExp(s));
  const wt = policy.worktree;
  let wtReal = wt;
  try {
    wtReal = realpathSync(wt);
  } catch {
    /* keep logical path */
  }

  const log = (rec: Record<string, unknown>) => {
    try {
      appendFileSync(policy.log_path, `${JSON.stringify({ at: new Date().toISOString(), ...rec })}\n`);
    } catch {
      /* audit is best-effort; blocking must not fail on a full disk */
    }
  };

  const inScope = (p: string): boolean => {
    const abs = isAbsolute(p) ? p : resolve(wt, p);
    // realpath both sides — a symlink inside the worktree pointing outside is
    // an escape, not a write to the worktree.
    let real = abs;
    try {
      let probe = abs;
      while (!existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe);
      real = realpathSync(probe) + abs.slice(probe.length);
    } catch {
      real = abs;
    }
    const rel = relative(wtReal, real);
    if (rel.startsWith("..") || isAbsolute(rel)) return false;
    const owns = policy.owns ?? [];
    if (owns.length === 0) return true;
    return owns.some((o) => rel === o || rel.startsWith(o.endsWith("/") ? o : `${o}/`));
  };

  pi.on("tool_call", (ctx) => {
    const tool = ctx.toolName ?? "";
    const input = ctx.input ?? {};
    let verdict: { block: true; reason: string } | undefined;
    if (tool === "bash") {
      const cmd = String(input.command ?? "");
      const hit = denies.find((d) => d.test(cmd));
      if (hit) verdict = { block: true, reason: `gk-factory: denied by lane policy (${hit.source})` };
    } else if (tool === "write" || tool === "edit" || tool === "ast_edit") {
      const p = String(input.path ?? input.file_path ?? "");
      if (!inScope(p)) {
        verdict = { block: true, reason: `gk-factory: ${tool} outside worktree scope (${p})` };
      }
    }
    log({
      event: "tool_call",
      card: policy.card,
      lane: policy.lane,
      tool,
      input: { command: input.command, path: input.path ?? input.file_path },
      blocked: verdict !== undefined,
      ...(verdict ? { reason: verdict.reason } : {}),
    });
    return verdict;
  });
}
