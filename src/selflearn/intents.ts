// The staged-proposal queue — the reflector's ONLY emit path. `gk selflearn
// stage --intent <json>` validates the proposal and appends
// `.graphkit/selflearn/intents/<id>.json`; nothing lands at stage time.
// Landing is the promoter's job, gated by lint.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { GraphKitError } from "../errors.js";
import { descriptionFindings, frontmatter, STAGE_MAX_BODY_BYTES, structureFindings } from "./lint.js";
import { checkSafeId, intentsDir, writeTextAtomic } from "./state.js";

export const INTENT_KINDS = ["create", "update", "patch", "delete"] as const;
export type IntentKind = (typeof INTENT_KINDS)[number];

/** What the reflector stages. `body` = full SKILL.md text for
 *  create/update; `old`/`new` = unique-match delta for patch; delete carries
 *  neither. */
export const SelflearnIntentSchema = z
  .strictObject({
    kind: z.enum(INTENT_KINDS),
    target: z
      .string()
      .min(1)
      .max(120)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "target must be alphanumeric plus . _ -"),
    reason: z.string().min(1),
    evidence: z.string().min(1), // verbatim episode slice, >= 1 line
    body: z.string().optional(),
    old: z.string().optional(),
    new: z.string().optional(),
    absorbed_into: z.string().optional(), // delete only: umbrella that inherits the content
  })
  .superRefine((i, ctx) => {
    const hasBody = i.body !== undefined;
    const hasDelta = i.old !== undefined || i.new !== undefined;
    if (i.kind === "create" || i.kind === "update") {
      if (!hasBody || !i.body!.trim())
        ctx.addIssue({ code: "custom", path: ["body"], message: `${i.kind} requires body` });
      if (hasDelta) ctx.addIssue({ code: "custom", path: ["old"], message: `${i.kind} takes body, not old/new` });
      if (i.absorbed_into !== undefined)
        ctx.addIssue({ code: "custom", path: ["absorbed_into"], message: "absorbed_into is delete-only" });
    } else if (i.kind === "patch") {
      if (hasBody) ctx.addIssue({ code: "custom", path: ["body"], message: "patch takes old/new, not body" });
      if (i.old === undefined || i.new === undefined)
        ctx.addIssue({ code: "custom", path: ["old"], message: "patch requires both old and new" });
      if (i.absorbed_into !== undefined)
        ctx.addIssue({ code: "custom", path: ["absorbed_into"], message: "absorbed_into is delete-only" });
    } else {
      if (hasBody || hasDelta)
        ctx.addIssue({ code: "custom", path: ["body"], message: "delete takes no body/old/new" });
    }
  });

export type SelflearnIntent = z.infer<typeof SelflearnIntentSchema>;

const intentPath = (cwd: string, id: string) => join(intentsDir(cwd), `${id}.json`);
export const rejectedPath = (cwd: string, id: string) => join(intentsDir(cwd), `${id}.rejected.json`);

/** Stage-time front-checks the reflector can fix on the spot (mirrors
 *  autoharness stage_skill: schema + instant content checks only — the
 *  promoter's full lint remains the authority). */
export function stageContentErrors(intent: SelflearnIntent): string[] {
  const errors: string[] = [];
  const body = intent.body;
  if (body === undefined) return errors;
  if (Buffer.byteLength(body, "utf-8") > STAGE_MAX_BODY_BYTES)
    errors.push(`body exceeds ${STAGE_MAX_BODY_BYTES} bytes`);
  for (const f of structureFindings(body)) errors.push(`${f.family}: ${f.detail}`);
  if (intent.kind === "create" || intent.kind === "update") {
    const desc = frontmatter(body)?.description;
    if (desc) for (const f of descriptionFindings(desc)) errors.push(`${f.family}: ${f.detail}`);
  }
  return errors;
}

export function stageIntent(cwd: string, raw: unknown, session?: string): { id: string; file: string } {
  const parsed = SelflearnIntentSchema.safeParse(raw);
  if (!parsed.success) {
    throw new GraphKitError("SELFLEARN_INTENT", "intent failed validation", {
      issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    });
  }
  const errors = stageContentErrors(parsed.data);
  if (errors.length) throw new GraphKitError("SELFLEARN_INTENT", "intent content failed checks", { issues: errors });
  const id = `${session ? checkSafeId("session id", session) : "manual"}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  const file = intentPath(cwd, id);
  writeTextAtomic(file, JSON.stringify({ id, staged_at: new Date().toISOString(), ...parsed.data }, null, 2));
  return { id, file: file.slice(cwd.length + 1) };
}

export interface StagedIntent extends SelflearnIntent {
  id: string;
  staged_at: string;
}

export function listIntents(cwd: string, session?: string): StagedIntent[] {
  const dir = intentsDir(cwd);
  if (!existsSync(dir)) return [];
  const out: StagedIntent[] = [];
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith(".json") || f.endsWith(".rejected.json")) continue;
    try {
      const raw = JSON.parse(readFileSync(join(dir, f), "utf-8")) as StagedIntent;
      if (session !== undefined && !raw.id.startsWith(`${checkSafeId("session id", session)}-`)) continue;
      out.push(raw);
    } catch {
      /* unparseable intent: left in place for manual inspection */
    }
  }
  return out;
}
