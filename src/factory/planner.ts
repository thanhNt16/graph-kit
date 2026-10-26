/** `planTick` — pure reconcile step: (config, journals, board snapshot, pid
 *  liveness, run terminals) → ordered actions. No I/O; the executor applies.
 *  Spec §3.6. */
import type { FactoryConfig, LaneKey } from "./config.js";
import type { CardJournal } from "./journal.js";
import type { IssueTask } from "./providers/types.js";

export type FactoryAction =
  | { kind: "mark_crashed"; card: string; note: string }
  | { kind: "halt_card"; card: string; kill: boolean }
  | { kind: "advance"; card: string; from: LaneKey; to: LaneKey; verdict?: "MERGE" | "BLOCK"; note?: string }
  | { kind: "bounce"; card: string; from: LaneKey; to: LaneKey; note: string }
  | { kind: "claim"; card: IssueTask }
  | { kind: "dispatch"; card: string; lane: LaneKey }
  | { kind: "comment"; card: string; marker_kind: string; markdown: string }
  | { kind: "merge_pr"; card: string; number: number }
  | { kind: "move_board"; card: string; to: LaneKey };

export interface TickInput {
  journals: CardJournal[];
  /** Cards currently on the board in any factory lane. */
  board: IssueTask[];
  /** pid → alive. */
  pidAlive: (pid: number) => boolean;
  /** run_id → has terminal gk run end (finished/failed). */
  runSettled: (runId: string) => boolean;
  /** run_id → journal verdict recorded in the ledger, if any. */
  runVerdict: (runId: string) => { verdict: "MERGE" | "BLOCK"; note?: string } | null;
  /** card → halted (label or human lane move). */
  halted: (card: string, expectedLane: LaneKey) => boolean;
}

/** Lane graph results flow: run verdict MERGE → lane.next; BLOCK → back to
 *  building (or blocked after max_rounds). */
function advanceTarget(cfg: FactoryConfig, lane: LaneKey): LaneKey | null {
  if (lane === "ready") return cfg.lanes.ready?.next ?? "building";
  if (lane === "building") return cfg.lanes.building.next;
  if (lane === "qa") return cfg.lanes.qa.next;
  if (lane === "review") return cfg.lanes.review.next;
  return null;
}

export function planTick(cfg: FactoryConfig, input: TickInput): FactoryAction[] {
  const actions: FactoryAction[] = [];
  const byCard = new Map(input.journals.map((j) => [j.card, j]));
  const onBoard = new Map(input.board.map((c) => [c.id, c]));

  // 1. Reconcile: running journals whose pid died without a terminal run end → crashed.
  for (const j of input.journals) {
    if (j.phase !== "running") continue;
    const pidDead = j.pid !== undefined && !input.pidAlive(j.pid);
    const settled = j.run_id !== undefined && input.runSettled(j.run_id);
    if (settled) {
      j.phase = "awaiting_advance"; // mutating planner-local copy is fine
    } else if (pidDead) {
      actions.push({ kind: "mark_crashed", card: j.card, note: "lane_crashed" });
      j.phase = "awaiting_advance";
    }
  }

  // 2. Halt sweep: in-flight cards that the human stopped. Includes
  //  awaiting_advance (a settled run must never advance past a halt).
  for (const j of input.journals) {
    if (j.phase === "parked" || j.phase === "blocked" || j.phase === "done") continue;
    if (input.halted(j.card, j.lane)) {
      actions.push({ kind: "halt_card", card: j.card, kill: j.phase === "running" });
      j.phase = "parked";
    }
  }

  // 3. Advance: settled runs → verdict → next lane / bounce / merge.
  for (const j of input.journals) {
    if (j.phase !== "awaiting_advance" || !j.run_id) continue;
    const result = input.runVerdict(j.run_id);
    if (!result) continue; // run settled but no verdict recorded — next tick
    const card = onBoard.get(j.card);
    if (!card) {
      actions.push({ kind: "comment", card: j.card, marker_kind: "orphan", markdown: "card no longer on board" });
      j.phase = "parked";
      continue;
    }
    const verdict = result.verdict;
    if (verdict === "BLOCK") {
      const next = j.round + 1;
      if (next > cfg.dispatch.max_rounds) {
        actions.push({ kind: "move_board", card: j.card, to: "blocked" });
        actions.push({ kind: "bounce", card: j.card, from: j.lane, to: "blocked", note: result.note ?? "max rounds" });
        j.phase = "blocked";
        continue;
      }
      actions.push({ kind: "move_board", card: j.card, to: "building" });
      actions.push({
        kind: "bounce",
        card: j.card,
        from: j.lane,
        to: "building",
        note: result.note ?? "verdict BLOCK",
      });
      actions.push({ kind: "dispatch", card: j.card, lane: "building" });
      j.round = next;
      continue;
    }
    const to = advanceTarget(cfg, j.lane);
    if (!to) {
      j.phase = "parked";
      continue;
    }
    if (to === "done" && j.pr && cfg.vcs.merge.auto) {
      actions.push({ kind: "merge_pr", card: j.card, number: j.pr.number });
    }
    actions.push({ kind: "move_board", card: j.card, to });
    actions.push({ kind: "advance", card: j.card, from: j.lane, to, verdict, note: result.note });
    if (to === "done") {
      j.phase = "done";
    } else {
      actions.push({ kind: "dispatch", card: j.card, lane: to });
    }
  }

  // 4. Claim: cards in ready lane, intake label, oldest first, up to capacity.
  const runningBuilding = input.journals.filter(
    (j) => (j.phase === "running" || j.phase === "claimed") && (j.lane === "building" || j.lane === "ready"),
  ).length;
  const cap = cfg.dispatch.max_parallel.building ?? 1;
  const slots = Math.max(0, cap - runningBuilding);
  if (slots > 0) {
    const eligible = input.board
      .filter((c) => c.lane === "ready" && !byCard.has(c.id))
      .filter((c) => cfg.board.intake_label === "" || c.labels.includes(cfg.board.intake_label))
      .slice(0, slots);
    for (const c of eligible) {
      actions.push({ kind: "claim", card: c });
      if (cfg.lanes.ready) {
        actions.push({ kind: "dispatch", card: c.id, lane: "ready" });
      } else {
        actions.push({ kind: "move_board", card: c.id, to: "building" });
        actions.push({ kind: "dispatch", card: c.id, lane: "building" });
      }
    }
  }
  return actions;
}
