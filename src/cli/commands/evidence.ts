import { join } from "node:path";
import type { CAC } from "cac";
import { GraphKitError } from "../../errors.js";
import { addEvidence, maxBytesFromConfig } from "../../evidence/store.js";
import { subcommandsFor } from "../command-registry.js";
import { fail, ok } from "../output.js";
import { loadGraph } from "./graph.js";

export function registerEvidenceCommand(cli: CAC) {
  cli
    .command("evidence [subcommand] [args...]", `Evidence commands\nSubcommands: ${subcommandsFor("evidence")}`)
    .option("--key <k>", "add: evidence key")
    .option("--node <n>", "add: producing node id")
    .option("--note <text>", "add: free-text provenance note")
    .option("--json", "JSON output")
    .action((subcommand, args, opts) => {
      const cwd = process.cwd();
      if (!subcommand) {
        console.log(
          `gk evidence — evidence commands\n\nUsage:\n  gk evidence <subcommand> [args...]\n\nSubcommands: ${subcommandsFor("evidence")}`,
        );
        return;
      }
      if (subcommand === "add") {
        const file = Array.isArray(args) ? args[0] : args;
        if (!file || !opts.key) {
          console.log(JSON.stringify(fail("MISSING_ARG", "evidence add requires <file> and --key <k>")));
          process.exit(1);
          return;
        }
        try {
          const graph = loadGraph(join(cwd, "graph.yaml"));
          const result = addEvidence(cwd, graph, {
            file: join(cwd, String(file)),
            key: String(opts.key),
            node: opts.node ? String(opts.node) : undefined,
            note: opts.note ? String(opts.note) : undefined,
            maxBytes: maxBytesFromConfig(cwd),
          });
          console.log(JSON.stringify(ok(result)));
        } catch (e) {
          console.log(
            JSON.stringify(
              e instanceof GraphKitError
                ? fail(e.code, e.message, e.details)
                : fail("EVIDENCE_ERROR", e instanceof Error ? e.message : String(e)),
            ),
          );
          process.exit(1);
        }
        return;
      }
      console.log(
        JSON.stringify(
          fail("UNKNOWN_EVIDENCE_SUBCOMMAND", `Unknown evidence subcommand "${subcommand}"`, {
            hint: `Subcommands: ${subcommandsFor("evidence")}`,
          }),
        ),
      );
      process.exit(1);
    });
}
