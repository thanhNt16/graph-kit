// `gk graph` render + reference subcommands: topologies table, ascii, svg, new.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadGraph } from "../../../compiler/loader.js";
import { getTopologyConfigKeys, TOPOLOGY_NAMES } from "../../../schemas/topology/index.js";
import { safeGraphName } from "../../../store/index.js";
import { renderAscii } from "../../ascii.js";
import { graphTemplate } from "../../graph-templates.js";
import { ok, printFail } from "../../output.js";
import { renderSvg } from "../../svg.js";
import type { GraphOpts } from "./lifecycle.js";

export function cmdTopologies(_args: string | string[] | undefined, opts: GraphOpts): void {
  const topologies = TOPOLOGY_NAMES.map((name) => {
    const template = graphTemplate(name);
    const descMatch = template.match(/^ {2}description: (.+)$/m);
    return {
      name,
      description: descMatch ? descMatch[1] : name,
      config_keys: getTopologyConfigKeys(name),
    };
  });
  if (opts.json) {
    console.log(JSON.stringify(ok({ topologies })));
  } else {
    const nameW = Math.max("name".length, ...topologies.map((t) => t.name.length));
    console.log(`${"name".padEnd(nameW)}  description`);
    for (const t of topologies) {
      console.log(`${t.name.padEnd(nameW)}  ${t.description}`);
    }
  }
}

export function cmdAscii(args: string | string[] | undefined, opts: GraphOpts): void {
  // Instant ASCII diagram — no model, no rendering pipeline
  const file = Array.isArray(args) ? args[0] : args;
  try {
    // load once, schema-validate once — the renderers take the typed graph
    const out = renderAscii(loadGraph(file ?? join(process.cwd(), "graph.yaml")));
    console.log(out);
  } catch (e) {
    printFail("ASCII_ERROR", e instanceof Error ? e.message : String(e), { json: opts.json === true });
  }
}

export function cmdSvg(args: string | string[] | undefined, opts: GraphOpts): void {
  const file = Array.isArray(args) ? args[0] : args;
  try {
    const graph = loadGraph(file ?? join(process.cwd(), "graph.yaml"));
    const svg = renderSvg(graph);
    const outDir = join(process.cwd(), ".graphkit", "diagrams");
    mkdirSync(outDir, { recursive: true });
    const outPath = join(outDir, `${safeGraphName(graph.metadata?.name || "graph")}.svg`);
    writeFileSync(outPath, svg);
    console.log(JSON.stringify(ok({ svg: outPath })));
  } catch (e) {
    printFail("SVG_ERROR", e instanceof Error ? e.message : String(e), { json: opts.json === true });
  }
}
