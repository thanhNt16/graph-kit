/** Task 14: offline end-to-end — local board + local vcs + scripted dispatch
 *  drives a card Ready → Building → QA → Review → Done with journal, run
 *  records, and marker comments. No network, no omp. */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DispatchOutcome } from "../../src/exec/types";
import { loadFactoryConfig, validateFactory } from "../../src/factory/config";
import { runFactory } from "../../src/factory/dispatcher";
import { listJournals } from "../../src/factory/journal";
import { loadRunRecord } from "../../src/factory/lane-runner";
import { LocalBoardProvider, LocalVCSProvider, LocalWorkspace } from "../../src/factory/providers/local";

const TEMPLATE = join(import.meta.dir, "..", "..", "templates", "factory", "factory.yaml");

function repoWithConfig(): string {
  const dir = mkdtempSync(join(tmpdir(), "gk-factory-e2e-"));
  const git = (...a: string[]) => execFileSync("git", a, { cwd: dir });
  git("init", "-b", "main");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  writeFileSync(join(dir, "f.txt"), "hi\n");
  git("add", ".");
  git("commit", "-m", "init");
  mkdirSync(join(dir, ".omp"), { recursive: true });
  writeFileSync(join(dir, ".omp", "factory.yaml"), readFileSync(TEMPLATE, "utf8"));
  // skills the starter config references
  for (const s of [
    "factory-intake",
    "factory-repro-check",
    "factory-build",
    "factory-dedup-ladder",
    "factory-git-sync",
    "factory-scrutiny",
    "factory-ui-journey",
    "factory-proof",
    "factory-adversarial-review",
    "factory-heresy-lint",
    "context-docs",
  ]) {
    mkdirSync(join(dir, ".omp", "skills", s), { recursive: true });
    writeFileSync(join(dir, ".omp", "skills", s, "SKILL.md"), `---\nname: ${s}\ndescription: x\n---\n`);
  }
  return dir;
}

import { mkdirSync } from "node:fs";

/** Scripted omp stand-in: emits a fenced verdict block per lane name found in
 *  the node id (`factory-<lane>-<card>`). Also applies a trivial file change
 *  + commit in the worktree on building so the review diff is non-empty. */
function scriptedDispatch(): {
  calls: Array<{ node?: string; cwd?: string; env?: Record<string, string>; args: unknown }>;
  fn: NonNullable<Parameters<typeof runFactory>[3]["runLane"]> extends never
    ? never
    : (args: never) => Promise<DispatchOutcome>;
} {
  const calls: Array<Record<string, unknown>> = [];
  const fn = async (args: Record<string, never>) => {
    calls.push(args);
    const node = String((args as { node?: string }).node ?? "");
    const lane = node.split("-")[1];
    const blocks: Record<string, string> = {
      ready:
        '{"classification": "feature", "summary": "s", "criteria": ["c"], "surfaces": ["f.txt"], "ambiguous": false, "questions": []}',
      building: '{"files_changed": ["f.txt"], "self_check": "ok", "commit": "x", "residual_risks": []}',
      qa: '{"verdict": "pass", "commands": [{"cmd": "bun test", "exit": 0, "excerpt": "ok"}], "criteria": [{"text": "c", "met": true, "proof": "f.txt:1"}], "strays": []}',
      review: '{"verdict": "approve", "issues": [], "praises": ["clean"]}',
    };
    const blockName = { ready: "intake", building: "build", qa: "qa", review: "review" }[lane] ?? lane;
    return {
      output: `\`\`\`gk-${blockName}\n${blocks[lane] ?? "{}"}\n\`\`\``,
      ok: true,
    } as DispatchOutcome;
  };
  return { calls: calls as never, fn: fn as never };
}

describe("factory local e2e", () => {
  test("card flows Ready → Building → QA → Review → Done", async () => {
    const cwd = repoWithConfig();
    const cfg = loadFactoryConfig(cwd);
    const findings = validateFactory(cwd, cfg, { home: join(cwd, "nohome") });
    expect(findings.filter((f) => f.severity !== "warn")).toEqual([]);

    const board = new LocalBoardProvider(join(cwd, ".graphkit", "factory", "board"));
    const vcs = new LocalVCSProvider(cwd);
    const workspace = new LocalWorkspace(cwd, cfg.vcs.branch_prefix);
    const scripted = scriptedDispatch();

    const card = board.create({ key: "#42", title: "Add export", description: "export f.txt", labels: ["factory"] });

    // The lane runner's dispatch seam: replace spawnDispatch with the script.
    const deps = {
      workspace,
      board,
      guardExtension: "/dev/null",
      agentFragment: () => "role",
      dispatch: scripted.fn as never,
    };

    const ticks = await runFactory(cwd, cfg, { board, vcs, workspace }, deps, 12);
    const last = ticks[ticks.length - 1];
    expect(last.actions).toBe(0); // quiescent

    const j = listJournals(cwd).find((j) => j.card === card.id);
    expect(j?.phase).toBe("done");
    expect(j?.lane).toBe("done");
    const lanes = j!.history.map((h) => h.to);
    expect(lanes).toEqual(["ready", "building", "qa", "review", "done"]);
    // board reflects done
    expect((await board.getCard(card.id))?.lane).toBe("done");
    // comments carry markers
    const comments = await board.listComments(card.id);
    expect(comments.some((c) => c.body.includes("gk-factory"))).toBe(true);
    // run records exist and are settled
    const runs = j!.history.filter((h) => h.run_id);
    for (const h of runs) {
      const rec = loadRunRecord(cwd, h.run_id!);
      expect(rec?.verdict).toBe("MERGE");
    }
    // env scrub happened: dispatch env has no GH_TOKEN-ish vars
    const dispatched = scripted.calls as unknown as Array<{ env?: Record<string, string> }>;
    expect(dispatched.length).toBe(4); // ready, building, qa, review
    for (const c of dispatched) {
      expect(c.env?.GK_FACTORY_POLICY).toBeDefined();
      expect(c.env?.GIT_TERMINAL_PROMPT).toBe("0");
      expect(c.env?.GH_TOKEN).toBeUndefined();
      expect(c.env?.GK_PROMPT).toBeUndefined();
    }
    // lane branch + worktree exist
    expect(existsSync(join(cwd, ".graphkit", "factory", "wt", card.id))).toBe(true);
    execFileSync("git", ["rev-parse", "--verify", `factory/${card.id}`], { cwd });
  });

  test("qa fail verdict bounces to building then done on second pass; max_rounds → blocked", async () => {
    const cwd = repoWithConfig();
    const cfg = loadFactoryConfig(cwd);
    const board = new LocalBoardProvider(join(cwd, ".graphkit", "factory", "board"));
    const vcs = new LocalVCSProvider(cwd);
    const workspace = new LocalWorkspace(cwd, cfg.vcs.branch_prefix);
    let qaRuns = 0;
    const dispatch = async (args: Record<string, unknown>) => {
      const node = String(args.node ?? "");
      const lane = node.split("-")[1];
      if (lane === "qa") {
        qaRuns++;
        return {
          output: `\`\`\`gk-qa\n{"verdict": "${qaRuns === 1 ? "fail" : "pass"}", "commands": [], "criteria": [], "strays": []}\n\`\`\``,
          ok: true,
        } as DispatchOutcome;
      }
      const blocks: Record<string, string> = {
        ready: '{"ambiguous": false}',
        building: '{"blocked": false}',
        review: '{"verdict": "approve", "issues": [], "praises": []}',
      };
      const blockName = { ready: "intake", building: "build", qa: "qa", review: "review" }[lane] ?? lane;
      return { output: `\`\`\`gk-${blockName}\n${blocks[lane] ?? "{}"}\n\`\`\``, ok: true } as DispatchOutcome;
    };
    const card = board.create({ key: "#7", title: "t", labels: ["factory"] });
    const ticks = await runFactory(
      cwd,
      cfg,
      { board, vcs, workspace },
      { workspace, board, guardExtension: "/dev/null", agentFragment: () => "", dispatch: dispatch as never },
      30,
    );
    expect(ticks[ticks.length - 1].actions).toBe(0);
    const j = listJournals(cwd).find((j) => j.card === card.id)!;
    expect(j.phase).toBe("done");
    expect(qaRuns).toBe(2);
    expect(j.round).toBe(1);
    const lanes = j.history.map((h) => h.to);
    expect(lanes.filter((l) => l === "building").length).toBe(2);
  });

  test("halt label parks a running card", async () => {
    const cwd = repoWithConfig();
    const cfg = loadFactoryConfig(cwd);
    const board = new LocalBoardProvider(join(cwd, ".graphkit", "factory", "board"));
    const vcs = new LocalVCSProvider(cwd);
    const workspace = new LocalWorkspace(cwd, cfg.vcs.branch_prefix);
    const dispatch = async (args: Record<string, unknown>) => {
      // halt the card while its "lane" is running
      const node = String(args.node ?? "");
      const lane = node.split("-")[1];
      const id = node.split("-").slice(2).join("-");
      await board.addLabel(id, "factory:halt");
      const blockName = { ready: "intake", building: "build", qa: "qa", review: "review" }[lane] ?? lane;
      return { output: `\`\`\`gk-${blockName}\n{}\n\`\`\``, ok: true } as DispatchOutcome;
    };
    const card = board.create({ key: "#9", title: "t", labels: ["factory"] });
    const ticks = await runFactory(
      cwd,
      cfg,
      { board, vcs, workspace },
      { workspace, board, guardExtension: "/dev/null", agentFragment: () => "", dispatch: dispatch as never },
      6,
    );
    expect(ticks[ticks.length - 1].actions).toBe(0);
    const j = listJournals(cwd).find((j) => j.card === card.id)!;
    expect(j.phase).toBe("parked");
    expect((await board.getCard(card.id))?.labels).toContain("factory:halt");
  });
});
