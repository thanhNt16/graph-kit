/** File-backed board + git-local VCS providers — the offline end-to-end
 *  substrate (spec §3.1 adapter matrix, "local" column).
 *
 *  Board: `.graphkit/factory/board/<cardId>.yaml` — one YAML doc per card:
 *    id, key, title, description, labels[], lane, comments[],
 *    expectedLane (what the factory last set), updatedAt.
 *  VCS: push = no-op; openPullRequest = record in `.graphkit/factory/prs.json`
 *  with a monotonic number; merge = `git merge --squash`/`--no-ff` of the
 *  lane branch into base_branch inside the main checkout. */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { GraphKitError } from "../../errors.js";
import type { LaneKey } from "../config.js";
import type { CardComment, CheckState, IIssueBoardProvider, IssueTask, IVCSProvider, Workspace } from "./types.js";

interface StoredCard {
  id: string;
  key: string;
  title: string;
  description: string;
  labels: string[];
  lane: LaneKey | null;
  expectedLane: LaneKey | null;
  comments: Array<CardComment & { marker?: string }>;
  updatedAt: string;
}

export class LocalBoardProvider implements IIssueBoardProvider {
  readonly kind = "local" as const;

  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  static defaultDir(cwd: string): string {
    return join(cwd, ".graphkit", "factory", "board");
  }

  private path(id: string): string {
    return join(this.dir, `${id}.yaml`);
  }

  private load(id: string): StoredCard | null {
    const p = this.path(id);
    if (!existsSync(p)) return null;
    return YAML.parse(readFileSync(p, "utf8")) as StoredCard;
  }

  private save(card: StoredCard): void {
    card.updatedAt = new Date().toISOString();
    writeFileSync(this.path(card.id), YAML.stringify(card));
  }

  /** Create a card (used by `gk factory card add` and tests). */
  create(o: { key: string; title: string; description?: string; labels?: string[]; lane?: LaneKey }): IssueTask {
    const id = `card-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const card: StoredCard = {
      id,
      key: o.key,
      title: o.title,
      description: o.description ?? "",
      labels: o.labels ?? [],
      lane: o.lane ?? "ready",
      expectedLane: o.lane ?? "ready",
      comments: [],
      updatedAt: new Date().toISOString(),
    };
    this.save(card);
    return this.toTask(card);
  }

  async getCardsInLane(lane: LaneKey): Promise<IssueTask[]> {
    const out: IssueTask[] = [];
    if (!existsSync(this.dir)) return out;
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith(".yaml")) continue;
      const card = YAML.parse(readFileSync(join(this.dir, f), "utf8")) as StoredCard;
      if (card.lane === lane) out.push(this.toTask(card));
    }
    return out.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  }

  async getCard(id: string): Promise<IssueTask | null> {
    const card = this.load(id);
    return card ? this.toTask(card) : null;
  }

  async moveCardLane(id: string, lane: LaneKey): Promise<void> {
    const card = this.load(id);
    if (!card) throw new GraphKitError("FACTORY_PROVIDER", `card ${id} not found`);
    card.lane = lane;
    card.expectedLane = lane;
    this.save(card);
  }

  async upsertComment(id: string, marker: string, markdown: string): Promise<{ commentId: string }> {
    const card = this.load(id);
    if (!card) throw new GraphKitError("FACTORY_PROVIDER", `card ${id} not found`);
    const body = `${marker}\n${markdown}`;
    const existing = card.comments.find((c) => c.marker === marker || c.body.includes(marker));
    if (existing) {
      existing.body = body;
      existing.marker = marker;
      this.save(card);
      return { commentId: existing.id };
    }
    const comment = {
      id: `cmt-${Date.now().toString(36)}`,
      body,
      author: "gk-factory",
      createdAt: new Date().toISOString(),
      marker,
    };
    card.comments.push(comment);
    this.save(card);
    return { commentId: comment.id };
  }

  async listComments(id: string): Promise<CardComment[]> {
    return this.load(id)?.comments ?? [];
  }

  async addLabel(id: string, label: string): Promise<void> {
    const card = this.load(id);
    if (!card) throw new GraphKitError("FACTORY_PROVIDER", `card ${id} not found`);
    if (!card.labels.includes(label)) card.labels.push(label);
    this.save(card);
  }

  async removeLabel(id: string, label: string): Promise<void> {
    const card = this.load(id);
    if (!card) throw new GraphKitError("FACTORY_PROVIDER", `card ${id} not found`);
    card.labels = card.labels.filter((l) => l !== label);
    this.save(card);
  }

  async isTaskHalted(id: string, expectedLane: LaneKey): Promise<boolean> {
    const card = this.load(id);
    if (!card) return true;
    return card.labels.includes("factory:halt") || card.lane !== expectedLane;
  }

  private toTask(card: StoredCard): IssueTask {
    return {
      id: card.id,
      key: card.key,
      title: card.title,
      description: card.description,
      labels: card.labels,
      lane: card.lane,
      sourceUrl: `local://${card.id}`,
      updatedAt: card.updatedAt,
    };
  }
}

interface LocalPR {
  number: number;
  url: string;
  sourceBranch: string;
  targetBranch: string;
  title: string;
  body: string;
  draft: boolean;
  state: "open" | "merged";
}

/** Local VCS: branches live in the repo; "PRs" are records in
 *  `.graphkit/factory/prs.json`; merge = git merge of the lane branch into
 *  base_branch in the main checkout. `exec` is injectable for tests. */
export class LocalVCSProvider implements IVCSProvider {
  readonly kind = "local" as const;

  constructor(
    private repoDir: string,
    private exec: (args: string[], cwd: string) => string = (args, cwd) =>
      execFileSync("git", args, { cwd, encoding: "utf8" }).trim(),
  ) {}

  private prsPath(): string {
    const p = join(this.repoDir, ".graphkit", "factory");
    mkdirSync(p, { recursive: true });
    return join(p, "prs.json");
  }

  private prs(): LocalPR[] {
    const p = this.prsPath();
    return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as LocalPR[]) : [];
  }

  private savePrs(prs: LocalPR[]): void {
    writeFileSync(this.prsPath(), JSON.stringify(prs, null, 2));
  }

  async pushBranch(_worktreePath: string, _branch: string): Promise<void> {
    // Local provider: the branch already lives in the repo — nothing to push.
  }

  async openPullRequest(o: {
    sourceBranch: string;
    targetBranch: string;
    title: string;
    body: string;
    draft?: boolean;
  }): Promise<{ url: string; number: number }> {
    const prs = this.prs();
    const existing = prs.find((p) => p.sourceBranch === o.sourceBranch && p.state === "open");
    if (existing) return { url: existing.url, number: existing.number };
    const number = prs.reduce((m, p) => Math.max(m, p.number), 0) + 1;
    const url = `local://pr/${number}`;
    prs.push({
      number,
      url,
      sourceBranch: o.sourceBranch,
      targetBranch: o.targetBranch,
      title: o.title,
      body: o.body,
      draft: o.draft ?? false,
      state: "open",
    });
    this.savePrs(prs);
    return { url, number };
  }

  async updatePullRequestBody(number: number, body: string): Promise<void> {
    const prs = this.prs();
    const pr = prs.find((p) => p.number === number);
    if (!pr) throw new GraphKitError("FACTORY_PROVIDER", `pr ${number} not found`);
    pr.body = body;
    this.savePrs(prs);
  }

  async getChecks(_number: number): Promise<{ state: CheckState; failing: Array<{ name: string; url: string }> }> {
    return { state: "none", failing: [] };
  }

  async mergePR(number: number, method: "squash" | "merge" | "rebase"): Promise<{ sha: string }> {
    const prs = this.prs();
    const pr = prs.find((p) => p.number === number);
    if (!pr) throw new GraphKitError("FACTORY_PROVIDER", `pr ${number} not found`);
    if (pr.state === "merged") {
      return { sha: this.exec(["rev-parse", pr.targetBranch], this.repoDir) };
    }
    if (method === "squash") {
      this.exec(["checkout", pr.targetBranch], this.repoDir);
      this.exec(["merge", "--squash", pr.sourceBranch], this.repoDir);
      this.exec(["commit", "-m", `${pr.title} (#${pr.number})`], this.repoDir);
    } else {
      this.exec(["checkout", pr.targetBranch], this.repoDir);
      this.exec(["merge", "--no-ff", pr.sourceBranch, "-m", `${pr.title} (#${pr.number})`], this.repoDir);
    }
    pr.state = "merged";
    this.savePrs(prs);
    return { sha: this.exec(["rev-parse", "HEAD"], this.repoDir) };
  }
}

/** Local workspace: `git worktree add .graphkit/factory/wt/<card> -b
 *  factory/<card> <base>`; reuses an existing one. */
export class LocalWorkspace implements Workspace {
  constructor(
    private repoDir: string,
    private branchPrefix = "factory/",
    private exec: (args: string[], cwd: string) => string = (args, cwd) =>
      execFileSync("git", args, { cwd, encoding: "utf8" }).trim(),
  ) {}

  wtDir(): string {
    return join(this.repoDir, ".graphkit", "factory", "wt");
  }

  async ensure(cardId: string, baseBranch: string): Promise<{ path: string; branch: string }> {
    const branch = `${this.branchPrefix}${cardId}`;
    const path = join(this.wtDir(), cardId);
    mkdirSync(this.wtDir(), { recursive: true });
    if (existsSync(join(path, ".git"))) return { path, branch };
    const existing = this.exec(["branch", "--list", branch], this.repoDir);
    if (existing) {
      this.exec(["worktree", "add", path, branch], this.repoDir);
    } else {
      this.exec(["worktree", "add", path, "-b", branch, baseBranch], this.repoDir);
    }
    return { path, branch };
  }

  async remove(cardId: string): Promise<void> {
    const path = join(this.wtDir(), cardId);
    if (!existsSync(path)) return;
    this.exec(["worktree", "remove", "--force", path], this.repoDir);
  }
}
