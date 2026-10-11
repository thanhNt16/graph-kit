import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { CAC } from "cac";
import { emitSchedule, SCHEDULE_FORMATS, type ScheduleFormat } from "../../compiler/schedule.js";
import { GraphKitError } from "../../errors.js";
import type { Graph, Schedule } from "../../schemas/graph.schema.js";
import { leafUsageFor, subcommandsFor } from "../command-registry.js";
import { resolveGraphPath } from "../graph-resolve.js";
import { emit, fail, ok } from "../output.js";
import { loadGraph } from "./graph.js";

/**
 * `gk schedule` — the automation heartbeat surface. gk has no daemon; these
 * verbs read the graph's declared `schedule:` block and emit the
 * platform-native artifact a real scheduler (crond, GitHub Actions, launchd,
 * Claude Code /loop) executes on that cadence.
 */

function requireSchedule(graph: Graph): Schedule | null {
  return graph.schedule ?? null;
}

const NO_SCHEDULE = (path: string) =>
  fail("SCHEDULE_NOT_DECLARED", `SCHEDULE_NOT_DECLARED: ${path} declares no \`schedule:\` block`, {
    path,
    hint: 'add `schedule: { cron: "<5-field cron>" }` to the graph — see docs/scheduling.md',
  });

export function registerScheduleCommands(cli: CAC) {
  cli
    .command("schedule [subcommand] [args...]", `Schedule commands\nSubcommands: ${subcommandsFor("schedule")}`)
    .option("--json", "JSON output")
    .option("--format <format>", `emit target: ${SCHEDULE_FORMATS.join(" | ")}`)
    .option("--out <path>", "emit: write the artifact to this file instead of stdout")
    .example(leafUsageFor("schedule"))
    .action((subcommand: string | undefined, args: string | string[] | undefined, opts) => {
      if (!subcommand) {
        console.log(
          `gk schedule — automation heartbeat commands\n\nUsage:\n  gk schedule <subcommand> [args...]\n\nSubcommands:\n${leafUsageFor("schedule")}\n\nOptions:\n  --json            JSON output\n  --format <format> emit target: ${SCHEDULE_FORMATS.join(" | ")}\n  --out <path>      emit: write the artifact to this file instead of stdout`,
        );
        return;
      }
      const file = Array.isArray(args) ? args[0] : args;
      try {
        if (subcommand === "list") {
          const resolved = resolveGraphPath(process.cwd(), file);
          const graph = loadGraph(resolved.path);
          const schedule = requireSchedule(graph);
          if (!schedule) {
            emit(NO_SCHEDULE(resolved.path));
            return;
          }
          if (opts.json) {
            emit(ok({ path: resolved.path, schedule }));
          } else {
            console.log(
              [
                `schedule: ${schedule.cron}`,
                `command:  ${schedule.command}  (gk ${schedule.command === "run" ? `run start --graph ${resolved.path}` : `exec ${resolved.path}`})`,
                ...(schedule.description ? [`about:    ${schedule.description}`] : []),
              ].join("\n"),
            );
          }
          return;
        }
        if (subcommand === "emit") {
          if (!file) {
            emit(fail("MISSING_ARG", "schedule emit requires a graph file (or session graph id)"));
            return;
          }
          const format = String(opts.format ?? "");
          if (!format) {
            emit(fail("MISSING_ARG", `schedule emit requires --format (${SCHEDULE_FORMATS.join(" | ")})`));
            return;
          }
          if (!SCHEDULE_FORMATS.includes(format as ScheduleFormat)) {
            emit(fail("BAD_FORMAT", `Unknown schedule format "${format}"`, { available: [...SCHEDULE_FORMATS] }));
            return;
          }
          const resolved = resolveGraphPath(process.cwd(), file);
          const graph = loadGraph(resolved.path);
          const schedule = requireSchedule(graph);
          if (!schedule) {
            emit(NO_SCHEDULE(resolved.path));
            return;
          }
          const artifact = emitSchedule(
            schedule,
            format as ScheduleFormat,
            resolved.path,
            graph.metadata?.name ?? "graph",
          );
          if (opts.out) {
            const outPath = resolve(process.cwd(), String(opts.out));
            mkdirSync(dirname(outPath), { recursive: true });
            writeFileSync(outPath, artifact);
            emit(ok({ written: outPath, format }));
            return;
          }
          if (opts.json) {
            emit(ok({ format, artifact }));
            return;
          }
          // Raw artifact on stdout — ready to redirect into its commit path
          // (.github/workflows/, a plist, a crontab fragment).
          process.stdout.write(artifact);
          return;
        }
        emit(
          fail(
            "UNKNOWN_SCHEDULE_SUBCOMMAND",
            `Unknown subcommand "${subcommand}". Available: ${subcommandsFor("schedule")}`,
          ),
        );
      } catch (e) {
        emit(e instanceof GraphKitError ? fail(e.code, e.message, e.details) : fail("SCHEDULE_ERROR", String(e)));
      }
    });
}
