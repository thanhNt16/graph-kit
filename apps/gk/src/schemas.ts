import { z } from "zod";

// ── Node types (discriminated on `type`) ────────────────────────────────

export const NodeIdSchema = z.string().min(1);

export const OutputDeclarationSchema = z.object({
  schema: z.string().min(1), // path to a template JSON Schema
  save_as: z.string().min(1),
});

export const AgentNodeSchema = z.object({
  id: NodeIdSchema,
  type: z.literal("agent"),
  skill: z.string().min(1),
  objective: z.string().min(1),
  output: OutputDeclarationSchema,
  tools: z.array(z.string()).default([]),
});
export type AgentNode = z.infer<typeof AgentNodeSchema>;

export const CommandNodeSchema = z.object({
  id: NodeIdSchema,
  type: z.literal("command"),
  command: z.array(z.string()).min(1), // executable + args, never a shell string
});
export type CommandNode = z.infer<typeof CommandNodeSchema>;

export const ValidatorNodeSchema = z.object({
  id: NodeIdSchema,
  type: z.literal("validator"),
  checks: z.array(z.string()).default([]),
});
export type ValidatorNode = z.infer<typeof ValidatorNodeSchema>;

export const RouterNodeSchema = z.object({
  id: NodeIdSchema,
  type: z.literal("router"),
  routes: z.array(
    z.object({
      when: z.string().min(1), // expression
      to: z.union([NodeIdSchema, z.array(NodeIdSchema)]),
    }),
  ),
});
export type RouterNode = z.infer<typeof RouterNodeSchema>;

export const GraphNodeSchema = z.object({
  id: NodeIdSchema,
  type: z.literal("graph"),
  operation: z.string().min(1),
});
export type GraphNode = z.infer<typeof GraphNodeSchema>;

export const HumanNodeSchema = z.object({
  id: NodeIdSchema,
  type: z.literal("human"),
  prompt: z.string().min(1),
  actions: z.array(z.string().min(1)).min(1),
});
export type HumanNode = z.infer<typeof HumanNodeSchema>;

export const FanoutNodeSchema = z.object({
  id: NodeIdSchema,
  type: z.literal("fanout"),
  from: z.string().min(1), // state field carrying the work items
  max_workers: z.number().int().positive(),
});
export type FanoutNode = z.infer<typeof FanoutNodeSchema>;

export const JoinNodeSchema = z.object({
  id: NodeIdSchema,
  type: z.literal("join"),
  merge: z.string().min(1), // declared merge policy reference
});
export type JoinNode = z.infer<typeof JoinNodeSchema>;

export const NodeSchema = z.discriminatedUnion("type", [
  AgentNodeSchema,
  CommandNodeSchema,
  ValidatorNodeSchema,
  RouterNodeSchema,
  GraphNodeSchema,
  HumanNodeSchema,
  FanoutNodeSchema,
  JoinNodeSchema,
]);
export type Node = z.infer<typeof NodeSchema>;

// ── Edge, limits, merge declarations ────────────────────────────────────

export const VerdictSchema = z.enum(["passed", "failed", "blocked", "cancelled", "limit-exceeded"]);
export type Verdict = z.infer<typeof VerdictSchema>;

export const EdgeSchema = z.object({
  from: NodeIdSchema,
  to: z.union([NodeIdSchema, z.array(NodeIdSchema)]),
  when: z.string().optional(), // condition expression
  on_error: z.union([NodeIdSchema, z.array(NodeIdSchema)]).optional(), // fallback
  retry: z
    .object({
      max: z.number().int().nonnegative(),
      on: z.array(VerdictSchema).default([]),
    })
    .optional(),
  verdict: VerdictSchema.optional(), // terminal edge
});
export type Edge = z.infer<typeof EdgeSchema>;

export const LimitsSchema = z.object({
  max_iterations: z.number().int().positive().optional(),
  max_workers: z.number().int().positive().optional(),
  max_failures: z.number().int().nonnegative().optional(),
});
export type Limits = z.infer<typeof LimitsSchema>;

export const MergePolicySchema = z.enum([
  "replace",
  "append",
  "append_unique",
  "first",
  "maximum",
  "minimum",
  "merge_object",
  "reject_conflict",
]);
export type MergePolicy = z.infer<typeof MergePolicySchema>;

export const MergeDeclarationSchema = z.object({
  merge: MergePolicySchema,
  identity: z.string().optional(), // append_unique uses the first accepted identity
});
export type MergeDeclaration = z.infer<typeof MergeDeclarationSchema>;

// ── Template manifest ───────────────────────────────────────────────────

export const TemplateManifestSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  apiVersion: z.literal("graphkit.dev/v1alpha1"),
  harness: z.enum(["claude"]).default("claude"),
});
export type TemplateManifest = z.infer<typeof TemplateManifestSchema>;

// ── Workflow ────────────────────────────────────────────────────────────

export const WorkflowSchema = z.object({
  apiVersion: z.literal("graphkit.dev/v1alpha1"),
  kind: z.literal("Workflow"),
  metadata: z.object({ name: z.string().min(1) }),
  inputs: z.record(z.string().min(1), z.unknown()).default({}),
  limits: LimitsSchema.default({}),
  state: z.record(z.string().min(1), MergeDeclarationSchema).optional(),
  nodes: z.record(NodeIdSchema, NodeSchema),
  start: NodeIdSchema,
  edges: z.array(EdgeSchema).default([]),
  terminal: z.array(z.object({ node: NodeIdSchema, verdict: VerdictSchema })).default([]),
});
export type Workflow = z.infer<typeof WorkflowSchema>;

// ── Run ─────────────────────────────────────────────────────────────────

export const RunStatusSchema = z.enum(["running", "paused", "done"]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const RunSchema = z.object({
  run_id: z.string().min(1),
  template: z.string().min(1).optional(),
  harness: z.enum(["claude"]).optional(),
  status: RunStatusSchema,
  current_nodes: z.array(NodeIdSchema).default([]),
  pending_items: z.array(z.string()).default([]),
  in_flight: z.record(z.string(), z.string()).default({}), // work_item -> lease id
  iteration: z.number().int().nonnegative().default(0),
  failures: z.number().int().nonnegative().default(0),
  completed_deterministic_nodes: z.array(NodeIdSchema).default([]),
  verdict: z.union([VerdictSchema, z.null()]).default(null),
});
export type Run = z.infer<typeof RunSchema>;

// ── Lease ───────────────────────────────────────────────────────────────

export const LeaseStatusSchema = z.enum(["active", "settled", "expired"]);
export type LeaseStatus = z.infer<typeof LeaseStatusSchema>;

export const LeaseSchema = z.object({
  id: z.string().min(1),
  work_item: z.string().min(1),
  node: NodeIdSchema,
  issued_at: z.string().min(1), // ISO timestamp
  expires_at: z.string().min(1), // ISO timestamp
  status: LeaseStatusSchema.default("active"),
});
export type Lease = z.infer<typeof LeaseSchema>;

// ── Event ───────────────────────────────────────────────────────────────

export const EventTypeSchema = z.enum(["dispatch", "submit", "reject", "command", "human", "error"]);
export type EventType = z.infer<typeof EventTypeSchema>;

export const EventSchema = z.object({
  type: EventTypeSchema,
  run_id: z.string().min(1),
  node: NodeIdSchema.optional(),
  lease: z.string().optional(),
  actor: z.string().optional(),
  timestamp: z.string().min(1), // ISO timestamp
  checkpoint: z.string().optional(),
  details: z.unknown().optional(),
});
export type Event = z.infer<typeof EventSchema>;
