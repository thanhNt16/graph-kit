import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CAC } from "cac";
import { GraphKitError } from "../../errors.js";
import { buildViews, renderHtml, renderMarkdown } from "../../evidence/report.js";
import { addEvidence, maxBytesFromConfig } from "../../evidence/store.js";
import { subcommandsFor } from "../command-registry.js";
import { emit, fail, ok } from "../output.js";
import { loadGraph } from "./graph.js";

export function registerEvidenceCommand(cli: CAC) {
  cli
    .command("evidence [subcommand] [args...]", `Evidence commands\nSubcommands: ${subcommandsFor("evidence")}`)
    .option("--key <k>", "add: evidence key")
    .option("--node <n>", "add: producing node id")
    .option("--note <text>", "add: free-text provenance note")
    .option("--html", "report: write self-contained HTML page")
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
          emit(fail("MISSING_ARG", "evidence add requires <file> and --key <k>"));
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
          emit(ok(result));
        } catch (e) {
          emit(
            e instanceof GraphKitError
              ? fail(e.code, e.message, e.details)
              : fail("EVIDENCE_ERROR", e instanceof Error ? e.message : String(e)),
          );
        }
        return;
      }
      if (subcommand === "report") {
        try {
          const graph = loadGraph(join(cwd, "graph.yaml"));
          const views = buildViews(cwd, graph);
          if (opts.html) {
            const outPath = join(cwd, ".graphkit", "reports", `${graph.metadata.name}-evidence.html`);
            mkdirSync(dirname(outPath), { recursive: true });
            writeFileSync(outPath, renderHtml(graph.metadata.name, views, join(cwd, graph.outputs.evidence_dir)));
            emit(ok({ written: outPath, keys: views.length }));
          } else {
            emit(ok({ markdown: renderMarkdown(graph.metadata.name, views), views }));
          }
        } catch (e) {
          emit(
            e instanceof GraphKitError
              ? fail(e.code, e.message, e.details)
              : fail("EVIDENCE_ERROR", e instanceof Error ? e.message : String(e)),
          );
        }
        return;
      }
      emit(
        fail("UNKNOWN_EVIDENCE_SUBCOMMAND", `Unknown evidence subcommand "${subcommand}"`, {
          hint: `Subcommands: ${subcommandsFor("evidence")}`,
        }),
      );
    });
}
