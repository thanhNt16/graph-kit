import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalBoardProvider, LocalVCSProvider, LocalWorkspace } from "../../src/factory/providers/local";
import { factoryMarker } from "../../src/factory/providers/types";

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "gk-factory-repo-"));
  const git = (...a: string[]) => execFileSync("git", a, { cwd: dir });
  git("init", "-b", "main");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  writeFileSync(join(dir, "f.txt"), "hi\n");
  git("add", ".");
  git("commit", "-m", "init");
  return dir;
}

describe("LocalBoardProvider", () => {
  test("card lifecycle: create → list → move → halt check", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gk-board-"));
    const board = new LocalBoardProvider(dir);
    const card = board.create({ key: "#1", title: "t", description: "d" });
    expect(card.lane).toBe("ready");
    expect((await board.getCardsInLane("ready")).map((c) => c.id)).toContain(card.id);
    await board.moveCardLane(card.id, "building");
    expect((await board.getCard(card.id))?.lane).toBe("building");
    expect(await board.isTaskHalted(card.id, "building")).toBe(false);
    // human moved it → halt
    const raw = await board.getCard(card.id);
    expect(raw?.lane).toBe("building");
    await board.addLabel(card.id, "factory:halt");
    expect(await board.isTaskHalted(card.id, "building")).toBe(true);
  });

  test("upsertComment is idempotent on marker", async () => {
    const board = new LocalBoardProvider(mkdtempSync(join(tmpdir(), "gk-board-")));
    const card = board.create({ key: "#1", title: "t" });
    const m = factoryMarker(card.id, "building", "run-1", "claim");
    const a = await board.upsertComment(card.id, m, "first");
    const b = await board.upsertComment(card.id, m, "second");
    expect(a.commentId).toBe(b.commentId);
    const comments = await board.listComments(card.id);
    expect(comments.length).toBe(1);
    expect(comments[0].body).toContain("second");
  });
});

describe("LocalVCSProvider + LocalWorkspace", () => {
  test("worktree ensure/remove + PR open idempotent + squash merge", async () => {
    const dir = repo();
    const ws = new LocalWorkspace(dir);
    const vcs = new LocalVCSProvider(dir);
    const { path, branch } = await ws.ensure("card-x", "main");
    expect(branch).toBe("factory/card-x");
    writeFileSync(join(path, "new.txt"), "work\n");
    execFileSync("git", ["add", "."], { cwd: path });
    execFileSync("git", ["commit", "-m", "feat: work"], { cwd: path });
    // reuse
    const again = await ws.ensure("card-x", "main");
    expect(again.path).toBe(path);
    const pr1 = await vcs.openPullRequest({ sourceBranch: branch, targetBranch: "main", title: "t", body: "b" });
    const pr2 = await vcs.openPullRequest({ sourceBranch: branch, targetBranch: "main", title: "t", body: "b" });
    expect(pr1.number).toBe(pr2.number);
    const { sha } = await vcs.mergePR(pr1.number, "squash");
    expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim()).toBe(sha);
    expect(execFileSync("git", ["log", "--format=%s", "-1"], { cwd: dir, encoding: "utf8" })).toContain("(#1)");
    await ws.remove("card-x");
    expect(() =>
      execFileSync("git", ["rev-parse", "--verify", "HEAD"], { cwd: join(dir, ".graphkit/factory/wt/card-x") }),
    ).toThrow();
  });
});
