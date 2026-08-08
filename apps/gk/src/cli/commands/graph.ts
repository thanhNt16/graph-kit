import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import YAML from "yaml";
import type { CAC } from "cac";
import { GraphSchema } from "../../schemas/graph.schema.js";
import { validateGraph } from "../../compiler/validate.js";
import { compileGraph } from "../../compiler/emitter.js";
import { TOPOLOGY_NAMES, getTopologyConfigKeys, type TopologyName } from "../../schemas/topology/index.js";
import { templatesDir } from "./kit.js";
import { ok, fail } from "../output.js";
import { GraphKitError } from "../../errors.js";

export function loadGraph(file: string) {
  const raw = readFileSync(file, "utf-8");
  const doc = YAML.parse(raw);
  const parsed = GraphSchema.safeParse(doc);
  if (!parsed.success) {
    throw new GraphKitError("SCHEMA_INVALID", "graph.yaml failed schema validation", {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  return parsed.data;
}

export function registerGraphCommands(cli: CAC) {
  cli
    .command("validate [file]", "Validate a graph.yaml")
    .option("--json", "JSON output")
    .action((file) => {
      try {
        const graph = loadGraph(file ?? join(process.cwd(), "graph.yaml"));
        const findings = validateGraph(graph, process.cwd());
        if (findings.length > 0) {
          console.log(JSON.stringify(fail("VALIDATION_FAILED", "graph has findings", { findings })));
          process.exit(1);
          return;
        }
        console.log(JSON.stringify(ok({ valid: true, topology: graph.topology })));
      } catch (e) {
        console.log(JSON.stringify(e instanceof GraphKitError
          ? fail(e.code, e.message, e.details)
          : fail("VALIDATE_ERROR", String(e))));
        process.exit(1);
      }
    });

  cli
    .command("compile [file]", "Compile graph.yaml to a .workflow.js script")
    .option("--output <path>", "Output path (default .claude/workflows/{name}.workflow.js)")
    .option("--json", "JSON output")
    .action((file, opts) => {
      try {
        const graph = loadGraph(file ?? join(process.cwd(), "graph.yaml"));
        const findings = validateGraph(graph, process.cwd());
        if (findings.length > 0) {
          console.log(JSON.stringify(fail("VALIDATION_FAILED", "fix findings before compile", { findings })));
          process.exit(1);
          return;
        }
        const script = compileGraph(graph, templatesDir());
        const outPath = opts.output ?? join(process.cwd(), ".claude", "workflows", `${graph.metadata.name}.workflow.js`);
        mkdirSync(dirname(outPath), { recursive: true });
        writeFileSync(outPath, script);
        console.log(JSON.stringify(ok({ compiled: outPath, topology: graph.topology })));
      } catch (e) {
        console.log(JSON.stringify(fail("COMPILE_ERROR", String(e))));
        process.exit(1);
      }
    });

  cli
    .command("graph <subcommand> [args...]", "Graph lifecycle commands")
    .action((subcommand: string, args: string | string[] | undefined) => {
      if (subcommand === "list") {
        console.log(JSON.stringify(ok({ topologies: TOPOLOGY_NAMES })));
      } else if (subcommand === "inspect") {
        const topology = Array.isArray(args) ? args[0] : args;
        if (!topology || !TOPOLOGY_NAMES.includes(topology as TopologyName)) {
          console.log(JSON.stringify(fail("UNKNOWN_TOPOLOGY", `"${topology ?? ""}" is not a canonical topology`, { available: TOPOLOGY_NAMES })));
          process.exit(1);
          return;
        }
        console.log(JSON.stringify(ok({ topology, config_keys: getTopologyConfigKeys(topology as TopologyName) })));
      } else {
        console.log(JSON.stringify(fail("UNKNOWN_GRAPH_SUBCOMMAND", `Unknown subcommand "${subcommand}". Use "graph list" or "graph inspect <topology>"`)));
        process.exit(1);
      }
    });
}
