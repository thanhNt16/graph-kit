/** Provider plane contracts — spec §3.1. All adapters go through injectable
 *  exec/fetch seams so tests run on recorded fixtures, never the network. */
import type { LaneKey } from "../config.js";

export type { LaneKey };

export interface IssueTask {
  id: string; // provider-opaque card id (board item id)
  key: string; // human key: "#412", "PROJ-123"
  title: string;
  description: string; // markdown body — the spec the agents work from
  labels: string[];
  lane: LaneKey | null; // null = card is in a column the config doesn't map
  sourceUrl: string;
  updatedAt: string; // ISO; used for "human moved it" detection
}

export interface CardComment {
  id: string;
  body: string;
  author: string;
  createdAt: string;
}

export interface IIssueBoardProvider {
  readonly kind: "local" | "github" | "gitlab" | "jira";
  getCardsInLane(lane: LaneKey): Promise<IssueTask[]>;
  getCard(id: string): Promise<IssueTask | null>;
  moveCardLane(id: string, lane: LaneKey): Promise<void>;
  /** Idempotent: if a comment carrying `marker` exists it is edited, not duplicated. */
  upsertComment(id: string, marker: string, markdown: string): Promise<{ commentId: string }>;
  listComments(id: string): Promise<CardComment[]>;
  addLabel(id: string, label: string): Promise<void>;
  removeLabel(id: string, label: string): Promise<void>;
  /** True when the halt label is present OR the card left the lane the factory last put it in. */
  isTaskHalted(id: string, expectedLane: LaneKey): Promise<boolean>;
}

export type CheckState = "pending" | "success" | "failure" | "none";

export interface IVCSProvider {
  readonly kind: "local" | "github" | "gitlab" | "bitbucket";
  pushBranch(worktreePath: string, branch: string): Promise<void>;
  /** Idempotent on sourceBranch: returns the existing open PR/MR if one exists. */
  openPullRequest(o: {
    sourceBranch: string;
    targetBranch: string;
    title: string;
    body: string;
    draft?: boolean;
  }): Promise<{ url: string; number: number }>;
  updatePullRequestBody(number: number, body: string): Promise<void>;
  getChecks(number: number): Promise<{ state: CheckState; failing: Array<{ name: string; url: string }> }>;
  mergePR(number: number, method: "squash" | "merge" | "rebase"): Promise<{ sha: string }>;
}

export interface Workspace {
  /** git worktree add .graphkit/factory/wt/<card> -b factory/<card> <base>; reuses an existing one. */
  ensure(cardId: string, baseBranch: string): Promise<{ path: string; branch: string }>;
  remove(cardId: string): Promise<void>;
}

/** Marker format embedded in every factory comment/PR body — upsert anchors
 *  and provenance. */
export function factoryMarker(cardId: string, lane: string, runId: string, kind: string): string {
  return `<!-- gk-factory card=${cardId} lane=${lane} run=${runId} kind=${kind} -->`;
}
