// `gk graph` lifecycle subcommands: session-graph list/switch/show/inspect/new.
import { readFileSync } from "node:fs";
import YAML from "yaml";
import { GraphKitError } from "../../../errors.js";
import { getTopologyConfigKeys, TOPOLOGY_NAMES, type TopologyName } from "../../../schemas/topology/index.js";
import {
  getActiveGraphId,
  listSessionGraphs,
  loadActiveGraph,
  sessionGraphPath,
  setActiveGraphId,
} from "../../../store/index.js";
import { graphTemplate } from "../../graph-templates.js";
import { ok, printFail, printFailFromError } from "../../output.js";

export interface GraphOpts {
  json?: boolean;
  limit?: number | string;
  depth?: number | string;
  template?: string;
  templates?: boolean;
}

export function cmdList(_args: string | string[] | undefined, opts: GraphOpts): void {
  try {
    const skipped: Array<{ id: string; file: string }> = [];
    const sessions = listSessionGraphs(process.cwd(), (entry) => skipped.push(entry));
    const active = getActiveGraphId();
    if (active !== null && !sessions.some((s) => s.id === active)) {
      // Dangling pointer (spec §6): fail fast when active names a missing file.
      // Existence check only — schema validity stays out of a listing command.
      throw new GraphKitError("ACTIVE_POINTER_DANGLING", `Active pointer "${active}" has no graph file`, {
        id: active,
        baseDir: process.cwd(),
        available: sessions.map((s) => s.id),
      });
    }
    if (opts.json) {
      console.log(JSON.stringify(ok({ sessions, active })));
    } else if (sessions.length === 0) {
      // Both hints must be real surfaces: `gk template materialize` is a
      // CLI command, /gk:init-graph is the agent session skill.
      console.log(
        "no session graphs — materialize one with `gk template materialize <name> --use`, or run /gk:init-graph in your agent",
      );
    } else {
      const idW = Math.max("id".length, ...sessions.map((s) => s.id.length));
      const nameW = Math.max("name".length, ...sessions.map((s) => s.name.length));
      const taskW = Math.max("task".length, ...sessions.map((s) => (s.task ?? "").length));
      console.log(
        `${"id".padEnd(idW)}  ${"name".padEnd(nameW)}  ${"task".padEnd(taskW)}  ${"created".padEnd(24)}  last-run`,
      );
      for (const s of sessions) {
        const mark = s.id === active ? "*" : " ";
        console.log(
          `${mark}${s.id.padEnd(idW - 1)}  ${s.name.padEnd(nameW)}  ${(s.task ?? "").padEnd(taskW)}  ${s.createdAt.toISOString().padEnd(24)}  -`,
        );
      }
    }
    if (skipped.length > 0) {
      console.warn(
        `warning: skipped ${skipped.length} unparseable session file(s): ${skipped.map((s) => s.file).join(", ")}`,
      );
    }
  } catch (e) {
    printFailFromError(e, "LIST_ERROR", { json: opts.json === true });
  }
}

export function cmdSwitch(args: string | string[] | undefined, opts: GraphOpts): void {
  const id = Array.isArray(args) ? args[0] : args;
  try {
    if (!id) {
      printFail("MISSING_ARG", "graph switch requires a session graph id", { json: opts.json === true });
      return;
    }
    setActiveGraphId(id);
    if (opts.json) {
      console.log(JSON.stringify(ok({ active: id })));
    } else {
      console.log(`active -> ${id}`);
    }
  } catch (e) {
    printFailFromError(e, "SWITCH_ERROR", { json: opts.json === true });
  }
}

export function cmdShow(args: string | string[] | undefined, opts: GraphOpts): void {
  const id = Array.isArray(args) ? args[0] : args;
  try {
    // O(1) path resolution: the id is regex-validated inside
    // sessionGraphPath before any join, so traversal ids resolve to
    // null exactly like they never matched a list entry. Only the
    // not-found path pays for the full listSessionGraphs walk.
    const path = id ? sessionGraphPath(id) : null;
    let raw: string;
    let resolvedId: string;
    let resolvedPath: string;
    if (path && id) {
      raw = readFileSync(path, "utf-8");
      resolvedId = id;
      resolvedPath = path;
    } else if (id) {
      throw new GraphKitError("GRAPH_NOT_FOUND", `No session graph with id "${id}"`, {
        id,
        available: listSessionGraphs().map((s) => s.id),
      });
    } else {
      const active = loadActiveGraph();
      raw = readFileSync(active.path, "utf-8");
      resolvedId = active.id;
      resolvedPath = active.path;
    }
    if (opts.json) {
      console.log(JSON.stringify(ok({ id: resolvedId, path: resolvedPath, graph: YAML.parse(raw) })));
    } else {
      console.log(raw.trimEnd());
    }
  } catch (e) {
    printFailFromError(e, "SHOW_ERROR", { json: opts.json === true });
  }
}

export function cmdInspect(args: string | string[] | undefined, opts: GraphOpts): void {
  const topology = Array.isArray(args) ? args[0] : args;
  if (!topology || !TOPOLOGY_NAMES.includes(topology as TopologyName)) {
    printFail("UNKNOWN_TOPOLOGY", `"${topology ?? ""}" is not a canonical topology`, {
      details: { available: TOPOLOGY_NAMES },
      json: opts.json === true,
    });
    return;
  }
  console.log(JSON.stringify(ok({ topology, config_keys: getTopologyConfigKeys(topology as TopologyName) })));
}

export function cmdNew(args: string | string[] | undefined, opts: GraphOpts): void {
  const topology = Array.isArray(args) ? args[0] : args;
  if (!topology || !TOPOLOGY_NAMES.includes(topology as TopologyName)) {
    // Lead with the usage line when the arg is absent — the operator
    // copy-pastes the fix, not a complaint about an empty string.
    const message = topology
      ? `"${topology}" is not a canonical topology`
      : "usage: gk graph new <topology> — e.g. `gk graph new diamond`";
    printFail("UNKNOWN_TOPOLOGY", message, {
      details: { available: TOPOLOGY_NAMES },
      json: opts.json === true,
    });
    return;
  }
  // Emit a valid graph.yaml template for the topology to stdout
  const template = graphTemplate(topology as TopologyName);
  console.log(template);
}
