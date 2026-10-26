/** GitHub adapters — board = Projects v2 single-select Status field (driven
 *  via the `gh` CLI: `gh project item-list/item-edit`), cards = issues;
 *  VCS = `gh pr`/`gh api`/`gh pr checks`. The `exec` seam takes (args, opts)
 *  → stdout string; tests inject a fixture-backed fake — no network. */
import { GraphKitError } from "../../errors.js";
import type { LaneKey } from "../config.js";
import type { CardComment, CheckState, IIssueBoardProvider, IssueTask, IVCSProvider } from "./types.js";

/** argv including the binary — providers call `gh ...` for API/PR work and
 *  `git -C <wt> push` for the branch push. */
export type GhExec = (argv: string[]) => string;

export interface GitHubBoardConfig {
  owner: string;
  repo: string;
  project_number: number;
  status_field: string; // e.g. "Status"
  /** LaneKey → Status option name (from cfg.board.lanes). */
  lanes: Record<LaneKey, string>;
  halt_label: string;
}

interface ProjectItem {
  id: string; // item node id
  title: string;
  status?: string;
  content?: { type?: string; number?: number; repository?: string; title?: string; body?: string; url?: string };
  labels?: Array<{ name: string }>;
  updatedAt?: string;
}

interface ProjectsListShape {
  items?: ProjectItem[];
}

interface IssueShape {
  number: number;
  title: string;
  body?: string;
  labels?: Array<{ name?: string }>;
  url?: string;
  updated_at?: string;
}

export class GitHubBoardProvider implements IIssueBoardProvider {
  readonly kind = "github" as const;

  constructor(
    private cfg: GitHubBoardConfig,
    private exec: GhExec,
  ) {}

  private statusToLane(status: string | undefined): LaneKey | null {
    if (status === undefined) return null;
    for (const [lane, name] of Object.entries(this.cfg.lanes)) {
      if (name === status) return lane as LaneKey;
    }
    return null;
  }

  private laneToStatus(lane: LaneKey): string {
    const name = this.cfg.lanes[lane];
    if (!name) throw new GraphKitError("FACTORY_CONFIG", `no status mapping for lane ${lane}`);
    return name;
  }

  /** All items with their status, one `gh project item-list` call. */
  private async items(): Promise<ProjectItem[]> {
    const out = this.exec([
      "gh",
      "project",
      "item-list",
      String(this.cfg.project_number),
      "--owner",
      this.cfg.owner,
      "--format",
      "json",
      "--limit",
      "500",
    ]);
    const parsed = JSON.parse(out) as ProjectsListShape;
    return parsed.items ?? [];
  }

  private async issueFor(item: ProjectItem): Promise<IssueShape | null> {
    const n = item.content?.number;
    if (n === undefined) return null;
    const out = this.exec([
      "gh",
      "api",
      `repos/${this.cfg.owner}/${this.cfg.repo}/issues/${n}`,
      "--jq",
      "{number,title,body,labels,url:html_url,updated_at}",
    ]);
    return JSON.parse(out) as IssueShape;
  }

  private async toTask(item: ProjectItem): Promise<IssueTask> {
    const issue = (await this.issueFor(item)) ?? {
      number: item.content?.number ?? 0,
      title: item.title ?? "",
      body: "",
      labels: item.labels ?? [],
      url: item.content?.url ?? "",
      updated_at: item.updatedAt ?? "",
    };
    return {
      id: item.id,
      key: issue.number ? `#${issue.number}` : item.id,
      title: issue.title,
      description: issue.body ?? "",
      labels: (issue.labels ?? []).map((l) => l.name ?? "").filter(Boolean),
      lane: this.statusToLane(item.status),
      sourceUrl: issue.url ?? "",
      updatedAt: issue.updated_at ?? item.updatedAt ?? "",
    };
  }

  private async findItem(id: string): Promise<ProjectItem | null> {
    const items = await this.items();
    return items.find((i) => i.id === id) ?? null;
  }

  private statusFieldId(): string {
    const out = this.exec([
      "gh",
      "project",
      "field-list",
      String(this.cfg.project_number),
      "--owner",
      this.cfg.owner,
      "--format",
      "json",
    ]);
    const fields =
      (
        JSON.parse(out) as {
          fields?: Array<{
            id?: string;
            name?: string;
            type?: string;
            options?: Array<{ id?: string; name?: string }>;
          }>;
        }
      ).fields ?? [];
    const f = fields.find((f) => f.name === this.cfg.status_field);
    if (!f?.id) throw new GraphKitError("FACTORY_PROVIDER", `project field "${this.cfg.status_field}" not found`);
    return f.id;
  }

  private statusOptionId(fieldId: string, lane: LaneKey): string {
    const out = this.exec([
      "gh",
      "project",
      "field-list",
      String(this.cfg.project_number),
      "--owner",
      this.cfg.owner,
      "--format",
      "json",
    ]);
    const fields =
      (JSON.parse(out) as { fields?: Array<{ id?: string; options?: Array<{ id?: string; name?: string }> }> })
        .fields ?? [];
    const f = fields.find((f) => f.id === fieldId);
    const opt = f?.options?.find((o) => o.name === this.laneToStatus(lane));
    if (!opt?.id)
      throw new GraphKitError(
        "FACTORY_PROVIDER",
        `no option "${this.laneToStatus(lane)}" on field ${this.cfg.status_field}`,
      );
    return opt.id;
  }

  private projectId(): string {
    const out = this.exec(["gh", "project", "list", "--owner", this.cfg.owner, "--format", "json"]);
    const projects = (JSON.parse(out) as { projects?: Array<{ id?: string; number?: number }> }).projects ?? [];
    const p = projects.find((p) => p.number === this.cfg.project_number);
    if (!p?.id) throw new GraphKitError("FACTORY_PROVIDER", `project ${this.cfg.project_number} not found`);
    return p.id;
  }

  async getCardsInLane(lane: LaneKey): Promise<IssueTask[]> {
    const items = await this.items();
    const out: IssueTask[] = [];
    for (const item of items) {
      if (this.statusToLane(item.status) === lane) out.push(await this.toTask(item));
    }
    return out.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  }

  async getCard(id: string): Promise<IssueTask | null> {
    const item = await this.findItem(id);
    return item ? this.toTask(item) : null;
  }

  async moveCardLane(id: string, lane: LaneKey): Promise<void> {
    const fieldId = this.statusFieldId();
    const optionId = this.statusOptionId(fieldId, lane);
    this.exec([
      "gh",
      "project",
      "item-edit",
      "--project-id",
      this.projectId(),
      "--id",
      id,
      "--field-id",
      fieldId,
      "--single-select-option-id",
      optionId,
    ]);
  }

  private async issueNumberOf(id: string): Promise<number> {
    const item = await this.findItem(id);
    const n = item?.content?.number;
    if (n === undefined) throw new GraphKitError("FACTORY_PROVIDER", `card ${id} has no issue number`);
    return n;
  }

  async upsertComment(id: string, marker: string, markdown: string): Promise<{ commentId: string }> {
    const n = await this.issueNumberOf(id);
    const body = `${marker}\n${markdown}`;
    const listOut = this.exec([
      "gh",
      "api",
      `repos/${this.cfg.owner}/${this.cfg.repo}/issues/${n}/comments?per_page=100`,
    ]);
    const comments = JSON.parse(listOut) as Array<{ id: number; body?: string }>;
    const existing = comments.find((c) => c.body?.includes(marker));
    if (existing) {
      this.exec([
        "gh",
        "api",
        "-X",
        "PATCH",
        `repos/${this.cfg.owner}/${this.cfg.repo}/issues/comments/${existing.id}`,
        "-f",
        `body=${body}`,
      ]);
      return { commentId: String(existing.id) };
    }
    const created = this.exec([
      "gh",
      "api",
      `repos/${this.cfg.owner}/${this.cfg.repo}/issues/${n}/comments`,
      "-f",
      `body=${body}`,
    ]);
    const parsed = JSON.parse(created) as { id: number };
    return { commentId: String(parsed.id) };
  }

  async listComments(id: string): Promise<CardComment[]> {
    const n = await this.issueNumberOf(id);
    const out = this.exec(["gh", "api", `repos/${this.cfg.owner}/${this.cfg.repo}/issues/${n}/comments?per_page=100`]);
    const comments = JSON.parse(out) as Array<{
      id: number;
      body?: string;
      user?: { login?: string };
      created_at?: string;
    }>;
    return comments.map((c) => ({
      id: String(c.id),
      body: c.body ?? "",
      author: c.user?.login ?? "",
      createdAt: c.created_at ?? "",
    }));
  }

  async addLabel(id: string, label: string): Promise<void> {
    const n = await this.issueNumberOf(id);
    this.exec([
      "gh",
      "api",
      "-X",
      "POST",
      `repos/${this.cfg.owner}/${this.cfg.repo}/issues/${n}/labels`,
      "-f",
      `labels[]=${label}`,
    ]);
  }

  async removeLabel(id: string, label: string): Promise<void> {
    const n = await this.issueNumberOf(id);
    try {
      this.exec([
        "gh",
        "api",
        "-X",
        "DELETE",
        `repos/${this.cfg.owner}/${this.cfg.repo}/issues/${n}/labels/${encodeURIComponent(label)}`,
      ]);
    } catch {
      /* 404 = label absent — removal is idempotent */
    }
  }

  async isTaskHalted(id: string, expectedLane: LaneKey): Promise<boolean> {
    const item = await this.findItem(id);
    if (!item) return true;
    if (this.statusToLane(item.status) !== expectedLane) return true;
    const task = await this.toTask(item);
    return task.labels.includes(this.cfg.halt_label);
  }
}

/** gh-based VCS: `gh pr create/view/checks/merge`. */
export class GitHubVCSProvider implements IVCSProvider {
  readonly kind = "github" as const;

  constructor(
    private repo: { owner: string; name: string },
    private exec: GhExec,
  ) {}

  private repoSlug(): string {
    return `${this.repo.owner}/${this.repo.name}`;
  }

  async pushBranch(worktreePath: string, branch: string): Promise<void> {
    this.exec(["git", "-C", worktreePath, "push", "-u", "origin", branch, "--force-with-lease"]);
  }

  private prFor(branch: string): { number: number; url: string } | null {
    let out: string;
    try {
      out = this.exec(["gh", "pr", "view", branch, "--repo", this.repoSlug(), "--json", "number,url"]);
    } catch {
      return null;
    }
    const parsed = JSON.parse(out) as { number: number; url: string };
    return parsed.number ? parsed : null;
  }

  async openPullRequest(o: {
    sourceBranch: string;
    targetBranch: string;
    title: string;
    body: string;
    draft?: boolean;
  }): Promise<{ url: string; number: number }> {
    const existing = this.prFor(o.sourceBranch);
    if (existing) return existing;
    const args = [
      "gh",
      "pr",
      "create",
      "--repo",
      this.repoSlug(),
      "--head",
      o.sourceBranch,
      "--base",
      o.targetBranch,
      "--title",
      o.title,
      "--body",
      o.body,
    ];
    if (o.draft) args.push("--draft");
    const url = this.exec(args).trim();
    const pr = this.prFor(o.sourceBranch);
    return { url: pr?.url ?? url, number: pr?.number ?? 0 };
  }

  async updatePullRequestBody(number: number, body: string): Promise<void> {
    this.exec(["gh", "pr", "edit", String(number), "--repo", this.repoSlug(), "--body", body]);
  }

  async getChecks(number: number): Promise<{ state: CheckState; failing: Array<{ name: string; url: string }> }> {
    let out: string;
    try {
      out = this.exec(["gh", "pr", "checks", String(number), "--repo", this.repoSlug(), "--json", "name,state,link"]);
    } catch {
      return { state: "none", failing: [] };
    }
    const checks = JSON.parse(out) as Array<{ name: string; state: string; link?: string }>;
    if (checks.length === 0) return { state: "none", failing: [] };
    const failing = checks
      .filter((c) => c.state === "FAILURE" || c.state === "failure" || c.state === "ERROR")
      .map((c) => ({ name: c.name, url: c.link ?? "" }));
    if (failing.length > 0) return { state: "failure", failing };
    const pending = checks.some((c) => c.state === "PENDING" || c.state === "pending" || c.state === "IN_PROGRESS");
    return { state: pending ? "pending" : "success", failing: [] };
  }

  async mergePR(number: number, method: "squash" | "merge" | "rebase"): Promise<{ sha: string }> {
    const flag = method === "squash" ? "--squash" : method === "rebase" ? "--rebase" : "--merge";
    this.exec(["gh", "pr", "merge", String(number), "--repo", this.repoSlug(), flag]);
    const view = this.exec(["gh", "pr", "view", String(number), "--repo", this.repoSlug(), "--json", "mergeCommit"]);
    const parsed = JSON.parse(view) as { mergeCommit?: { oid?: string } };
    return { sha: parsed.mergeCommit?.oid ?? "" };
  }
}
