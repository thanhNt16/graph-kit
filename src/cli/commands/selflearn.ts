import { existsSync, readdirSync } from "node:fs";
import type { CAC } from "cac";
import { GraphKitError } from "../../errors.js";
import { captureEpisode, recordEpisode, tick } from "../../selflearn/capture.js";
import { stageIntent } from "../../selflearn/intents.js";
import { promoteIntents } from "../../selflearn/promote.js";
import { reflect } from "../../selflearn/reflect.js";
import { sessionContext, skillIndex } from "../../selflearn/session_index.js";
import { episodesDir, intentsDir, resolveTarget, sweepTmpFiles } from "../../selflearn/state.js";
import { leafUsageFor, subcommandsFor } from "../command-registry.js";
import { emit, fail, ok } from "../output.js";

const HELP = `gk selflearn — self-learning pipeline (capture → reflect → stage → promote → index)\n\nUsage:\n  gk selflearn <subcommand> [args...]\n\nSubcommands:\n`;

export function registerSelflearnCommand(cli: CAC) {
  cli
    .command(
      "selflearn [subcommand] [args...]",
      `Self-learning pipeline (AutoHarness port)\nSubcommands: ${subcommandsFor("selflearn")}`,
    )
    .option("--intent <json>", "stage: intent JSON ({kind,target,reason,evidence,body|old/new})")
    .option("--session <id>", "session id (capture/tick/reflect/promote/status filter)")
    .option("--transcript <path>", "capture/reflect: host transcript file path")
    .option("--record <text>", "record: append one episode record line (repeat via multiple calls)")
    .option("--stdin", "record: read episode records from stdin")
    .option("--target <claude|omp>", "which host skill tree (default: inferred)")
    .option("--reason <text>", "stage: intent reason shortcut")
    .option("--json", "JSON output")
    .example(leafUsageFor("selflearn"))
    .action((subcommand, _args, opts) => {
      const cwd = process.cwd();
      if (!subcommand) {
        console.log(`${HELP}${leafUsageFor("selflearn")}`);
        return;
      }
      const needSession = () => {
        if (!opts.session) {
          emit(fail("MISSING_ARG", `selflearn ${subcommand} requires --session <id>`));
          return false;
        }
        return true;
      };
      const target = () => resolveTarget(cwd, opts.target ? String(opts.target) : undefined);
      try {
        if (subcommand === "stage") {
          if (!opts.intent) {
            emit(fail("MISSING_ARG", "selflearn stage requires --intent <json>"));
            return;
          }
          let raw: unknown;
          try {
            raw = JSON.parse(String(opts.intent));
          } catch (e) {
            emit(fail("SELFLEARN_INTENT", `intent is not valid JSON: ${(e as Error).message}`));
            return;
          }
          emit(ok(stageIntent(cwd, raw, opts.session ? String(opts.session) : undefined)));
          return;
        }
        if (subcommand === "promote") {
          emit(ok(promoteIntents(cwd, { target: target(), session: opts.session ? String(opts.session) : undefined })));
          return;
        }
        if (subcommand === "reflect") {
          if (!needSession()) return;
          emit(
            ok(
              reflect(cwd, {
                session: String(opts.session),
                transcript: opts.transcript ? String(opts.transcript) : undefined,
                target: target(),
              }),
            ),
          );
          return;
        }
        if (subcommand === "status") {
          const intents = intentsDir(cwd);
          const episodes = episodesDir(cwd);
          const files = existsSync(intents) ? readdirSync(intents) : [];
          emit(
            ok({
              target: target(),
              episodes: existsSync(episodes) ? readdirSync(episodes).filter((f) => f.endsWith(".jsonl")).length : 0,
              staged: files.filter((f) => f.endsWith(".json") && !f.endsWith(".rejected.json")).length,
              rejected: files.filter((f) => f.endsWith(".rejected.json")).length,
              swept: sweepTmpFiles(cwd).length,
            }),
          );
          return;
        }
        if (subcommand === "index") {
          const idx = skillIndex(cwd, target());
          emit(ok({ index: idx ?? "" }));
          if (idx) console.log(idx);
          return;
        }
        // Host-hook plumbing leaves (daemon-free: the hook shells out per event).
        if (subcommand === "context") {
          // SessionStart: last-run one-liner + grouped learned-skill index (or empty).
          emit(ok({ context: sessionContext(cwd, target()) ?? "" }));
          return;
        }
        if (subcommand === "tick") {
          if (!needSession()) return;
          emit(ok(tick(cwd, String(opts.session))));
          return;
        }
        if (subcommand === "capture") {
          if (!needSession()) return;
          if (!opts.transcript) {
            emit(fail("MISSING_ARG", "selflearn capture requires --transcript <path>"));
            return;
          }
          emit(ok(captureEpisode(cwd, String(opts.session), String(opts.transcript))));
          return;
        }
        if (subcommand === "record") {
          if (!needSession()) return;
          const records = opts.record ? [String(opts.record)] : [];
          if (!records.length) {
            emit(fail("MISSING_ARG", "selflearn record requires --record <text>"));
            return;
          }
          emit(ok({ appended: recordEpisode(cwd, String(opts.session), records) }));
          return;
        }
        emit(
          fail("UNKNOWN_SELFLEARN_SUBCOMMAND", `Unknown selflearn subcommand "${subcommand}"`, {
            subcommands: subcommandsFor("selflearn"),
          }),
        );
      } catch (e) {
        emit(
          e instanceof GraphKitError
            ? fail(e.code, e.message, e.details)
            : fail("SELFLEARN_ERROR", e instanceof Error ? e.message : String(e)),
        );
      }
    });
}
