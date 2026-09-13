// `gk graph` command registration: validate + compile as first-class commands,
// and the `graph` group dispatched through a route table keyed by subcommand
// (the 13-branch else-if chain this package replaces). Route keys are asserted
// against the registry by tests/unit/graph-subcommand-regression.test.ts.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CAC } from "cac";
import { getIndexProjectFn, withCbmClient } from "../../../cbm/seam.js";
import { compileGraph } from "../../../compiler/emitter.js";
import { loadGraph, resolveBareValidateGraph } from "../../../compiler/loader.js";
import { validateGraph } from "../../../compiler/validate.js";
import { planExecutionWaves } from "../../../compiler/waves.js";
import { safeGraphName } from "../../../store/index.js";
import { subcommandHelpFor, subcommandsFor } from "../../command-registry.js";
import { fail, ok, printFail, printFailFromError, renderFindings } from "../../output.js";
import { templatesDir } from "../kit.js";
import { printCbmFailure, printQueryTemplates, runCbmAction, runQueryTemplate } from "./cbm.js";
import { cmdInspect, cmdList, cmdNew, cmdShow, cmdSwitch, type GraphOpts } from "./lifecycle.js";
import { cmdAscii, cmdSvg, cmdTopologies } from "./render.js";

// cac hands positionals as string | string[] | undefined — normalize once.
export function posArgs(args: string | string[] | undefined): string[] {
  if (Array.isArray(args)) return args;
  return args === undefined ? [] : [args];
}

type GraphHandler = (args: string | string[] | undefined, opts: GraphOpts) => void;

// search/ask/trace share the CBM runner; query adds the offline template listing.
function cbmActionRoute(name: string): GraphHandler {
  return (args, opts) => {
    (async () => runCbmAction(name, posArgs(args), opts))();
  };
}

export const GRAPH_ROUTES: Record<string, GraphHandler> = {
  topologies: cmdTopologies,
  list: cmdList,
  switch: cmdSwitch,
  show: cmdShow,
  inspect: cmdInspect,
  new: cmdNew,
  ascii: cmdAscii,
  svg: cmdSvg,
  waves: (args, opts) => {
    // Output topological wave structure for direct execution.
    // Each wave = nodes that can run in parallel (all deps satisfied).
    const file = Array.isArray(args) ? args[0] : args;
    try {
      const resolved = file ?? join(process.cwd(), "graph.yaml");
      const graph = loadGraph(resolved);
      const findings = validateGraph(graph, process.cwd());
      if (findings.length > 0) {
        printFail("VALIDATION_FAILED", "graph has findings", {
          details: { findings },
          json: opts.json === true,
        });
        return;
      }
      // Round 5: the curator-interleave planner lives in
      // src/compiler/waves.ts (planExecutionWaves) — the CLI is a thin
      // load → plan → print shim now, and the cadence rules are
      // unit-testable directly.
      const { plan, unresolved } = planExecutionWaves(graph);
      if (unresolved.length > 0) {
        printFail("WAVES_INCOMPLETE", `unresolved nodes after topological sort: ${unresolved.join(", ")}`, {
          details: { unresolved, hint: "cycle or dependency on an excluded node" },
          json: opts.json === true,
        });
        return;
      }
      console.log(JSON.stringify(ok(plan)));
    } catch (e) {
      printFailFromError(e, "WAVES_ERROR", { json: opts.json === true });
    }
  },
  index: (args, opts) => {
    (async () => {
      try {
        const mode = Array.isArray(args) ? (args[0] as "fast" | "moderate" | "full" | undefined) : undefined;
        const result = await withCbmClient((c) => getIndexProjectFn()(c, { repoPath: process.cwd(), mode }));
        console.log(JSON.stringify(ok(result)));
      } catch (e) {
        printCbmFailure(e, opts.json === true);
      }
    })();
  },
  search: cbmActionRoute("search"),
  ask: cbmActionRoute("ask"),
  trace: cbmActionRoute("trace"),
  query: (args, opts) => {
    (async () => {
      // R6: offline template listing — printed before any client could exist.
      if (opts.templates) {
        printQueryTemplates(opts.json);
        return;
      }
      if (opts.template) {
        await runQueryTemplate(opts.template, posArgs(args), opts);
        return;
      }
      await runCbmAction("query", posArgs(args), opts);
    })();
  },
};

export function registerGraphCommands(cli: CAC) {
  cli
    .command("validate [file]", "Validate a graph.yaml")
    .example("$ gk validate graph.yaml")
    .example("$ gk validate            # active session graph, else ./graph.yaml")
    .option("--json", "JSON output")
    .action((file, opts: { json?: boolean }) => {
      try {
        const graph = file ? loadGraph(file) : resolveBareValidateGraph();
        const findings = validateGraph(graph, process.cwd());
        if (findings.length > 0) {
          if (opts.json) {
            console.log(JSON.stringify(fail("VALIDATION_FAILED", "graph has findings", { findings })));
          } else {
            console.log(`✗ VALIDATION_FAILED — ${findings.length} finding(s)`);
            console.log(renderFindings(findings));
          }
          process.exitCode = 1; // fail() sets this on the json arm; the human arm obeys the same rule
          return;
        }
        if (opts.json) {
          console.log(JSON.stringify(ok({ valid: true, topology: graph.topology })));
        } else {
          console.log(`validate: ok (topology ${graph.topology})`);
        }
      } catch (e) {
        printFailFromError(e, "VALIDATE_ERROR", { json: opts.json === true });
      }
    });

  cli
    .command("compile [file]", "Compile graph.yaml to a .workflow.js script")
    .example("$ gk compile graph.yaml")
    .example("$ gk compile --output custom/workflow.js")
    .option("--output <path>", "Output path (default .claude/workflows/{name}.workflow.js)")
    .option("--json", "JSON output")
    .action((file, opts) => {
      try {
        const graph = loadGraph(file ?? join(process.cwd(), "graph.yaml"));
        const findings = validateGraph(graph, process.cwd());
        if (findings.length > 0) {
          if (opts.json) {
            console.log(JSON.stringify(fail("VALIDATION_FAILED", "fix findings before compile", { findings })));
          } else {
            console.log(`✗ VALIDATION_FAILED — ${findings.length} finding(s)`);
            console.log(renderFindings(findings));
          }
          process.exitCode = 1; // fail() sets this on the json arm; the human arm obeys the same rule
          return;
        }
        const script = compileGraph(graph, templatesDir());
        const outPath =
          opts.output ??
          join(process.cwd(), ".claude", "workflows", `${safeGraphName(graph.metadata.name)}.workflow.js`);
        mkdirSync(dirname(outPath), { recursive: true });
        writeFileSync(outPath, script);
        // F9: human mode voices the artifact path so the build is visible; --json stays structured.
        if (opts.json) {
          console.log(JSON.stringify(ok({ compiled: outPath, topology: graph.topology })));
        } else {
          console.log(`compiled ${outPath}`);
        }
      } catch (e) {
        printFail("COMPILE_ERROR", e instanceof Error ? e.message : String(e), { json: opts.json === true });
      }
    });

  cli
    .command("graph [subcommand] [args...]", `Graph lifecycle commands\nSubcommands: ${subcommandsFor("graph")}`)
    .example(subcommandHelpFor("graph"))
    .option("--json", "JSON output")
    // Group-level like --json: consumed by the CBM subcommands that take the
    // knob (search/ask → limit, ask/trace → depth), silently ignored elsewhere.
    .option("--limit <n>", "Max search results for `graph search`/`graph ask` (default: CBM default / 8)")
    .option("--depth <n>", "Trace depth for `graph trace`/`graph ask` (default 3)")
    // R6: `graph query` template knobs — --templates lists offline (no client);
    // --template <name> runs a named template with args[0] as its argument.
    .option("--template <name>", "Query template for `graph query` (dead-code | callers-of | symbol-set)")
    .option("--templates", "List available query templates (offline, no CBM client)")
    .action((subcommand: string | undefined, args: string | string[] | undefined, opts: GraphOpts) => {
      if (!subcommand) {
        // Bare `gk graph` prints usage and exits 0 — same surface as `gk memory`.
        console.log(
          `gk graph — graph lifecycle commands\n\nUsage:\n  gk graph <subcommand> [args...]\n\nSubcommands: ${subcommandsFor("graph")}\n\nOptions:\n  --json  JSON output`,
        );
        return;
      }
      const route = GRAPH_ROUTES[subcommand];
      if (!route) {
        printFail(
          "UNKNOWN_GRAPH_SUBCOMMAND",
          `Unknown subcommand "${subcommand}". Available: ${subcommandsFor("graph")}`,
          { json: opts.json === true },
        );
        return;
      }
      route(args, opts);
    });
}
