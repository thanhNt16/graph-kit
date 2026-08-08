import { z } from "zod";

const NodeRef = z.enum([
  "opus", "sonnet", "haiku", "fable"
]);

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

const NodeDefSchema = z.object({
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
]);

type NodeDef = z.infer<typeof NodeDefSchema>;

const GraphSchema = z.object({
  apiVersion: z.string().default("graphkit.dev/v2"),
  kind: z.literal("Graph").default("Graph"),
  metadata: z.object({
    name: z.string(),
    description: z.string().optional(),
  }),
  topology: TopologyName,
  inputs: z.record(z.string(), z.object({
    type: z.enum(["string", "array"]),
    required: z.boolean().default(false),
    default: z.any().optional(),
  })).default({}),
  nodes: z.record(z.string(), NodeDefSchema).default({}),
  limits: LimitsSchema.optional().default(() => ({})),
  evidence: EvidenceSchema.optional().default(() => ({ required_keys: [], format: "markdown" as const })),
  topology_config: z.record(z.string(), z.any()).default({}),
  hooks: HookRef.optional().default(() => ({ on_node_complete: [], on_fanout_dispatch: [], on_graph_complete: [] })),
  outputs: OutputSchema.optional().default(() => ({ evidence_dir: ".graphkit/evidence/", report: ".graphkit/reports/{name}.md" })),
}).superRefine((graph, ctx) => {
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

export { GraphSchema, NodeDefSchema, TopologyName, LoopConfig, RefSchema, ConstraintValue };
