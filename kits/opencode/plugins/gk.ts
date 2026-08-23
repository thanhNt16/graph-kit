// GraphKit plugin for OpenCode. Ports the Claude-kit hooks:
// evidence-persist, graph-state-guard, lease-enforce, memory-persist.
// State formats and file paths are byte-compatible with the Claude hooks so
// cross-run data (.graphkit/evidence/.index, .graphkit/memory/, run markers)
// stays interchangeable between hosts. All handlers fail open except the
// active-run evidence guard, which blocks like its Claude PreToolUse counterpart.

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

type ToolInput = { tool: string };
type ToolOutput = { args: Record<string, unknown> };

type ConstraintMap = Record<string, Record<string, string | number | boolean>>;

const EDIT_TOOLS = new Set(["edit", "write", "patch", "multiedit"]);

function filePathOf(args: Record<string, unknown>): string {
  const v = args.filePath ?? args.file_path ?? args.path ?? args.notebook_path ?? "";
  return typeof v === "string" ? v : "";
}

function currentRun(): { constraints?: ConstraintMap } | null {
  try {
    const runFile = ".graphkit/runs/current.json";
    if (!existsSync(runFile)) return null;
    return JSON.parse(readFileSync(runFile, "utf-8"));
  } catch {
    return null;
  }
}

export const GraphKitPlugin = async () => {
  return {
    "tool.execute.before": async (input: ToolInput, output: ToolOutput) => {
      // graph-state-guard: evidence files are workflow-owned during an active run.
      const tool = input.tool.toLowerCase();
      if (EDIT_TOOLS.has(tool)) {
        const path = filePathOf(output.args);
        if (path.includes(".graphkit/evidence/") && existsSync(".graphkit/runs/.active")) {
          throw new Error(
            "Evidence files are workflow-owned while a graph run is active. Wait for the run to finish or stop it first.",
          );
        }
      }

      // lease-enforce: OpenCode has no subagent-start event, so inject the run
      // constraints into each Task dispatch prompt instead (same content the
      // Claude SubagentStart hook returned as additionalContext).
      if (tool === "task") {
        const run = currentRun();
        if (run?.constraints && Object.keys(run.constraints).length > 0) {
          const prompt = typeof output.args.prompt === "string" ? output.args.prompt : "";
          output.args.prompt =
            `${prompt}\n\nGraphKit constraints for this node: ${JSON.stringify(run.constraints)}. ` +
            "Respect assigned_only (touch only assigned files) and no_write (read-only) if present.";
        }
      }
    },
    "tool.execute.after": async (input: ToolInput, output: ToolOutput) => {
      try {
        if (input.tool.toLowerCase() !== "write") return;
        const file = filePathOf(output.args);
        if (!file.includes(".graphkit/evidence/")) return;

        // evidence-persist: index the evidence write for gk status / gk evidence.
        const indexFile = ".graphkit/evidence/.index";
        mkdirSync(dirname(indexFile), { recursive: true });
        appendFileSync(indexFile, `${JSON.stringify({ file, at: new Date().toISOString() })}\n`);

        // memory-persist: distill the evidence write into an OKF memory file.
        // Identity = basename + sha1(source + body)[:8]; same id → idempotent skip;
        // changed source content → predecessor superseded, stable successor.
        // Additive fields: generated, recorded_at, status, sources. No .memory-dirty.
        let body = "";
        try {
          body = readFileSync(file, "utf-8");
        } catch {
          /* fail-open */
        }
        const src = basename(file, ".md");
        const id = `${src}-${createHash("sha1")
          .update(file + body)
          .digest("hex")
          .slice(0, 8)}`;
        const memDir = ".graphkit/memory";
        const memFile = join(memDir, `${id}.md`);
        mkdirSync(memDir, { recursive: true });
        if (existsSync(memFile)) return; // idempotent skip — nothing to write or supersede
        const now = new Date().toISOString();
        const frontmatter = [
          "---",
          `id: ${id}`,
          "type: knowledge",
          `source: ${file}`,
          `created_at: ${now}`,
          `valid_from: ${now}`,
          "valid_to:",
          "salience: 0.5",
          "expired: false",
          "tags: []",
          `generated: { by: "process:memory-persist", at: ${now} }`,
          `recorded_at: ${now}`,
          "status: stable",
          `sources: [{ resource: ${file} }]`,
          "---",
          "",
          body,
          "",
        ].join("\n");
        writeFileSync(memFile, frontmatter);
        appendFileSync(join(memDir, ".index"), `${JSON.stringify({ id, source: file, file: memFile, at: now })}\n`);
        // Supersede prior captures of the same evidence source with different content.
        for (const prev of readdirSync(memDir).filter((f) => f.endsWith(".md") && f !== `${id}.md`)) {
          const prevPath = join(memDir, prev);
          const raw = readFileSync(prevPath, "utf-8");
          const m = raw.match(/^---\n([\s\S]*?)\n---/);
          if (!m || !raw.includes(`source: ${file}`) || raw.includes(`id: ${id}`)) continue;
          let prevFm = m[1];
          if (!prevFm.includes("superseded_by:")) prevFm += `\nsuperseded_by: ${id}`;
          if (!prevFm.includes("status:")) prevFm += "\nstatus: deprecated";
          if (!prevFm.includes("valid_to:")) prevFm += `\nvalid_to: ${now}`;
          writeFileSync(prevPath, `---\n${prevFm}\n---\n${raw.slice(m[0].length)}`);
        }
      } catch {
        /* fail-open */
      }
    },
  };
};
