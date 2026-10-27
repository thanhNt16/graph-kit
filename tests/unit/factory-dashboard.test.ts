/** `gk factory serve` — the node:http dashboard over board/journal/runs
 *  state: GET / + /api/state + /api/card/<id>, POST /api/tick drives one
 *  planner tick (scripted dispatch — no omp, no network). */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DispatchOutcome } from "../../src/exec/types";
import { loadFactoryConfig } from "../../src/factory/config";
import { serveFactoryDashboard } from "../../src/factory/dashboard";
import type { Providers, TickDeps } from "../../src/factory/dispatcher";
import { newJournal, saveJournal } from "../../src/factory/journal";
import { saveRunRecord } from "../../src/factory/lane-runner";
import { LocalBoardProvider, LocalVCSProvider, LocalWorkspace } from "../../src/factory/providers/local";

const TEMPLATE = join(import.meta.dir, "..", "..", "templates", "factory", "factory.yaml");

function scratchRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "gk-factory-serve-"));
  const git = (...a: string[]) => execFileSync("git", a, { cwd: dir });
  git("init", "-b", "main");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  writeFileSync(join(dir, "f.txt"), "hi\n");
  git("add", ".");
  git("commit", "-m", "init");
  mkdirSync(join(dir, ".omp"), { recursive: true });
  writeFileSync(join(dir, ".omp", "factory.yaml"), readFileSync(TEMPLATE, "utf8"));
  return dir;
}

async function start(cwd: string, prov: Providers, deps: TickDeps): Promise<{ server: Server; base: string }> {
  const cfg = loadFactoryConfig(cwd);
  const server = serveFactoryDashboard(cwd, cfg, prov, deps, 0);
  await new Promise<void>((r) => (server.listening ? r() : server.once("listening", () => r())));
  const port = (server.address() as AddressInfo).port;
  return { server, base: `http://127.0.0.1:${port}` };
}

function localProviders(cwd: string, branchPrefix = "factory/"): Providers {
  return {
    board: new LocalBoardProvider(LocalBoardProvider.defaultDir(cwd)),
    vcs: new LocalVCSProvider(cwd),
    workspace: new LocalWorkspace(cwd, branchPrefix),
  };
}

function deps(cwd: string, prov: Providers, dispatch?: (a: unknown) => Promise<DispatchOutcome>): TickDeps {
  return {
    workspace: prov.workspace,
    board: prov.board,
    guardExtension: "/dev/null",
    agentFragment: () => "role",
    dispatch: dispatch as never,
  };
}

describe("factory dashboard", () => {
  test("GET / serves the board page; /api/state groups cards by lane with journals + runs", async () => {
    const cwd = scratchRepo();
    const prov = localProviders(cwd);
    const card = prov.board.create({ key: "#1", title: "ready card" });
    const done = prov.board.create({ key: "#2", title: "done card", lane: "done" });
    saveJournal(cwd, { ...newJournal(card, "local"), phase: "claimed" });
    saveJournal(cwd, { ...newJournal(done, "local"), lane: "done", phase: "done" });
    saveRunRecord(cwd, {
      run_id: "lane-ready-x",
      card: card.id,
      lane: "ready",
      at: new Date().toISOString(),
      verdict: "MERGE",
    });
    const { server, base } = await start(cwd, prov, deps(cwd, prov));
    try {
      const html = await (await fetch(`${base}/`)).text();
      expect(html).toContain('id="board"');
      expect(html).toContain("gk factory");
      const s = (await (await fetch(`${base}/api/state`)).json()) as {
        lanes: string[];
        cards: Record<string, Array<{ id: string }>>;
        journals: Array<{ card: string; phase: string }>;
        runs: Array<{ record: { run_id: string } }>;
      };
      expect(s.lanes).toEqual(["ready", "building", "qa", "review", "blocked", "done"]);
      expect(s.cards.ready.map((c) => c.id)).toEqual([card.id]);
      expect(s.cards.done.map((c) => c.id)).toEqual([done.id]);
      expect(s.journals.map((j) => j.card).sort()).toEqual([card.id, done.id].sort());
      expect(s.runs.map((r) => r.record.run_id)).toEqual(["lane-ready-x"]);
    } finally {
      server.close();
    }
  });

  test("GET /api/card/<id> returns card + journal + only that card's runs; unknown id → nulls", async () => {
    const cwd = scratchRepo();
    const prov = localProviders(cwd);
    const a = prov.board.create({ key: "#1", title: "a" });
    const b = prov.board.create({ key: "#2", title: "b" });
    saveJournal(cwd, newJournal(a, "local"));
    saveJournal(cwd, newJournal(b, "local"));
    saveRunRecord(cwd, {
      run_id: "r-a",
      card: a.id,
      lane: "ready",
      at: new Date().toISOString(),
      verdict: "MERGE",
      blocked_calls: [],
    });
    saveRunRecord(cwd, {
      run_id: "r-b",
      card: b.id,
      lane: "qa",
      at: new Date().toISOString(),
      verdict: "BLOCK",
    });
    const { server, base } = await start(cwd, prov, deps(cwd, prov));
    try {
      const d = (await (await fetch(`${base}/api/card/${a.id}`)).json()) as {
        card: { id: string };
        journal: { card: string };
        runs: Array<{ record: { card: string; run_id: string } }>;
      };
      expect(d.card.id).toBe(a.id);
      expect(d.journal.card).toBe(a.id);
      expect(d.runs.map((r) => r.record.run_id)).toEqual(["r-a"]);
      const missing = (await (await fetch(`${base}/api/card/nope`)).json()) as { card: unknown; journal: unknown };
      expect(missing.card).toBeNull();
      expect(missing.journal).toBeNull();
      const res = await fetch(`${base}/api/card/../etc`);
      expect(res.status).toBe(404); // url doesn't match the id route shape → falls through
    } finally {
      server.close();
    }
  });

  test("POST /api/tick drives planner ticks: claim + ready run, then advance to building", async () => {
    const cwd = scratchRepo();
    const prov = localProviders(cwd);
    const card = prov.board.create({ key: "#3", title: "feature x", labels: ["factory"] });
    const blocks: Record<string, string> = {
      "gk-intake": '{"classification":"feature","ambiguous":false,"questions":[]}',
      "gk-build": '{"files_changed":[],"self_check":"ok","commit":"x","residual_risks":[],"blocked":false}',
    };
    const dispatch = async (a: unknown) => {
      const name = String((a as { node?: string }).node ?? "").split("-")[1];
      const block = name === "ready" ? blocks["gk-intake"] : blocks["gk-build"];
      return {
        output: `\`\`\`${name === "ready" ? "gk-intake" : "gk-build"}\n${block}\n\`\`\``,
        ok: true,
      } as DispatchOutcome;
    };
    const { server, base } = await start(cwd, prov, deps(cwd, prov, dispatch));
    try {
      const r1 = (await (await fetch(`${base}/api/tick`, { method: "POST" })).json()) as {
        actions: number;
        ran: Array<{ card: string; lane: string; verdict: string }>;
      };
      expect(r1.ran).toEqual([{ card: card.id, lane: "ready", verdict: "MERGE" }]);
      // The settled run advances on the next tick, which also dispatches the
      // building lane.
      await (await fetch(`${base}/api/tick`, { method: "POST" })).json();
      const d = (await (await fetch(`${base}/api/card/${card.id}`)).json()) as {
        card: { lane: string };
        journal: { lane: string; phase: string; history: Array<{ to: string }> };
        runs: Array<{ record: { lane: string } }>;
      };
      expect(d.card.lane).toBe("building");
      expect(d.journal.history.map((h) => h.to)).toEqual(["ready", "building"]);
      expect(d.runs.map((r) => r.record.lane).sort()).toEqual(["building", "ready"]);
    } finally {
      server.close();
    }
  });
});
