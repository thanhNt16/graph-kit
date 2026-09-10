import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CAC } from "cac";
import YAML from "yaml";
import { CBM_UNAVAILABLE_MSG, type CbmClient, createCbmClient, isCbmUnavailable } from "../../cbm/client.js";
import type { QueryResult, SearchResult, TraceResult } from "../../cbm/contract.js";
import { indexProject } from "../../cbm/index.js";
import { routeAndRetrieve } from "../../cbm/route.js";
import { listTemplates, QUERY_TEMPLATES, runTemplate } from "../../cbm/templates.js";
import { compileGraph } from "../../compiler/emitter.js";
import { loadGraph, resolveBareValidateGraph } from "../../compiler/loader.js";
import { validateGraph } from "../../compiler/validate.js";
import { GraphKitError } from "../../errors.js";
import { getTopologyConfigKeys, TOPOLOGY_NAMES, type TopologyName } from "../../schemas/topology/index.js";
import { getActiveGraphId, listSessionGraphs, loadActiveGraph, setActiveGraphId } from "../../store/index.js";
import { renderAscii } from "../ascii.js";
import { subcommandsFor } from "../command-registry.js";
import { graphTemplate } from "../graph-templates.js";
import { fail, ok } from "../output.js";
import { renderSvg } from "../svg.js";
import { templatesDir } from "./kit.js";

// ponytail: DI seam for tests — avoids module-mock bleed across test files.
let _cbmClientFactory: () => CbmClient = () => createCbmClient();
let _indexProjectFn: typeof indexProject = indexProject;
/** @internal test seam — inject client + index implementations. */
export function _setCbmSeam(opts: { clientFactory?: () => CbmClient; indexProject?: typeof indexProject }) {
  if (opts.clientFactory) _cbmClientFactory = opts.clientFactory;
  if (opts.indexProject) _indexProjectFn = opts.indexProject;
}
/** @internal test seam — restore real implementations. */
export function _resetCbmSeam() {
  _cbmClientFactory = () => createCbmClient();
  _indexProjectFn = indexProject;
}

// Own the create→call→close lifecycle so a thrown call can't leak the spawned
// CBM child process (mirrors memory.ts indexMemory's try/finally).
async function cbmCall<T>(fn: (client: CbmClient) => Promise<T>): Promise<T> {
  const client = _cbmClientFactory();
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

// Normalize a numeric CLI flag for the CBM primitives: absent (undefined/null/
// "") stays undefined so the server-side default remains authoritative, while a
// provided value must be a positive integer — 0, negatives, and NaN would
// otherwise silently truncate or error deep inside CBM. Null means invalid and
// the caller rejects it with the standard fail envelope at the CLI boundary.
function parsePositiveInt(value: unknown): number | undefined | null {
  if (value === undefined || value === null || value === "") return undefined;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// Prepend the F3 contract when the rejection isn't already carrying it, so gk
// always exits with the honest CBM_CMD/CBM_ARGS guidance — never a bare errno.
function cbmFailure(e: unknown): ReturnType<typeof fail> {
  const msg = String((e as Error)?.message ?? e);
  return fail("CBM_UNAVAILABLE", isCbmUnavailable(e) ? msg : `${CBM_UNAVAILABLE_MSG}\n${msg}`);
}

// R7: the four CBM subcommands as data — one dispatch table, one runner. The
// runner preserves the exact per-command contract: MISSING_ARG before flag
// validation, --limit checked before --depth (ask's documented order), absent
// flags omitted from the payload so server-side defaults stay authoritative.
interface CbmFlags {
  limit?: number;
  depth?: number;
}
interface CbmAction {
  missingArg?: { value: (pos: string[]) => string | undefined; message: string };
  usesLimit?: boolean;
  usesDepth?: boolean;
  run: (c: CbmClient, pos: string[], flags: CbmFlags) => Promise<unknown>;
}
const CBM_ACTIONS: Record<string, CbmAction> = {
  search: {
    missingArg: { value: (pos) => pos[0], message: "search requires a pattern argument" },
    usesLimit: true,
    run: (c, pos, flags) =>
      c.call<SearchResult>("search_graph", {
        pattern: pos[0],
        project: pos[1],
        // flag absent → key omitted, so the CBM server-side default stays authoritative
        ...(flags.limit !== undefined ? { limit: flags.limit } : {}),
      }),
  },
  ask: {
    missingArg: {
      value: (pos) => (pos.length > 0 ? pos.join(" ") : undefined),
      message: "ask requires a natural-language question",
    },
    usesLimit: true,
    usesDepth: true,
    // project undefined = CBM derives from cwd, same as `graph search`
    run: (c, pos, flags) => routeAndRetrieve(c, pos.join(" "), undefined, { limit: flags.limit, depth: flags.depth }),
  },
  trace: {
    missingArg: { value: (pos) => pos[0], message: "trace requires a function_name argument" },
    usesDepth: true,
    run: (c, pos, flags) =>
      c.call<TraceResult>("trace_path", {
        function_name: pos[0],
        project: pos[1],
        depth: flags.depth ?? 3,
        direction: "both",
      }),
  },
  query: {
    missingArg: { value: (pos) => pos[0], message: "query requires a Cypher query argument" },
    run: (c, pos) => c.call<QueryResult>("query_graph", { query: pos[0], project: pos[1] }),
  },
};

// cac hands positionals as string | string[] | undefined — normalize once.
function posArgs(args: string | string[] | undefined): string[] {
  if (Array.isArray(args)) return args;
  return args === undefined ? [] : [args];
}

// Shared CBM runner: MISSING_ARG → INVALID_LIMIT → INVALID_DEPTH (each printed
// as a fail envelope; fail() already sets exit code 1), then cbmCall so a thrown
// call still closes the client, then one catch → cbmFailure + exit 1.
async function runCbmAction(
  name: string,
  pos: string[],
  opts: { limit?: number | string; depth?: number | string },
): Promise<void> {
  try {
    const action = CBM_ACTIONS[name];
    const arg = action.missingArg?.value(pos);
    if (action.missingArg && !arg) {
      console.log(JSON.stringify(fail("MISSING_ARG", action.missingArg.message)));
      return;
    }
    const flags: CbmFlags = {};
    if (action.usesLimit) {
      const limit = parsePositiveInt(opts.limit);
      if (limit === null) {
        console.log(
          JSON.stringify(
            fail("INVALID_LIMIT", `--limit must be a positive integer, got ${JSON.stringify(opts.limit)}`),
          ),
        );
        return;
      }
      flags.limit = limit;
    }
    if (action.usesDepth) {
      const depth = parsePositiveInt(opts.depth);
      if (depth === null) {
        console.log(
          JSON.stringify(
            fail("INVALID_DEPTH", `--depth must be a positive integer, got ${JSON.stringify(opts.depth)}`),
          ),
        );
        return;
      }
      flags.depth = depth;
    }
    const raw = await cbmCall((c) => action.run(c, pos, flags));
    console.log(JSON.stringify(ok(raw)));
  } catch (e) {
    console.log(JSON.stringify(cbmFailure(e)));
    process.exit(1);
  }
}

// R6: `gk graph query --template <name>` — named template runners with the same
// lifecycle hygiene as the raw actions (cbmCall close-on-throw, cbmFailure).
async function runQueryTemplate(name: string, pos: string[], opts: { limit?: number | string }): Promise<void> {
  const tpl = QUERY_TEMPLATES[name];
  if (!tpl) {
    // no CBM call, no client — the template table is checked offline
    console.log(
      JSON.stringify(
        fail("UNKNOWN_TEMPLATE", `Unknown query template "${name}"`, { available: Object.keys(QUERY_TEMPLATES) }),
      ),
    );
    return;
  }
  const arg = tpl.argHint ? pos[0] : undefined;
  const project = tpl.argHint ? pos[1] : pos[0];
  if (tpl.argHint && !arg) {
    console.log(JSON.stringify(fail("MISSING_ARG", `template "${name}" requires an argument (${tpl.argHint})`)));
    return;
  }
  const limit = parsePositiveInt(opts.limit);
  if (limit === null) {
    console.log(
      JSON.stringify(fail("INVALID_LIMIT", `--limit must be a positive integer, got ${JSON.stringify(opts.limit)}`)),
    );
    return;
  }
  try {
    const raw = await cbmCall((c) => runTemplate(c, name, arg, project, limit ?? 25));
    console.log(JSON.stringify(ok(raw)));
  } catch (e) {
    console.log(JSON.stringify(cbmFailure(e)));
    process.exit(1);
  }
}

// R6: `gk graph query --templates` — offline listing, never creates a client.
function printQueryTemplates(json: boolean | undefined): void {
  const templates = listTemplates();
  if (json) {
    console.log(JSON.stringify(ok({ templates })));
    return;
  }
  const nameW = Math.max("name".length, ...templates.map((t) => t.name.length));
  console.log(`${"name".padEnd(nameW)}  arg  description`);
  for (const t of templates) {
    console.log(`${t.name.padEnd(nameW)}  ${t.arg_hint ?? "-"}  ${t.description}`);
  }
}

// Back-compat re-exports: sibling commands (gate/doctor/status/evidence) and
// tests import loadGraph/graphTemplate from this module — keep the surface
// stable now that the implementations live in dedicated modules.
export { graphTemplate, loadGraph, resolveBareValidateGraph };

export function registerGraphCommands(cli: CAC) {
  cli
    .command("validate [file]", "Validate a graph.yaml")
    .option("--json", "JSON output")
    .action((file) => {
      try {
        const graph = file ? loadGraph(file) : resolveBareValidateGraph();
        const findings = validateGraph(graph, process.cwd());
        if (findings.length > 0) {
          console.log(JSON.stringify(fail("VALIDATION_FAILED", "graph has findings", { findings })));
          process.exit(1);
          return;
        }
        console.log(JSON.stringify(ok({ valid: true, topology: graph.topology })));
      } catch (e) {
        console.log(
          JSON.stringify(
            e instanceof GraphKitError ? fail(e.code, e.message, e.details) : fail("VALIDATE_ERROR", String(e)),
          ),
        );
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
        const outPath =
          opts.output ?? join(process.cwd(), ".claude", "workflows", `${graph.metadata.name}.workflow.js`);
        mkdirSync(dirname(outPath), { recursive: true });
        writeFileSync(outPath, script);
        // F9: human mode voices the artifact path so the build is visible; --json stays structured.
        if (opts.json) {
          console.log(JSON.stringify(ok({ compiled: outPath, topology: graph.topology })));
        } else {
          console.log(`compiled ${outPath}`);
        }
      } catch (e) {
        console.log(JSON.stringify(fail("COMPILE_ERROR", String(e))));
        process.exit(1);
      }
    });

  cli
    .command("graph [subcommand] [args...]", `Graph lifecycle commands\nSubcommands: ${subcommandsFor("graph")}`)
    .option("--json", "JSON output")
    // Group-level like --json: consumed by the CBM subcommands that take the
    // knob (search/ask → limit, ask/trace → depth), silently ignored elsewhere.
    .option("--limit <n>", "Max search results for `graph search`/`graph ask` (default: CBM default / 8)")
    .option("--depth <n>", "Trace depth for `graph trace`/`graph ask` (default 3)")
    // R6: `graph query` template knobs — --templates lists offline (no client);
    // --template <name> runs a named template with args[0] as its argument.
    .option("--template <name>", "Query template for `graph query` (dead-code | callers-of | symbol-set)")
    .option("--templates", "List available query templates (offline, no CBM client)")
    .action(
      (
        subcommand: string | undefined,
        args: string | string[] | undefined,
        opts: {
          json?: boolean;
          limit?: number | string;
          depth?: number | string;
          template?: string;
          templates?: boolean;
        },
      ) => {
        if (!subcommand) {
          // Bare `gk graph` prints usage and exits 0 — same surface as `gk memory`.
          console.log(
            `gk graph — graph lifecycle commands\n\nUsage:\n  gk graph <subcommand> [args...]\n\nSubcommands: ${subcommandsFor("graph")}\n\nOptions:\n  --json  JSON output`,
          );
          return;
        }
        if (subcommand === "topologies") {
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
        } else if (subcommand === "list") {
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
              console.log("no session graphs — run `gk init-graph` or `gk template materialize`");
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
            console.log(
              JSON.stringify(
                e instanceof GraphKitError ? fail(e.code, e.message, e.details) : fail("LIST_ERROR", String(e)),
              ),
            );
            process.exit(1);
          }
        } else if (subcommand === "switch") {
          const id = Array.isArray(args) ? args[0] : args;
          try {
            if (!id) {
              console.log(JSON.stringify(fail("MISSING_ARG", "graph switch requires a session graph id")));
              process.exit(1);
              return;
            }
            setActiveGraphId(id);
            if (opts.json) {
              console.log(JSON.stringify(ok({ active: id })));
            } else {
              console.log(`active -> ${id}`);
            }
          } catch (e) {
            console.log(
              JSON.stringify(
                e instanceof GraphKitError ? fail(e.code, e.message, e.details) : fail("SWITCH_ERROR", String(e)),
              ),
            );
            process.exit(1);
          }
        } else if (subcommand === "show") {
          const id = Array.isArray(args) ? args[0] : args;
          try {
            // Explicit id resolves through listSessionGraphs so user input is never
            // joined into a path — traversal ids simply never match an entry.
            const entry = id ? listSessionGraphs().find((s) => s.id === id) : null;
            let raw: string;
            let resolvedId: string;
            let resolvedPath: string;
            if (entry) {
              raw = readFileSync(entry.path, "utf-8");
              resolvedId = entry.id;
              resolvedPath = entry.path;
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
            console.log(
              JSON.stringify(
                e instanceof GraphKitError ? fail(e.code, e.message, e.details) : fail("SHOW_ERROR", String(e)),
              ),
            );
            process.exit(1);
          }
        } else if (subcommand === "inspect") {
          const topology = Array.isArray(args) ? args[0] : args;
          if (!topology || !TOPOLOGY_NAMES.includes(topology as TopologyName)) {
            console.log(
              JSON.stringify(
                fail("UNKNOWN_TOPOLOGY", `"${topology ?? ""}" is not a canonical topology`, {
                  available: TOPOLOGY_NAMES,
                }),
              ),
            );
            process.exit(1);
            return;
          }
          console.log(JSON.stringify(ok({ topology, config_keys: getTopologyConfigKeys(topology as TopologyName) })));
        } else if (subcommand === "new") {
          const topology = Array.isArray(args) ? args[0] : args;
          if (!topology || !TOPOLOGY_NAMES.includes(topology as TopologyName)) {
            console.log(
              JSON.stringify(
                fail("UNKNOWN_TOPOLOGY", `"${topology ?? ""}" is not a canonical topology`, {
                  available: TOPOLOGY_NAMES,
                }),
              ),
            );
            process.exit(1);
            return;
          }
          // Emit a valid graph.yaml template for the topology to stdout
          const template = graphTemplate(topology as TopologyName);
          console.log(template);
        } else if (subcommand === "ascii") {
          // Instant ASCII diagram — no model, no rendering pipeline
          const file = Array.isArray(args) ? args[0] : args;
          try {
            // load once, schema-validate once — the renderers take the typed graph
            const out = renderAscii(loadGraph(file ?? join(process.cwd(), "graph.yaml")));
            console.log(out);
          } catch (e) {
            console.log(JSON.stringify(fail("ASCII_ERROR", String(e))));
            process.exit(1);
          }
        } else if (subcommand === "svg") {
          const file = Array.isArray(args) ? args[0] : args;
          try {
            const graph = loadGraph(file ?? join(process.cwd(), "graph.yaml"));
            const svg = renderSvg(graph);
            const outDir = join(process.cwd(), ".graphkit", "diagrams");
            mkdirSync(outDir, { recursive: true });
            const outPath = join(outDir, `${graph.metadata?.name || "graph"}.svg`);
            writeFileSync(outPath, svg);
            console.log(JSON.stringify(ok({ svg: outPath })));
          } catch (e) {
            console.log(JSON.stringify(fail("SVG_ERROR", String(e))));
            process.exit(1);
          }
        } else if (subcommand === "waves") {
          // Output topological wave structure for direct execution
          // Each wave = nodes that can run in parallel (all deps satisfied)
          const file = Array.isArray(args) ? args[0] : args;
          try {
            const resolved = file ?? join(process.cwd(), "graph.yaml");
            const graph = loadGraph(resolved);
            const findings = validateGraph(graph, process.cwd());
            if (findings.length > 0) {
              console.log(JSON.stringify(fail("VALIDATION_FAILED", "graph has findings", { findings })));
              process.exit(1);
              return;
            }
            const nodes = graph.nodes || {};
            const ids = Object.keys(nodes);

            // Memory-augmented: the Curator node interleaves at cadence (execute-path
            // equivalent of memory-augmented.workflow.js's wrappedAgent, which only
            // runs under the Workflow tool). Pull the curator out of the Kahn sort and
            // re-insert it as its own interleave waves so /gk:execute can dispatch it.
            const isMem = graph.topology === "memory-augmented";
            const memCfg = isMem ? graph.topology_config?.memory || {} : {};
            const curatorName = isMem ? memCfg.curator_node || "curator" : null;
            const cadence = memCfg.cadence || "on_node_complete";
            const every = memCfg.every || 1;
            const hasCurator = curatorName !== null && Object.hasOwn(nodes, curatorName);
            const actionIds = hasCurator ? ids.filter((id) => id !== curatorName) : ids;

            // Kahn's algorithm over action nodes → action waves
            const completed = new Set<string>();
            const actionWaves: string[][] = [];
            while (completed.size < actionIds.length) {
              const ready = actionIds.filter((id) => {
                if (completed.has(id)) return false;
                const deps = nodes[id]?.depend_on || [];
                return deps.every((d: string) => completed.has(d));
              });
              if (ready.length === 0) break;
              actionWaves.push(ready);
              ready.forEach((id) => {
                completed.add(id);
              });
            }

            if (completed.size < actionIds.length) {
              const unresolved = actionIds.filter((id) => !completed.has(id));
              console.log(
                JSON.stringify(
                  fail("WAVES_INCOMPLETE", `unresolved nodes after topological sort: ${unresolved.join(", ")}`, {
                    unresolved,
                    hint: "cycle or dependency on an excluded node",
                  }),
                ),
              );
              process.exit(1);
              return;
            }

            // Interleave curator waves at cadence; always finish with one end-of-run curation.
            type PlanWave = { kind: "action"; ids: string[] } | { kind: "curator" };
            const plan: PlanWave[] = [];
            let completedActions = 0;
            let lastCuratedAt = 0;
            actionWaves.forEach((w) => {
              plan.push({ kind: "action", ids: w });
              completedActions += w.length;
              if (hasCurator) {
                const fire =
                  cadence === "on_node_complete" ||
                  (cadence === "every" && Math.floor(completedActions / every) > Math.floor(lastCuratedAt / every));
                if (fire) {
                  plan.push({ kind: "curator" });
                  lastCuratedAt = completedActions;
                }
              }
            });
            // End-of-run curation: fire if the last crossing happened at a multiple of
            // `every` but the current cumulative total no longer is — a threshold was
            // passed since the last fire.
            if (
              hasCurator &&
              actionWaves.length > 0 &&
              lastCuratedAt > 0 &&
              lastCuratedAt < completedActions &&
              completedActions % every !== 0 &&
              lastCuratedAt % every === 0
            ) {
              plan.push({ kind: "curator" });
            }

            // HookRef commands ride the payload so /gk:execute can run them without
            // re-reading graph.yaml. on_fanout_dispatch stays declared-but-unused:
            // no consumer exists, and inventing one would be speculative.
            const nodeHooks = graph.hooks?.on_node_complete ?? [];
            const nodeObj = (id: string) => ({
              id,
              agent: nodes[id]?.agent,
              model: nodes[id]?.model || "sonnet",
              objective: nodes[id]?.objective?.trim() || "",
              tools: nodes[id]?.tools || [],
              skills: nodes[id]?.skills || [],
              refs: nodes[id]?.refs || [],
              depend_on: nodes[id]?.depend_on || [],
              loop: nodes[id]?.loop || null,
              evidence: nodes[id]?.evidence || [],
              advisor: nodes[id]?.advisor ?? null,
              fan_out: nodes[id]?.fan_out ?? null,
              hooks: nodeHooks,
            });

            // Materialize waves; curator waves carry `curator: true` + the recall skill.
            const waveData = plan.map((pw, i) => {
              if (pw.kind === "curator") {
                const skills = Array.from(new Set([...(nodes[curatorName]?.skills || []), "gk-recall"]));
                return { wave: i, parallel: false, curator: true, nodes: [{ ...nodeObj(curatorName), skills }] };
              }
              return { wave: i, parallel: pw.ids.length > 1, nodes: pw.ids.map(nodeObj) };
            });

            const payload: Record<string, unknown> = {
              graph: graph.metadata?.name,
              topology: graph.topology,
              total_waves: waveData.length,
              total_nodes: ids.length,
              waves: waveData,
              evidence_required: graph.evidence?.required_keys || [],
              on_graph_complete: graph.hooks?.on_graph_complete ?? [],
            };
            if (hasCurator) {
              payload.memory = {
                curator_node: curatorName,
                cadence,
                every,
                recall_topk: memCfg.recall_topk ?? 5,
                expire_policy: memCfg.expire_policy ?? "act_r",
                null_intervention_allowed: memCfg.null_intervention_allowed ?? true,
              };
            }

            console.log(JSON.stringify(ok(payload)));
          } catch (e) {
            console.log(
              JSON.stringify(
                e instanceof GraphKitError ? fail(e.code, e.message, e.details) : fail("WAVES_ERROR", String(e)),
              ),
            );
            process.exit(1);
          }
        } else if (subcommand === "index") {
          (async () => {
            try {
              const mode = Array.isArray(args) ? (args[0] as "fast" | "moderate" | "full" | undefined) : undefined;
              const result = await cbmCall((c) => _indexProjectFn(c, { repoPath: process.cwd(), mode }));
              console.log(JSON.stringify(ok(result)));
            } catch (e) {
              console.log(JSON.stringify(cbmFailure(e)));
              process.exit(1);
            }
          })();
        } else if (subcommand === "search" || subcommand === "ask" || subcommand === "trace") {
          // R7: one dispatch table + shared runner for the CBM primitives.
          const pos = posArgs(args);
          (async () => runCbmAction(subcommand, pos, opts))();
        } else if (subcommand === "query") {
          const pos = posArgs(args);
          (async () => {
            // R6: offline template listing — printed before any client could exist.
            if (opts.templates) {
              printQueryTemplates(opts.json);
              return;
            }
            if (opts.template) {
              await runQueryTemplate(opts.template, pos, opts);
              return;
            }
            await runCbmAction("query", pos, opts);
          })();
        } else {
          console.log(
            JSON.stringify(
              fail(
                "UNKNOWN_GRAPH_SUBCOMMAND",
                `Unknown subcommand "${subcommand}". Available: ${subcommandsFor("graph")}`,
              ),
            ),
          );
          process.exit(1);
        }
      },
    );
}
