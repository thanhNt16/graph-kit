import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CAC } from "cac";
import { GraphKitError } from "../../errors.js";
import { parseMarker, renderMarker } from "../../evidence/marker.js";
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
      if (subcommand === "invalidate") {
        if (!opts.key) {
          emit(fail("MISSING_ARG", "evidence invalidate requires --key <k>"));
          return;
        }
        try {
          const graph = loadGraph(join(cwd, "graph.yaml"));
          const p = join(cwd, graph.outputs.evidence_dir, `${opts.key}.md`);
          if (!existsSync(p)) {
            emit(fail("EVIDENCE_KEY_MISSING", `no evidence file for key "${opts.key}"`));
            return;
          }
          const content = readFileSync(p, "utf-8");
          const meta = parseMarker(content) ?? {
            key: String(opts.key),
            run_id: null,
            node: null,
            fingerprint_head: null,
            fingerprint_tree: null,
            artifact: null,
            artifact_sha256: null,
            bytes: null,
            ts: null,
            note: null,
            superseded: null,
          };
          const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n*/, "");
          writeFileSync(
            p,
            renderMarker(
              { ...meta, superseded: opts.note ? String(opts.note) : `invalidated ${new Date().toISOString()}` },
              body,
            ),
          );
          emit(ok({ key: opts.key, superseded: true }));
        } catch (e) {
          emit(fail("EVIDENCE_ERROR", e instanceof Error ? e.message : String(e)));
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
