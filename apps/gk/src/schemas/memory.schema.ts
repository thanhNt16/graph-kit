import { z } from "zod";

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

export type MemoryConfigType = z.infer<typeof MemoryConfig>;
