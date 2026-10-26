/** Factory dispatcher — applies planTick actions and owns every provider side
 *  effect (moves, comments, pushes, PRs, merges). `gk factory tick` = one
 *  reconcile pass; `gk factory run` = loop until quiescent. Spec §3.6. */
import { join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import type { FactoryConfig, LaneKey } from "./config.js";
import {
  type CardJournal,
  listJournals,
  loadJournal,
  newJournal,
  saveJournal,
  transition,
} from "./journal.js";
import {
  type LaneOutcome,
  type LaneRunnerDeps,
  loadRunRecord,
  runLane,
  saveRunRecord,
} from "./lane-runner.js";
import { planTick } from "./planner.js";
import {
  factoryMarker,
  type IIssueBoardProvider,
  type IVCSProvider,
  type IssueTask,
  type Workspace,
} from "./providers/types.js";

export interface Providers {
  board: IIssueBoardProvider;
  vcs: IVCSProvider;
  workspace: Workspace;
}

export interface TickDeps extends LaneRunnerDeps {
  /** Inject for tests; default process.kill(pid, 0) liveness. */
  pidAlive?: (pid: number) => boolean;
  /** Run lane synchronously; injectable for tests. */
  runLane?: typeof runLane;
}

function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export interface TickResult {
  actions: number;
  ran: Array<{ card: string; lane: LaneKey; verdict: string }>;
}

function markerBody(kind: string, markdown: string): string {
  return markdown;
}

/** One reconcile pass. Synchronous lanes (v1): a `dispatch` action runs the
 *  lane now and records the run — the next tick advances it. */
export async function tick(cwd: string, cfg: FactoryConfig, providers: Providers, deps: TickDeps): Promise<TickResult> {
  const journals = listJournals(cwd);
  const lanes = ["ready", "building", "qa", "review", "blocked", "done"] as const;
  const boardCards: IssueTask[] = [];
  for (const l of lanes) {
    boardCards.push(...(await providers.board.getCardsInLane(l)));
  }
  const pidAlive = deps.pidAlive ?? defaultPidAlive;
  const runner = deps.runLane ?? runLane;

  const actions = planTick(cfg, {
    journals,
    board: boardCards,
    pidAlive,
    runSettled: (runId) => {
      const rec = loadRunRecord(cwd, runId);
      return rec !== null && (rec.verdict !== null || rec.crashed === true);
    },
    runVerdict: (runId) => {
      const rec = loadRunRecord(cwd, runId);
      if (!rec || rec.verdict == null) return null;
      return { verdict: rec.verdict, note: rec.note };
    },
    halted: (card, expectedLane) => {
      const j = loadJournal(cwd, card);
      void j;
      // board-level halt check runs sync via cached card state
      const c = boardCards.find((x) => x.id === card);
      if (!c) return true;
      return c.labels.includes(cfg.board.halt_label) || c.lane !== expectedLane;
    },
  });

  const ran: Array<{ card: string; lane: LaneKey; verdict: string }> = [];
  const boardById = new Map(boardCards.map((c) => [c.id, c]));

  for (const a of actions) {
    switch (a.kind) {
      case "claim": {
        const j = newJournal({ id: a.card.id, key: a.card.key }, providers.board.kind);
        saveJournal(cwd, j);
        await providers.board.upsertComment(
          a.card.id,
          factoryMarker(a.card.id, "ready", "-", "claim"),
          markerBody("claim", `Factory claimed this card (${a.card.key}).`),
        );
        break;
      }
      case "dispatch": {
        const j = loadJournal(cwd, a.card);
        const card = boardById.get(a.card) ?? (await providers.board.getCard(a.card));
        if (!j || !card) break;
        j.phase = "running";
        j.lane = a.lane;
        saveJournal(cwd, j);
        const outcome: LaneOutcome = await runner(cwd, cfg, card, j, a.lane, deps);
        const j2 = loadJournal(cwd, a.card) ?? j;
        j2.run_id = outcome.run_id;
        j2.worktree = join(cwd, ".graphkit", "factory", "wt", a.card);
        j2.branch = `${cfg.vcs.branch_prefix}${a.card}`;
        saveJournal(cwd, j2);
        saveRunRecord(cwd, {
          run_id: outcome.run_id,
          card: a.card,
          lane: a.lane,
          at: new Date().toISOString(),
          verdict: outcome.verdict,
          note: outcome.note,
          blocked_calls: outcome.blocked_calls,
          events_path: outcome.events_path,
        });
        ran.push({ card: a.card, lane: a.lane, verdict: outcome.verdict });
        break;
      }
      case "advance": {
        const j = loadJournal(cwd, a.card);
        if (!j) break;
        const j2 = transition(j, a.to, { run_id: j.run_id, verdict: a.verdict, note: a.note });
        j2.phase = a.to === "done" ? "done" : "claimed";
        j2.run_id = undefined;
        saveJournal(cwd, j2);
        await providers.board.upsertComment(
          a.card,
          factoryMarker(a.card, a.from, j.run_id ?? "-", "advance"),
          markerBody("advance", `Lane **${a.from}** → **${a.to}** (verdict ${a.verdict ?? "?"}${a.note ? ` — ${a.note}` : ""}).`),
        );
        if (a.to === "review" || (a.to === "done" && cfg.vcs.merge)) {
          // ensure PR exists once review is entered / done reached
          const j3 = loadJournal(cwd, a.card);
          if (j3?.branch && !j3.pr) {
            const pr = await providers.vcs.openPullRequest({
              sourceBranch: j3.branch,
              targetBranch: cfg.vcs.base_branch,
              title: `${j3.key}: ${boardById.get(a.card)?.title ?? j3.key}`,
              body: `${factoryMarker(a.card, "review", "-", "pr")}\nFactory PR for ${j3.key}.`,
              draft: true,
            });
            j3.pr = pr;
            saveJournal(cwd, j3);
          }
        }
        break;
      }
      case "bounce": {
        const j = loadJournal(cwd, a.card);
        if (!j) break;
        const j2 = transition(j, a.to, { run_id: j.run_id, verdict: "BLOCK", note: a.note });
        j2.phase = a.to === "blocked" ? "blocked" : "claimed";
        j2.run_id = undefined;
        j2.round = j2.round + 1;
        saveJournal(cwd, j2);
        await providers.board.upsertComment(
          a.card,
          factoryMarker(a.card, a.from, j.run_id ?? "-", "block"),
          markerBody("block", `Lane **${a.from}** BLOCK → ${a.to}: ${a.note}`),
        );
        break;
      }
      case "move_board": {
        await providers.board.moveCardLane(a.card, a.to);
        break;
      }
      case "mark_crashed": {
        const j = loadJournal(cwd, a.card);
        if (!j) break;
        j.phase = "awaiting_advance";
        saveJournal(cwd, j);
        if (j.run_id) {
          saveRunRecord(cwd, {
            run_id: j.run_id,
            card: a.card,
            lane: j.lane,
            at: new Date().toISOString(),
            verdict: "BLOCK",
            note: a.note,
            crashed: true,
          });
        }
        break;
      }
      case "halt_card": {
        const j = loadJournal(cwd, a.card);
        if (j) {
          j.phase = "parked";
          saveJournal(cwd, j);
        }
        await providers.board.upsertComment(
          a.card,
          factoryMarker(a.card, j?.lane ?? "ready", j?.run_id ?? "-", "halt"),
          "Factory halted — `factory:halt` label or manual lane move detected.",
        );
        break;
      }
      case "merge_pr": {
        const { sha } = await providers.vcs.mergePR(a.number, cfg.vcs.merge.method);
        await providers.board.upsertComment(
          a.card,
          factoryMarker(a.card, "review", "-", "merge"),
          `Merged as ${sha}.`,
        );
        break;
      }
      case "comment": {
        await providers.board.upsertComment(
          a.card,
          factoryMarker(a.card, "blocked", "-", a.marker_kind),
          a.markdown,
        );
        break;
      }
    }
  }
  return { actions: actions.length, ran };
}

/** Loop ticks until no actions remain (bounded by maxTicks). */
export async function runFactory(
  cwd: string,
  cfg: FactoryConfig,
  providers: Providers,
  deps: TickDeps,
  maxTicks = 20,
): Promise<TickResult[]> {
  const results: TickResult[] = [];
  for (let i = 0; i < maxTicks; i++) {
    const r = await tick(cwd, cfg, providers, deps);
    results.push(r);
    if (r.actions === 0) break;
  }
  return results;
}

export function factoryDir(cwd: string): string {
  const d = join(cwd, ".graphkit", "factory");
  mkdirSync(d, { recursive: true });
  return d;
}
