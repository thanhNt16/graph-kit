import type { CAC } from "cac";
import { GraphKitError } from "../../errors.js";
import {
  featureListPath,
  featureStatus,
  initFeatureList,
  nextFeature,
  passFeature,
  readFeatureList,
  seedFromGraph,
} from "../../features/store.js";
import type { Graph } from "../../schemas/graph.schema.js";
import { leafUsageFor, subcommandsFor } from "../command-registry.js";
import { resolveGraph } from "../graph-resolve.js";
import { emit, fail, ok } from "../output.js";

// `gk features` — the durable backlog: an initializer session seeds the list
// (every item `passes: false`), worker sessions flip one flag per pass via
// `pass <id>`, and `gk gate` BLOCKs while any item remains open when the
// graph declares `features.required: true`.

/** Resolve the feature-list path. --graph pins the graph (errors propagate);
 *  without it the resolved graph's features.path wins and an unresolvable
 *  graph falls back to the default store location — `gk features` must work
 *  on a bare project before any graph.yaml exists. */
function storePath(cwd: string, flag?: string): { path: string; graph: Graph | null } {
  if (flag) {
    const graph = resolveGraph(cwd, flag);
    return { path: featureListPath(cwd, graph), graph };
  }
  try {
    const graph = resolveGraph(cwd);
    return { path: featureListPath(cwd, graph), graph };
  } catch (e) {
    if (e instanceof GraphKitError && e.code === "NO_ACTIVE_GRAPH") {
      return { path: featureListPath(cwd, null), graph: null };
    }
    throw e;
  }
}

export function registerFeaturesCommand(cli: CAC) {
  cli
    .command("features [subcommand] [args...]", `Feature-list commands\nSubcommands: ${subcommandsFor("features")}`)
    .option("--graph <file>", "graph.yaml to resolve the features.path store location from")
    .option("--note <text>", "pass: free-text note recorded on the item")
    .option("--force", "init: overwrite an existing feature list")
    .option("--json", "JSON output")
    .example(leafUsageFor("features"))
    .action((subcommand, args, opts) => {
      const cwd = process.cwd();
      if (!subcommand) {
        console.log(
          `gk features — feature-list commands\n\nUsage:\n  gk features <subcommand> [args...]\n\nSubcommands:\n${leafUsageFor("features")}\n\nOptions:\n  --graph <file>  graph.yaml to resolve features.path from\n  --json          JSON output`,
        );
        return;
      }
      try {
        if (subcommand === "init") {
          const { path, graph } = storePath(cwd, opts.graph);
          const items = graph ? seedFromGraph(graph) : [];
          const list = initFeatureList(path, items, { force: opts.force === true });
          emit(ok({ path, seeded: items.length, list }));
          return;
        }
        if (subcommand === "list") {
          const { path } = storePath(cwd, opts.graph);
          emit(ok({ path, ...featureStatus(readFeatureList(path)), items: readFeatureList(path).items }));
          return;
        }
        if (subcommand === "next") {
          const { path } = storePath(cwd, opts.graph);
          const list = readFeatureList(path);
          emit(ok({ path, item: nextFeature(list), done: nextFeature(list) === null }));
          return;
        }
        if (subcommand === "pass") {
          const id = Array.isArray(args) ? args[0] : args;
          if (!id) {
            emit(fail("MISSING_ARG", "features pass requires <id>"));
            return;
          }
          const { path } = storePath(cwd, opts.graph);
          const { item, already_passed } = passFeature(
            path,
            String(id),
            opts.note !== undefined ? String(opts.note) : undefined,
          );
          emit(ok({ path, item, already_passed }));
          return;
        }
        if (subcommand === "status") {
          const { path } = storePath(cwd, opts.graph);
          emit(ok({ path, ...featureStatus(readFeatureList(path)) }));
          return;
        }
        emit(
          fail("UNKNOWN_FEATURES_SUBCOMMAND", `Unknown features subcommand "${subcommand}"`, {
            hint: `Subcommands: ${subcommandsFor("features")}`,
          }),
        );
      } catch (e) {
        emit(
          e instanceof GraphKitError
            ? fail(e.code, e.message, e.details)
            : fail("FEATURES_ERROR", e instanceof Error ? e.message : String(e)),
        );
      }
    });
}
