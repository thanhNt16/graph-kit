// gk-selflearn — self-learning host integration for omp (AutoHarness port).
// Mirrors kits/claude/hooks/gk-selflearn.cjs through the pi extension events:
//   session_start  → inject the learned-skill index + last-run one-liner
//   tool_call      → per-call tick; on reflect_due notify the session to run
//                    `gk selflearn reflect`
//   agent_settled  → capture the episode + promote staged intents
// Daemon-free: each event shells out to `gk selflearn` leaves (the lint stays
// single-sourced in src/selflearn) and returns; any failure degrades to a
// logged warning — the host never blocks.

import { execFileSync } from "node:child_process";

interface MinimalPiAPI {
  on(event: "session_start" | "tool_call" | "agent_settled", handler: (ctx: PiContext) => unknown): void;
  registerTool?(tool: unknown): void;
  registerCommand?(name: string, def: unknown): void;
}

interface PiContext {
  cwd?: string;
  sessionId?: string;
  ui?: { notify?: (message: string, level?: string) => void };
}

function gk(cwd: string, args: string[]): Record<string, unknown> | null {
  try {
    const out = execFileSync("gk", ["selflearn", ...args, "--json"], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 30_000,
    });
    const env = JSON.parse(out) as { status?: string; data?: Record<string, unknown> };
    return env.status === "ok" ? (env.data ?? null) : null;
  } catch {
    return null; // degrade gracefully — `gk selflearn` leaves remain the manual fallback
  }
}

export default function gkSelflearnExtension(pi: MinimalPiAPI): void {
  const sessionOf = (ctx: PiContext) => ctx.sessionId ?? "omp";
  const cwdOf = (ctx: PiContext) => ctx.cwd ?? process.cwd();
  const notify = (ctx: PiContext, msg: string) => ctx.ui?.notify?.(msg, "info");

  pi.on("session_start", (ctx) => {
    const data = gk(cwdOf(ctx), ["context", "--target", "omp"]);
    const context = typeof data?.context === "string" ? data.context : "";
    if (context) notify(ctx, `\n${context}\n`);
  });

  pi.on("tool_call", (ctx) => {
    const data = gk(cwdOf(ctx), ["tick", "--session", sessionOf(ctx)]);
    if (data?.reflect_due) {
      notify(
        ctx,
        `[gk selflearn] Reflection cadence reached. Run \`gk selflearn reflect --session ${sessionOf(ctx)} --target omp\` to materialize the reflector bundle.`,
      );
    }
  });

  pi.on("agent_settled", (ctx) => {
    // omp streams no host-transcript file; the episode accumulates via
    // `gk selflearn record` (tool above) — settle just promotes staged intents.
    const data = gk(cwdOf(ctx), ["promote", "--session", sessionOf(ctx), "--target", "omp"]);
    if (data && (data.landed || data.rejected)) {
      notify(ctx, `gk selflearn: landed ${data.landed}, rejected ${data.rejected}`);
    }
  });
}
