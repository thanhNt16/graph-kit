import { z } from "zod";
import { TIERS } from "../targets/types.js";

export const LlmAsJudge = z.strictObject({
  enabled: z.boolean().default(false),
  refuters: z.array(z.string()).default([]),
  survive_threshold: z.number().int().min(1).default(2),
  model: z.enum(TIERS).default("sonnet"),
  seed: z.number().int().default(1),
});

export const EvalConfig = z.strictObject({
  mode: z.enum(["work_product", "memory", "both"]).default("work_product"),
  rubric: z.enum(["strict", "lenient"]).default("strict"),
  abstention_weighted: z.boolean().default(true),
  llm_as_judge: LlmAsJudge.optional(),
});
