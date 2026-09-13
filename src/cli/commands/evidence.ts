import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { CAC } from "cac";
import { loadGraph } from "../../compiler/loader.js";
import { buildViews, renderHtml, renderMarkdown } from "../../evidence/report.js";
import { addEvidence, maxBytesFromConfig } from "../../evidence/store.js";
import { safeGraphName } from "../../store/index.js";
import { subcommandHelpFor, subcommandsFor } from "../command-registry.js";
import { ok, printFail, printFailFromError } from "../output.js";

export function registerEvidenceCommand(cli: CAC) {
  cli
    .command("evidence [subcommand] [args...]", `Evidence commands\nSubcommands: ${subcommandsFor("evidence")}`)
    .example(subcommandHelpFor("evidence"))
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
          printFail("MISSING_ARG", "evidence add requires <file> and --key <k>", { json: opts.json === true });
          return;
        }
        try {
          const graph = loadGraph(join(cwd, "graph.yaml"));
          const result = addEvidence(cwd, graph, {
            // An absolute artifact path is the caller's choice, not a mistake —
            // the unconditional join used to manufacture "<cwd>/tmp/…" and then
            // report EVIDENCE_FILE_MISSING for the file it mangled.
            file: isAbsolute(String(file)) ? String(file) : join(cwd, String(file)),
            key: String(opts.key),
            node: opts.node ? String(opts.node) : undefined,
            note: opts.note ? String(opts.note) : undefined,
            maxBytes: maxBytesFromConfig(cwd),
          });
          console.log(JSON.stringify(ok(result)));
        } catch (e) {
          printFailFromError(e, "EVIDENCE_ERROR", { json: opts.json === true });
        }
        return;
      }
      if (subcommand === "report") {
        try {
          const graph = loadGraph(join(cwd, "graph.yaml"));
          const views = buildViews(cwd, graph);
          if (opts.html) {
            const outPath = join(cwd, ".graphkit", "reports", `${safeGraphName(graph.metadata.name)}-evidence.html`);
            mkdirSync(dirname(outPath), { recursive: true });
            writeFileSync(outPath, renderHtml(graph.metadata.name, views, join(cwd, graph.outputs.evidence_dir)));
            if (opts.json) {
              console.log(JSON.stringify(ok({ written: outPath, keys: views.length })));
            } else {
              console.log(`wrote ${outPath} (${views.length} key(s))`);
            }
          } else if (opts.json) {
            console.log(JSON.stringify(ok({ markdown: renderMarkdown(graph.metadata.name, views), views })));
          } else {
            // Human mode prints the report itself — the markdown IS the human
            // rendering; wrapping it in a JSON blob made it unreadable.
            console.log(renderMarkdown(graph.metadata.name, views).trimEnd());
          }
        } catch (e) {
          printFailFromError(e, "EVIDENCE_ERROR", { json: opts.json === true });
        }
        return;
      }
      printFail("UNKNOWN_EVIDENCE_SUBCOMMAND", `Unknown evidence subcommand "${subcommand}"`, {
        details: { hint: `Subcommands: ${subcommandsFor("evidence")}` },
        json: opts.json === true,
      });
    });
}
