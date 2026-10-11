import { z } from "zod";

/**
 * `.graphkit/learn/<id>.yaml` — a continual-learning proposal. The stored
 * contract for `gk learn propose/evaluate/adopt/reject/revert`: every field
 * is written explicitly on create (nulls included) so the file reads as a
 * complete state machine snapshot.
 */
export const CriterionVerdictSchema = z.strictObject({
  criterion: z.string().min(1),
  pass: z.boolean(),
  note: z.string().optional(),
});

export const LearnFixSchema = z.strictObject({
  kind: z.enum(["patch", "command"]),
  value: z.string().min(1),
});

export const LearnEvaluationSchema = z.strictObject({
  at: z.string().min(1),
  // Repo-relative evidence dir the verdicts were read from (null when the
  // proposal has no source case to resolve one from).
  evidence_dir: z.string().nullable(),
  verdicts: z.array(CriterionVerdictSchema),
  // Verdicts re-run inside a temp worktree after applying `fix` — null when
  // the proposal carries no fix.
  after_fix: z.array(CriterionVerdictSchema).nullable(),
});

export const LearnProposalSchema = z.strictObject({
  id: z.string().min(1),
  created: z.string().min(1),
  source_run: z.string().min(1),
  // Path to the promoted scenario case.yaml (repo-relative), auto-discovered
  // under scenarios/promoted/ — null when the run was never promoted.
  source_case: z.string().nullable(),
  hypothesis: z.string(),
  proposal_kind: z.enum(["skill", "check", "graph", "procedure"]),
  // What adoption installs; today only skill installs are materialized.
  proposes: z.strictObject({ skill_path: z.string().nullable() }).nullable(),
  // A fix the proposing agent recorded for evaluate to rehearse in a worktree.
  fix: LearnFixSchema.nullable(),
  status: z.enum(["proposed", "evaluated", "adopted", "rejected", "reverted"]),
  evaluation: LearnEvaluationSchema.nullable(),
  adopted: z
    .strictObject({
      at: z.string().min(1),
      installed: z.array(z.string()),
      // "ok" | "failed:<err>" | "needed" (no generator found) | "skipped"
      kit_regen: z.string(),
      // The learned artifact landed in the memory store (.graphkit/memory/<id>.md).
      artifact: z.string().optional(),
    })
    .nullable(),
  rejected: z.strictObject({ at: z.string().min(1), reason: z.string().nullable() }).nullable(),
  reverted: z.strictObject({ at: z.string().min(1) }).nullable(),
});

export type LearnProposal = z.infer<typeof LearnProposalSchema>;
export type CriterionVerdict = z.infer<typeof CriterionVerdictSchema>;

/** The slice of a promoted scenario `case.yaml` learn reads back. */
export const SourceCaseSchema = z.object({
  failed_criteria: z.array(z.string()).default([]),
  input: z.object({ required_keys: z.array(z.string()).default([]) }).default({ required_keys: [] }),
});

export type SourceCase = z.infer<typeof SourceCaseSchema>;
