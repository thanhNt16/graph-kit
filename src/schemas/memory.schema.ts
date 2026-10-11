import { z } from "zod";

const MemoryDate = z.string().datetime({ offset: true });

/** Adherence lifecycle state for an adopted (learned) artifact. Counts are
 *  opportunity-relative: `use`/`view` are measured against recall invocations
 *  since `anchor`, never wall-clock, so idle time ages nothing out. */
export const AdherenceSchema = z.object({
  adopted_by: z.enum(["gk-learn", "human"]).default("gk-learn"),
  anchor: z.number().int().min(0).default(0), // request index at adoption
  use: z.number().int().min(0).default(0), // recall hit → loaded/followed (touchMemory bumps here)
  view: z.number().int().min(0).default(0), // surfaced in recall
  patch: z.number().int().min(0).default(0), // adopt-step revisions landed
  absorbed_into: z.string().trim().min(1).nullable().optional(),
});

export const MemoryFileSchema = z
  .object({
    id: z.string().trim().min(1),
    type: z.string().trim().min(1),
    source: z.string().optional(),
    created_at: MemoryDate.optional(),
    valid_from: MemoryDate.optional(),
    valid_to: MemoryDate.nullable().optional(),
    salience: z.number().optional(),
    expired: z.boolean().optional(),
    tags: z.array(z.string()).optional(),
    superseded_by: z.string().trim().min(1).nullable().optional(),
    generated: z.object({ by: z.string().min(1), at: MemoryDate }).optional(),
    recorded_at: MemoryDate.optional(),
    status: z.enum(["draft", "stable", "deprecated"]).optional(),
    sources: z.array(z.object({ resource: z.string().min(1) })).optional(),
    adherence: AdherenceSchema.optional(),
  })
  .passthrough();

export const PATTERN_KINDS = ["node-sequence", "failure-recurrence", "graph-reuse", "advisor-repeat"] as const;
export const SUGGESTION_ACTIONS = ["materialize-template", "capture-skill", "review-failure"] as const;

/** Derived pattern entries under .graphkit/memory/patterns/. */
export const PatternFileSchema = MemoryFileSchema.extend({
  type: z.literal("pattern"),
  kind: z.enum(PATTERN_KINDS),
  label: z.string().min(1),
  members: z.array(z.string()),
  runs: z.array(z.string()).min(1),
  count: z.number().int().min(1),
  last_seen: MemoryDate,
  signature: z.string().min(4),
  /** Provenance: every generated entry cites the ledger runs that produced it. */
  sources: z.array(z.object({ resource: z.string().min(1) })).min(1),
});

/** Actionable suggestions under .graphkit/memory/suggestions/. */
export const SuggestionFileSchema = MemoryFileSchema.extend({
  type: z.literal("suggestion"),
  action: z.enum(SUGGESTION_ACTIONS),
  rationale: z.string().min(1),
  based_on: z.array(z.string()).min(1),
  status: z.enum(["proposed", "accepted", "dismissed"]).default("proposed"),
  /** Provenance: every generated entry cites the ledger runs that produced it. */
  sources: z.array(z.object({ resource: z.string().min(1) })).min(1),
});

/** Adherence lifecycle policy for the store `gk learn` populates. Probation
 *  runs `maturity` requests past `anchor`; the mature pool is capped at
 *  `capacity` live items. */
export const MemoryLifecycleConfig = z.object({
  maturity: z.number().int().min(1).default(100), // probation: min requests since anchor
  capacity: z.number().int().min(1).default(50), // cap on mature live items
  graduation_suspended: z.boolean().default(false),
  expire_policy: z.enum(["act_r", "lifecycle"]).default("act_r"),
});

export const MemoryConfig = z
  .object({
    project: z.string().default("graph-kit-memory"),
    cadence: z.enum(["on_node_complete", "every"]).default("on_node_complete"),
    every: z.number().int().min(1).optional(),
    curator_node: z.string().default("curator"), // node id in graph.yaml bound to Memory Curator
    recall_topk: z.number().int().min(1).default(5),
    expire_policy: z.enum(["act_r", "manual"]).default("act_r"),
    null_intervention_allowed: z.boolean().default(true),
    lifecycle: MemoryLifecycleConfig.optional(),
  })
  .refine((c) => c.cadence !== "every" || (c.every ?? 0) >= 1, {
    message: "cadence 'every' requires every >= 1",
    path: ["every"],
  });

// MemoryConfigType deleted — zero consumers (fleet-compiler finding 4)
