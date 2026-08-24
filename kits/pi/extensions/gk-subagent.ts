import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface DispatchConstraints {
  no_write?: boolean;
  tools_allowlist?: string[];
}

export interface DispatchArgs {
  agent: string;
  objective: string;
  context?: string;
  constraints?: DispatchConstraints;
  timeout_ms?: number;
}

export interface DispatchResult {
  ok: boolean;
  output: string;
  exit_code: number;
}

export function loadAgentPrompt(agent: string): string | null {
  const p = join(process.cwd(), ".omp", "agents", `${agent}.md`);
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}

export function buildPiArgs(args: DispatchArgs): string[] {
  const argv = ["-p"];
  if (args.constraints?.tools_allowlist?.length) argv.push("--tools", args.constraints.tools_allowlist.join(","));
  if (args.constraints?.no_write) argv.push("-t", "read,bash");
  return argv;
}

export function buildPrompt(args: DispatchArgs): string {
  return [`## Objective\n${args.objective}`, args.context ? `## Context\n${args.context}` : ""]
    .filter(Boolean)
    .join("\n\n");
}

export async function dispatch(args: DispatchArgs): Promise<DispatchResult> {
  const fragment = loadAgentPrompt(args.agent);
  if (!fragment) return { ok: false, output: `Unknown agent: ${args.agent}`, exit_code: 1 };
  const prompt = `${fragment}\n\n${buildPrompt(args)}`;
  const timeout = args.timeout_ms ?? 600_000;
  return new Promise((resolve) => {
    execFile("omp", [...buildPiArgs(args), prompt], { timeout, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        resolve({
          ok: false,
          output: `${stdout}\n${String(err.message ?? "")}`.trim(),
          exit_code: err.killed ? 124 : typeof err.code === "number" ? err.code : 1,
        });
      } else {
        resolve({ ok: true, output: stdout.trim(), exit_code: 0 });
      }
    });
  });
}

// Registration targets the pi extension API (registerTool + typebox schema),
// verified against badlogic/pi-mono packages/coding-agent/docs/extensions.md.
// The factory dynamically imports typebox so unit tests can import the pure
// dispatch functions above without any pi/typebox runtime present.
interface MinimalPiAPI {
  registerTool(tool: {
    name: string;
    label?: string;
    description?: string;
    parameters: unknown;
    execute: (
      toolCallId: string,
      params: DispatchArgs,
      signal: AbortSignal,
      onUpdate: unknown,
      ctx: unknown,
    ) => Promise<{ content: { type: string; text: string }[]; details?: unknown }>;
  }): void;
}

export default async function gkSubagentExtension(pi: MinimalPiAPI): Promise<void> {
  const { Type } = (await import("typebox")) as {
    Type: {
      Object: (props: Record<string, unknown>, opts?: unknown) => unknown;
      String: (opts?: unknown) => unknown;
      Optional: (schema: unknown, opts?: unknown) => unknown;
    };
  };

  pi.registerTool({
    name: "gk_dispatch_agent",
    label: "Dispatch Agent",
    description:
      "Dispatch an isolated subagent run: loads .omp/agents/<agent>.md as the role prompt, appends objective/context, and runs a headless `omp -p` child process. Returns { ok, output, exit_code }. Honor wave barriers from gk-execute: treat ok:false as graph-stopping.",
    parameters: Type.Object({
      agent: Type.String({ description: "Agent fragment name (file stem under .omp/agents/, e.g. data-engineer)" }),
      objective: Type.String({ description: "What the subagent must accomplish" }),
      context: Type.Optional(Type.String({ description: "Upstream results, refs, or extra background" })),
      constraints: Type.Optional(
        Type.Object(
          {
            no_write: Type.Optional(Type.Boolean({ description: "Restrict the child to read/bash tools" })),
            tools_allowlist: Type.Optional(
              Type.Array(Type.String(), { description: "Comma-joined into --tools for the child run" }),
            ),
          },
          { additionalProperties: false },
        ),
      ),
      timeout_ms: Type.Optional(
        Type.Number({ description: "Kill budget; on timeout returns ok:false, exit_code 124" }),
      ),
    }),
    async execute(_toolCallId, params) {
      const result = await dispatch(params);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result,
      };
    },
  });
}
