import { z } from "zod";
import { EvalConfig } from "./eval.schema.js";
import { MemoryConfig } from "./memory.schema.js";

const NodeRef = z.enum(["opus", "sonnet", "haiku", "fable"]);

// Constraints are written in YAML as a list of single-key maps:
//   constraints:
//     - max_files: 50
//     - no_write: true
const ConstraintValue = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]));

const RefSchema = z.object({
  path: z.string(),
  purpose: z.string(),
});

const LoopConfig = z.object({
  enabled: z.boolean().default(false),
  stop_when: z.string().optional(),
  max_rounds: z.number().int().min(1).default(3),
  exit_condition: z.string().optional(),
});
const AdvisorConfig = z.object({
  model: NodeRef.default("fable"),
  after_failed_rounds: z.number().int().min(1).default(1),
  max_calls: z.number().int().min(1).default(1),
});

const FanOutConfig = z.object({
  briefs_from: z.string().min(1),
  template: z.string().min(1).default("{brief.body}"),
});

export const LoopGroupSchema = z
  .object({
    nodes: z.array(z.string().min(1)).min(1),
    max_rounds: z.number().int().min(1),
    stop_when: z.string().min(1).optional(),
    gate_evidence: z.array(z.string().min(1)).min(1).optional(),
  })
  .refine((data) => Boolean(data.stop_when || data.gate_evidence), {
    message: "At least one of stop_when or gate_evidence must be provided",
  });

export type LoopGroup = z.infer<typeof LoopGroupSchema>;

const NodeDefSchema = z
  .object({
    agent: z.string(),
    model: NodeRef.optional(),
    objective: z.string(),
    tools: z.array(z.string()).default([]),
    skills: z.array(z.string()).default([]),
    refs: z.array(RefSchema).default([]),
    depend_on: z.array(z.string()).default([]),
    loop: LoopConfig.optional().default(() => ({ enabled: false, max_rounds: 3 })),
    constraints: z.array(ConstraintValue).default([]),
    evidence: z.array(z.string()).default([]),
    role: z.string().optional(),
    eval: EvalConfig.optional(),
    advisor: AdvisorConfig.optional(),
    fan_out: FanOutConfig.optional(),
  })
  .superRefine((n, ctx) => {
    if (n.advisor && !n.loop?.enabled) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["advisor"],
        message: "advisor requires loop.enabled: true on the same node",
      });
    }
  });

const LimitsSchema = z.object({
  max_workers: z.number().int().positive().optional(),
  max_iterations: z.number().int().positive().optional(),
  max_findings: z.number().int().positive().optional(),
  budget_tokens: z.number().int().positive().optional(),
});

const EvidenceSchema = z.object({
  required_keys: z.array(z.string()),
  format: z.enum(["markdown", "json"]).default("markdown"),
  criteria: z.array(z.string()).optional(),
  freshness: z.enum(["report", "strict"]).default("report"),
});

const HookRef = z.object({
  on_node_complete: z.array(z.string()).default([]),
  on_fanout_dispatch: z.array(z.string()).default([]),
  on_graph_complete: z.array(z.string()).default([]),
});

const OutputSchema = z.object({
  evidence_dir: z.string().default(".graphkit/evidence/"),
  report: z.string().default(".graphkit/reports/{name}.md"),
});

const TopologyName = z.enum([
  "diamond",
  "classify-and-act",
  "adversarial-verification",
  "loop-until-done",
  "generate-and-filter",
  "tournament",
  "memory-augmented",
  "custom",
  "sdd",
  "superpowers",
  "research-and-build",
]);

type NodeDef = z.infer<typeof NodeDefSchema>;

const GraphSchema = z
  .object({
    apiVersion: z.string().default("graphkit.dev/v2"),
    kind: z.literal("Graph").default("Graph"),
    metadata: z.object({
      name: z.string(),
      description: z.string().optional(),
    }),
    topology: TopologyName,
    inputs: z
      .record(
        z.string(),
        z.object({
          type: z.enum(["string", "array"]),
          required: z.boolean().default(false),
          default: z.any().optional(),
        }),
      )
      .default({}),
    nodes: z.record(z.string(), NodeDefSchema).default({}),
    limits: LimitsSchema.optional().default(() => ({})),
    evidence: EvidenceSchema.optional().default(() => ({ required_keys: [], format: "markdown" as const, freshness: "report" as const })),
    topology_config: z
      .record(z.string(), z.any())
      .default({})
      .superRefine((cfg, ctx) => {
        // memory config was previously read free-form and silently ignored —
        // validate it here so typos fail at `gk validate`, not at runtime
        if (cfg.memory !== undefined) {
          const r = MemoryConfig.safeParse(cfg.memory);
          if (!r.success) {
            ctx.addIssue({
              code: "custom",
              message: `topology_config.memory: ${r.error.issues[0]?.message ?? "invalid"}`,
            });
          }
        }
      }),
    hooks: HookRef.optional().default(() => ({ on_node_complete: [], on_fanout_dispatch: [], on_graph_complete: [] })),
    outputs: OutputSchema.optional().default(() => ({
      evidence_dir: ".graphkit/evidence/",
      report: ".graphkit/reports/{name}.md",
    })),
    loops: z.array(LoopGroupSchema).optional(),
  })
  .superRefine((graph, ctx) => {
    const nodes = graph.nodes as Record<string, NodeDef>;
    const names = new Set(Object.keys(nodes));
    for (const [id, node] of Object.entries(nodes)) {
      for (const dep of node.depend_on) {
        if (!names.has(dep)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["nodes", id, "depend_on"],
            message: `depend_on references unknown node "${dep}"`,
          });
        }
      }
    }
    // fan_out.briefs_from must be a reachable predecessor (transitive depend_on closure)
    const upstreamOf = (id: string, seen = new Set<string>()): Set<string> => {
      for (const dep of nodes[id]?.depend_on ?? []) {
        if (names.has(dep) && !seen.has(dep)) {
          seen.add(dep);
          for (const t of upstreamOf(dep, seen)) seen.add(t);
        }
      }
      return seen;
    };
    for (const [id, node] of Object.entries(nodes)) {
      if (!node.fan_out) continue;
      const upstream = upstreamOf(id);
      const target = node.fan_out.briefs_from;
      if (!names.has(target)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["nodes", id, "fan_out", "briefs_from"],
          message: `fan_out.briefs_from references unknown node "${target}"`,
        });
      } else if (!upstream.has(target)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["nodes", id, "fan_out", "briefs_from"],
          message: `fan_out.briefs_from "${target}" is not an upstream node of "${id}" — add it to depend_on`,
        });
      }
    }
    // Cycle detection: DFS with colors (0=white, 1=gray, 2=black)
    const color = new Map<string, number>();
    const visit = (id: string): boolean => {
      if (color.get(id) === 1) return true;
      if (color.get(id) === 2) return false;
      color.set(id, 1);
      for (const dep of nodes[id]?.depend_on ?? []) {
        if (names.has(dep) && visit(dep)) return true;
      }
      color.set(id, 2);
      return false;
    };
    for (const id of names) {
      if (visit(id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["nodes", id, "depend_on"],
          message: "depend_on forms a cycle",
        });
        break;
      }
    }
  });

export { ConstraintValue, GraphSchema, LoopConfig, NodeDefSchema, RefSchema, TopologyName };
