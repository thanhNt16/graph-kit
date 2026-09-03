import { join } from "node:path";
import type { CAC } from "cac";
import { activeRun, appendNode, endRun, startRun } from "../../memory/ledger.js";
import { subcommandsFor } from "../command-registry.js";
import { fail, ok } from "../output.js";

function errCode(e: unknown): { code: string; message: string } {
  const message = String((e as Error)?.message ?? e);
  const code = message.match(/^([A-Z_]+):/)?.[1] ?? "RUN_ERROR";
  return { code, message };
}

export function registerRunCommands(cli: CAC) {
  cli
    .command("run [subcommand] [args...]", `Run ledger commands\nSubcommands: ${subcommandsFor("run")}`)
    .option("--graph <path>", "graph.yaml path (default: ./graph.yaml)")
    .option("--status <status>", "node: ok|fail — end: merged|blocked|failed")
    .option("--wave <n>", "wave index")
    .option("--agent <agent>", "agent id")
    .option("--model <model>", "model tier")
    .option("--evidence <keys>", "comma-separated evidence keys")
    .option("--duration-ms <n>", "node duration in ms")
    .option("--notes <text>", "free-text note")
    .option("--json", "JSON output")
    .action((subcommand, args, opts) => {
      const cwd = process.cwd();
      if (!subcommand) {
        console.log(
          `gk run — run ledger commands\n\nUsage:\n  gk run <subcommand> [args...]\n\nSubcommands: ${subcommandsFor("run")}`,
        );
        return;
      }
      try {
        if (subcommand === "start") {
          console.log(JSON.stringify(ok(startRun(cwd, opts.graph ?? join(cwd, "graph.yaml")))));
          return;
        }
        if (subcommand === "node") {
          const node = Array.isArray(args) ? args[0] : args;
          if (!node) {
            console.log(JSON.stringify(fail("MISSING_ARG", "node requires a node id")));
            return;
          }
          if (opts.status !== "ok" && opts.status !== "fail") {
            console.log(JSON.stringify(fail("BAD_STATUS", "node requires --status ok|fail")));
            return;
          }
          const result = appendNode(cwd, {
            node: String(node),
            wave: opts.wave == null ? null : Number(opts.wave),
            agent: opts.agent ?? null,
            model: opts.model ?? null,
            status: opts.status,
            evidence: opts.evidence ? String(opts.evidence).split(",").map((s) => s.trim()).filter(Boolean) : [],
            duration_ms: opts.durationMs == null ? null : Number(opts.durationMs),
            notes: opts.notes ?? null,
          });
          console.log(JSON.stringify(ok(result)));
          return;
        }
        if (subcommand === "end") {
          const status = opts.status ?? "merged";
          if (!["merged", "blocked", "failed"].includes(status)) {
            console.log(JSON.stringify(fail("BAD_STATUS", "end requires --status merged|blocked|failed")));
            return;
          }
          console.log(JSON.stringify(ok(endRun(cwd, status))));
          return;
        }
        if (subcommand === "status") {
          console.log(JSON.stringify(ok({ active: activeRun(cwd) })));
          return;
        }
        console.log(
          JSON.stringify(
            fail("UNKNOWN_RUN_SUBCOMMAND", `Unknown run subcommand "${subcommand}"`, {
              available: subcommandsFor("run").split(" "),
            }),
          ),
        );
      } catch (e) {
        const { code, message } = errCode(e);
        console.log(JSON.stringify(fail(code, message)));
      }
    });
}
