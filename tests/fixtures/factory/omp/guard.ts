import { appendFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

interface Pi {
  on(e: "tool_call", h: (ctx: unknown) => unknown): void;
}
interface Policy {
  worktree: string;
  owns: string[];
  deny_bash: string[];
  log_path: string;
}

export default function guard(pi: Pi): void {
  const raw = process.env.GK_FACTORY_POLICY;
  if (!raw) return;
  const policy = JSON.parse(raw) as Policy;
  const denies = policy.deny_bash.map((s) => new RegExp(s));
  const log = (rec: Record<string, unknown>) => {
    try {
      appendFileSync(policy.log_path, `${JSON.stringify(rec)}\n`);
    } catch {}
  };
  const inScope = (p: string): boolean => {
    const abs = resolve(policy.worktree, p);
    let real = abs;
    try {
      real = realpathSync(abs);
    } catch {}
    const rel = relative(realpathSync(policy.worktree), real);
    if (rel.startsWith("..") || isAbsolute(rel)) return false;
    if (policy.owns.length === 0) return true;
    return policy.owns.some((o) => rel === o || rel.startsWith(`${o}/`));
  };
  pi.on("tool_call", (ctx) => {
    const e = ctx as { toolName?: string; input?: Record<string, unknown> };
    log({ event: "tool_call", tool: e.toolName, input: e.input });
    if (e.toolName === "bash") {
      const cmd = String(e.input?.command ?? "");
      const hit = denies.find((d) => d.test(cmd));
      if (hit) return { block: true, reason: `gk-factory: denied by policy (${hit.source})` };
    }
    if (e.toolName === "write" || e.toolName === "edit" || e.toolName === "ast_edit") {
      const p = String(e.input?.path ?? "");
      if (!inScope(p)) return { block: true, reason: `gk-factory: write outside worktree scope` };
    }
    return undefined;
  });
}
