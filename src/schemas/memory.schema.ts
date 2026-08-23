import { z } from "zod";

const MemoryDate = z.string().datetime({ offset: true });

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
  })
  .passthrough();

export const MemoryConfig = z
  .object({
    project: z.string().default("graph-kit-memory"),
    cadence: z.enum(["on_node_complete", "every"]).default("on_node_complete"),
    every: z.number().int().min(1).optional(),
    curator_node: z.string().default("curator"), // node id in graph.yaml bound to Memory Curator
    recall_topk: z.number().int().min(1).default(5),
    expire_policy: z.enum(["act_r", "manual"]).default("act_r"),
    null_intervention_allowed: z.boolean().default(true),
  })
  .refine((c) => c.cadence !== "every" || (c.every ?? 0) >= 1, {
    message: "cadence 'every' requires every >= 1",
    path: ["every"],
  });

// MemoryConfigType deleted — zero consumers (fleet-compiler finding 4)
