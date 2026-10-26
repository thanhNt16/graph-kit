/** Per-card journal — `.graphkit/factory/cards/<id>.json`, atomic tmp+rename.
 *  Source of truth for *factory state* (the board owns *lane*). Spec §3.5. */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { GraphKitError } from "../errors.js";
import { LaneKeySchema } from "./config.js";

export const CardJournalSchema = z.object({
  card: z.string(),
  key: z.string(),
  provider: z.string(),
  lane: LaneKeySchema,
  phase: z.enum(["claimed", "running", "awaiting_advance", "parked", "blocked", "done"]),
  round: z.number().int().nonnegative().default(0),
  branch: z.string().optional(),
  worktree: z.string().optional(),
  pr: z.object({ number: z.number(), url: z.string() }).optional(),
  run_id: z.string().optional(),
  pid: z.number().optional(),
  history: z
    .array(
      z.object({
        at: z.string(),
        from: LaneKeySchema.nullable(),
        to: LaneKeySchema,
        run_id: z.string().optional(),
        verdict: z.enum(["MERGE", "BLOCK"]).optional(),
        note: z.string().optional(),
      }),
    )
    .default([]),
});
export type CardJournal = z.infer<typeof CardJournalSchema>;

export function journalDir(cwd: string): string {
  const dir = join(cwd, ".graphkit", "factory", "cards");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function journalPath(cwd: string, cardId: string): string {
  return join(journalDir(cwd), `${cardId}.json`);
}

export function loadJournal(cwd: string, cardId: string): CardJournal | null {
  const p = journalPath(cwd, cardId);
  if (!existsSync(p)) return null;
  const parsed = CardJournalSchema.safeParse(JSON.parse(readFileSync(p, "utf8")));
  if (!parsed.success) throw new GraphKitError("FACTORY_CONFIG", `corrupt journal ${p}`);
  return parsed.data;
}

/** Atomic write: tmp file + rename. */
export function saveJournal(cwd: string, j: CardJournal): void {
  const p = journalPath(cwd, j.card);
  const tmp = `${p}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(j, null, 2));
  renameSync(tmp, p);
}

export function listJournals(cwd: string): CardJournal[] {
  const dir = journalDir(cwd);
  const out: CardJournal[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    const parsed = CardJournalSchema.safeParse(JSON.parse(readFileSync(join(dir, f), "utf8")));
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

export function newJournal(card: { id: string; key: string }, provider: string): CardJournal {
  return {
    card: card.id,
    key: card.key,
    provider,
    lane: "ready",
    phase: "claimed",
    round: 0,
    history: [{ at: new Date().toISOString(), from: null, to: "ready" }],
  };
}

/** Append a lane transition. */
export function transition(
  j: CardJournal,
  to: CardJournal["lane"],
  extra?: { run_id?: string; verdict?: "MERGE" | "BLOCK"; note?: string },
): CardJournal {
  return {
    ...j,
    lane: to,
    history: [...j.history, { at: new Date().toISOString(), from: j.lane, to, ...extra }],
  };
}
