import { readFileSync } from "node:fs";
import type { CAC } from "cac";
import YAML from "yaml";
import { GraphKitError } from "../../errors.js";
import {
  addTask,
  claimTask,
  doneTask,
  failTask,
  listItems,
  QueueTaskInputSchema,
  queueDir,
  queueStatus,
} from "../../queue/store.js";
import { leafUsageFor, subcommandsFor } from "../command-registry.js";
import { formatZodIssues } from "../diagnostics.js";
import { emit, fail, ok } from "../output.js";

// `gk queue` — the factory's durable intake surface. `gk schedule` starts a
// whole graph on a cadence; `gk queue` intakes discrete work items. An
// orchestrator appends tasks (`add`), worker sessions pick the oldest
// dependency-ready item (`claim`), and outcomes are journaled back
// (`done`/`fail`) so dependents unblock and `status` shows blockers.
// State lives in .graphkit/queue/items/<id>.yaml — no daemon, no broker.

/** Read a task definition from a YAML file, or `-` for stdin. */
function readTaskInput(source: string): unknown {
  const raw = source === "-" ? readFileSync(0, "utf-8") : readFileSync(source, "utf-8");
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new GraphKitError("QUEUE_INVALID", `empty task definition: ${source}`, { source });
  }
  return YAML.parse(raw);
}

/** cac drops a bare `-` from positionals (mri treats it as an option token);
 *  recover `add -` / `add -- -` from the raw argv so stdin stays reachable. */
function addSourceArg(arg0: string | undefined, opts: Record<string, unknown>, cli: CAC): string | undefined {
  if (arg0 !== undefined) return arg0;
  const afterDD = opts["--"];
  if (Array.isArray(afterDD) && afterDD[0] === "-") return "-";
  const rawArgs = (cli as unknown as { rawArgs?: string[] }).rawArgs ?? [];
  return rawArgs.includes("-") ? "-" : undefined;
}

export function registerQueueCommand(cli: CAC) {
  cli
    .command("queue [subcommand] [args...]", `Task-queue commands\nSubcommands: ${subcommandsFor("queue")}`)
    .option("--node <claimer>", "claim: identity recorded on the claimed item")
    .option("--note <text>", "done/fail: free-text note recorded on the item")
    .option("--evidence <keys>", "done: comma-separated evidence keys the task satisfied")
    .option("--state <state>", "list: filter to queued|claimed|done|failed")
    .option("--json", "JSON output")
    .example(leafUsageFor("queue"))
    .action((subcommand, args, opts) => {
      const cwd = process.cwd();
      if (!subcommand) {
        console.log(
          `gk queue — task-queue commands\n\nUsage:\n  gk queue <subcommand> [args...]\n\nSubcommands:\n${leafUsageFor("queue")}\n\nOptions:\n  --node <claimer>    claim: identity recorded on the item\n  --note <text>       done/fail: free-text note\n  --evidence <keys>   done: comma-separated evidence keys\n  --state <state>     list: filter by state\n  --json              JSON output`,
        );
        return;
      }
      const arg0 = Array.isArray(args) ? args[0] : args;
      try {
        if (subcommand === "add") {
          const source = addSourceArg(arg0 !== undefined ? String(arg0) : undefined, opts, cli);
          if (!source) {
            emit(fail("MISSING_ARG", "queue add requires <file.yaml|->"));
            return;
          }
          let raw: unknown;
          try {
            raw = readTaskInput(source);
          } catch (e) {
            emit(
              fail(
                e instanceof GraphKitError ? e.code : "QUEUE_INVALID",
                `queue add could not read task definition: ${e instanceof Error ? e.message : String(e)}`,
                e instanceof GraphKitError ? e.details : { source },
              ),
            );
            return;
          }
          const parsed = QueueTaskInputSchema.safeParse(raw);
          if (!parsed.success) {
            emit(
              fail("QUEUE_INVALID", "task definition failed validation", {
                issues: formatZodIssues(parsed.error, QueueTaskInputSchema),
              }),
            );
            return;
          }
          const item = addTask(queueDir(cwd), parsed.data);
          emit(ok({ item }));
          return;
        }
        if (subcommand === "claim") {
          const claimer = opts.node !== undefined ? String(opts.node) : (process.env.USER ?? "cli");
          emit(ok({ claimed: claimTask(queueDir(cwd), claimer) }));
          return;
        }
        if (subcommand === "status") {
          emit(ok({ path: queueDir(cwd), ...queueStatus(queueDir(cwd)) }));
          return;
        }
        if (subcommand === "list") {
          const state = opts.state !== undefined ? String(opts.state) : undefined;
          if (state !== undefined && !["queued", "claimed", "done", "failed"].includes(state)) {
            emit(
              fail("BAD_STATE", `Unknown queue state "${state}"`, {
                available: ["queued", "claimed", "done", "failed"],
              }),
            );
            return;
          }
          const items = listItems(queueDir(cwd));
          emit(
            ok({ path: queueDir(cwd), items: state === undefined ? items : items.filter((i) => i.state === state) }),
          );
          return;
        }
        if (subcommand === "done") {
          if (!arg0) {
            emit(fail("MISSING_ARG", "queue done requires <id>"));
            return;
          }
          const item = doneTask(queueDir(cwd), String(arg0), {
            note: opts.note !== undefined ? String(opts.note) : undefined,
            evidence:
              opts.evidence !== undefined
                ? String(opts.evidence)
                    .split(",")
                    .map((k) => k.trim())
                    .filter((k) => k.length > 0)
                : undefined,
          });
          emit(ok({ item }));
          return;
        }
        if (subcommand === "fail") {
          if (!arg0) {
            emit(fail("MISSING_ARG", "queue fail requires <id>"));
            return;
          }
          const item = failTask(queueDir(cwd), String(arg0), {
            note: opts.note !== undefined ? String(opts.note) : undefined,
          });
          emit(ok({ item }));
          return;
        }
        emit(
          fail("UNKNOWN_QUEUE_SUBCOMMAND", `Unknown queue subcommand "${subcommand}"`, {
            hint: `Subcommands: ${subcommandsFor("queue")}`,
          }),
        );
      } catch (e) {
        emit(
          e instanceof GraphKitError
            ? fail(e.code, e.message, e.details)
            : fail("QUEUE_ERROR", e instanceof Error ? e.message : String(e)),
        );
      }
    });
}
