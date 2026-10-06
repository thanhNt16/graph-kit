import { readFileSync } from "node:fs";
import YAML from "yaml";
import { GraphKitError } from "../errors.js";
import type { Graph } from "../schemas/graph.schema.js";

// Kahn levelization shared by the executor (`graph waves`), the renderers
// (`graph ascii`) and the compiler's validation pass so none of them can
// disagree with the run plan. Wave index of a node = 1 + max(wave index of
// its deps): a node is ready exactly when every dep finished in an earlier
// wave.
export function topoWaves(nodes: Record<string, { depend_on?: string[] } | undefined>): {
  waves: string[][];
  unresolved: string[];
} {
  const ids = Object.keys(nodes);
  const done = new Set<string>();
  const waves: string[][] = [];
  for (;;) {
    const ready = ids.filter((id) => !done.has(id) && (nodes[id]?.depend_on ?? []).every((d) => done.has(d)));
    if (ready.length === 0) break;
    waves.push(ready);
    for (const id of ready) done.add(id);
  }
  return { waves, unresolved: ids.filter((id) => !done.has(id)) };
}

type NodeDef = Graph["nodes"][string];

// One planned node: the exact payload shape /gk:execute dispatches against.
// Every orchestration field rides even when unset (null), so consumers never
// branch on missing keys — the verbatim-passthrough contract.
export interface PlannedNode {
  id: string;
  agent: string;
  model: NonNullable<NodeDef["model"]>;
  objective: string;
  tools: string[];
  skills: string[];
  refs: NodeDef["refs"];
  advisor: NonNullable<NodeDef["advisor"]> | null;
  fan_out: NonNullable<NodeDef["fan_out"]> | null;
  retry: NonNullable<NodeDef["retry"]> | null;
  when: NonNullable<NodeDef["when"]> | null;
  budget_tokens: number | null;
  gate: NonNullable<NodeDef["gate"]> | null;
  role: string | null;
  eval: unknown;
  effort: NonNullable<NodeDef["effort"]>;
  timeout_ms: number | null;
  constraints: NodeDef["constraints"];
  assumptions: string[];
  owns: string[];
  depend_on: string[];
  loop: NonNullable<NodeDef["loop"]> | null;
  evidence: string[];
  hooks: NonNullable<Graph["hooks"]>["on_node_complete"];
}

export interface PlanWave {
  index: number;
  parallel: boolean;
  curator?: boolean;
  nodes: PlannedNode[];
}

export interface PlanMemoryConfig {
  curator_node: string;
  cadence: string;
  every: number;
  recall_topk: number;
  expire_policy: string;
  null_intervention_allowed: boolean;
}

export interface PlanGraph {
  waves: PlanWave[];
  memory?: PlanMemoryConfig;
  topology_config?: Record<string, unknown>;
  warnings: string[];
}

// The planner: turns a validated Graph into the wave IR every consumer
// (`graph waves` payload, /gk:execute dispatch, renderers) derives from.
// Memory-augmented graphs pull the Curator out of the Kahn sort and
// re-insert it as interleave waves at the configured cadence (execute-path
// equivalent of memory-augmented.workflow.js's wrappedAgent, which only
// runs under the Workflow tool).
export function planGraph(graph: Graph, opts?: { source?: string }): PlanGraph {
  const nodes = graph.nodes;
  const ids = Object.keys(nodes);

  // eval rides the payload verbatim: GraphSchema.parse materializes
  // EvalConfig defaults (mode/rubric/abstention_weighted), so the author's
  // exact eval block is read back from the source YAML, not from parsed
  // data. role needs no raw read — it is a plain z.string(), the parsed
  // node already carries the author's exact word. Boundary cast: YAML.parse
  // yields unknown, and the document is the same file the caller's
  // GraphSchema.parse just accepted.
  type RawDoc = { nodes?: Record<string, { eval?: unknown }> };
  const rawDoc: RawDoc | null = opts?.source
    ? (YAML.parse(readFileSync(opts.source, "utf-8")) as RawDoc | null)
    : null;

  const isMem = graph.topology === "memory-augmented";
  const memCfg = isMem ? graph.topology_config?.memory || {} : {};
  const curatorName = isMem ? memCfg.curator_node || "curator" : null;
  const cadence = memCfg.cadence || "on_node_complete";
  const every = memCfg.every || 1;
  const hasCurator = curatorName !== null && Object.hasOwn(nodes, curatorName);
  const actionIds = hasCurator ? ids.filter((id) => id !== curatorName) : ids;

  // Kahn's algorithm over action nodes → action waves (shared helper so
  // renderers compute the identical levelization).
  const actionNodes = Object.fromEntries(actionIds.map((id) => [id, nodes[id]]));
  const { waves: actionWaves, unresolved } = topoWaves(actionNodes);
  if (unresolved.length > 0) {
    throw new GraphKitError("WAVES_INCOMPLETE", `unresolved nodes after topological sort: ${unresolved.join(", ")}`, {
      unresolved,
      hint: "cycle or dependency on an excluded node",
    });
  }

  // Interleave curator waves at cadence; always finish with one end-of-run curation.
  type PlanStep = { kind: "action"; ids: string[] } | { kind: "curator" };
  const plan: PlanStep[] = [];
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
  const nodeObj = (id: string): PlannedNode => {
    const n = nodes[id];
    return {
      id,
      agent: n?.agent,
      model: n?.model || "sonnet",
      objective: n?.objective?.trim() || "",
      tools: n?.tools || [],
      skills: n?.skills || [],
      refs: n?.refs || [],
      advisor: n?.advisor ?? null,
      fan_out: n?.fan_out ?? null,
      retry: n?.retry ?? null,
      when: n?.when ?? null,
      budget_tokens: n?.budget_tokens ?? null,
      gate: n?.gate ?? null,
      role: n?.role ?? null,
      eval: rawDoc?.nodes?.[id]?.eval ?? null,
      effort: n?.effort ?? "standard",
      timeout_ms: n?.timeout_ms ?? null,
      constraints: n?.constraints || [],
      assumptions: n?.assumptions || [],
      owns: n?.owns || [],
      depend_on: n?.depend_on || [],
      loop: n?.loop || null,
      evidence: n?.evidence || [],
      hooks: nodeHooks,
    };
  };

  // Materialize waves; curator waves carry `curator: true` + the recall skill.
  const curator = curatorName as string;
  const waves: PlanWave[] = plan.map((pw, i) => {
    if (pw.kind === "curator") {
      const skills = Array.from(new Set([...(nodes[curator]?.skills || []), "gk-recall"]));
      return { index: i, parallel: false, curator: true, nodes: [{ ...nodeObj(curator), skills }] };
    }
    return { index: i, parallel: pw.ids.length > 1, nodes: pw.ids.map(nodeObj) };
  });

  const out: PlanGraph = { waves, warnings: [] };
  // topology_config rides the plan (audit CS#4 — the waves payload used to
  // drop it). Schema default is {}, so authored config passes through
  // verbatim and absent config still surfaces as an empty object.
  out.topology_config = graph.topology_config;
  if (hasCurator) {
    out.memory = {
      curator_node: curator,
      cadence,
      every,
      recall_topk: memCfg.recall_topk ?? 5,
      expire_policy: memCfg.expire_policy ?? "act_r",
      null_intervention_allowed: memCfg.null_intervention_allowed ?? true,
    };
  }
  return out;
}
