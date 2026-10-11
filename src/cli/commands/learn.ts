import type { CAC } from "cac";
import { GraphKitError } from "../../errors.js";
import {
  adoptProposal,
  evaluateProposal,
  listProposals,
  propose,
  rejectProposal,
  revertProposal,
  verdictSummary,
} from "../../learn/learn.js";
import { leafUsageFor, subcommandsFor } from "../command-registry.js";
import { emit, fail, ok } from "../output.js";

export function registerLearnCommand(cli: CAC) {
  cli
    .command("learn [subcommand] [args...]", `Continual-learning proposals\nSubcommands: ${subcommandsFor("learn")}`)
    .option("--run <id>", "propose: source run id (default: latest run)")
    .option("--note <text>", "propose: hypothesis text; reject: reason alias")
    .option("--reason <text>", "reject: why the proposal is rejected")
    .option("--json", "JSON output")
    .example(leafUsageFor("learn"))
    .action((subcommand, args, opts) => {
      const cwd = process.cwd();
      if (!subcommand) {
        console.log(
          `gk learn — continual-learning proposals\n\nUsage:\n  gk learn <subcommand> [args...]\n\nSubcommands:\n${leafUsageFor("learn")}`,
        );
        return;
      }
      const id = Array.isArray(args) ? args[0] : args;
      const needId = () => {
        if (!id) {
          emit(fail("MISSING_ARG", `learn ${subcommand} requires <id>`));
          return false;
        }
        return true;
      };
      try {
        if (subcommand === "propose") {
          emit(
            ok(
              propose(cwd, {
                run: opts.run ? String(opts.run) : undefined,
                note: opts.note ? String(opts.note) : undefined,
              }),
            ),
          );
          return;
        }
        if (subcommand === "evaluate") {
          if (!needId()) return;
          emit(ok(evaluateProposal(cwd, String(id))));
          return;
        }
        if (subcommand === "adopt") {
          if (!needId()) return;
          emit(ok(adoptProposal(cwd, String(id))));
          return;
        }
        if (subcommand === "reject") {
          if (!needId()) return;
          const reason = opts.reason ?? opts.note;
          emit(ok(rejectProposal(cwd, String(id), reason ? String(reason) : undefined)));
          return;
        }
        if (subcommand === "revert") {
          if (!needId()) return;
          emit(ok(revertProposal(cwd, String(id))));
          return;
        }
        if (subcommand === "list") {
          emit(ok({ proposals: listProposals(cwd), summary: verdictSummary(cwd) }));
          return;
        }
        emit(
          fail("UNKNOWN_LEARN_SUBCOMMAND", `Unknown learn subcommand "${subcommand}"`, {
            hint: `Subcommands: ${subcommandsFor("learn")}`,
          }),
        );
      } catch (e) {
        emit(
          e instanceof GraphKitError
            ? fail(e.code, e.message, e.details)
            : fail("LEARN_ERROR", e instanceof Error ? e.message : String(e)),
        );
      }
    });
}
