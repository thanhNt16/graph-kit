import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cac } from "cac";
import {
  _resetTouchSeam,
  _setTouchSeam,
  registerMemoryCommands,
  touchMemoryByPath,
} from "../../src/cli/commands/memory.js";
import { applyRecallFilters, dropInvalid, type RecallEntry, resolveSuperseded } from "../../src/eval/memory-recall.js";

const NOW = "2026-08-15T00:00:00.000Z";

function e(partial: Partial<RecallEntry> & { id: string }): RecallEntry {
  return { file: `${partial.id}.md`, ...partial };
}
describe("dropInvalid (gk-recall step 4)", () => {
  test("drops expired, not-yet-valid, past-valid; keeps live", () => {
    const out = dropInvalid(
      [
        e({ id: "live" }),
        e({ id: "gone", expired: true }),
        e({ id: "future", valid_from: "2027-01-01T00:00:00.000Z" }),
        e({ id: "past", valid_to: "2026-01-01T00:00:00.000Z" }),
      ],
      NOW,
    );
    expect(out.map((x) => x.id)).toEqual(["live"]);
  });
});

describe("resolveSuperseded (gk-recall step 5)", () => {
  test("replaces head with present successor", () => {
    const out = resolveSuperseded([e({ id: "v1", superseded_by: "v2" }), e({ id: "v2" })]);
    expect(out.map((x) => x.id)).toEqual(["v2"]);
  });

  test("drops head whose successor is absent; follows chains", () => {
    const out = resolveSuperseded([
      e({ id: "a", superseded_by: "b" }),
      e({ id: "b", superseded_by: "c" }),
      e({ id: "c" }),
    ]);
    expect(out.map((x) => x.id)).toEqual(["c"]);
    expect(resolveSuperseded([e({ id: "orphan", superseded_by: "missing" })])).toEqual([]);
  });

  test("cycle cannot loop forever", () => {
    const out = resolveSuperseded([e({ id: "x", superseded_by: "y" }), e({ id: "y", superseded_by: "x" })]);
    expect(out).toEqual([]);
  });
});

describe("applyRecallFilters", () => {
  test("expired supersede head is gone even if ranker loved it", () => {
    const out = applyRecallFilters([e({ id: "old", expired: true, superseded_by: "new" }), e({ id: "new" })], NOW);
    expect(out.map((x) => x.id)).toEqual(["new"]);
  });
});

// ── CLI: `gk memory recall` — O(k) reinforcement + human/--json output ──────

function runMemoryCli(args: string[], cwd: string) {
  const cli = cac("gk");
  registerMemoryCommands(cli);
  const logs: string[] = [];
  const origLog = console.log;
  const origCwd = process.cwd();
  const origExit = process.exit;
  let exitCode = 0;
  console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  process.exit = ((c?: number) => {
    exitCode = c ?? 1;
  }) as typeof process.exit;
  process.chdir(cwd);
  try {
    cli.parse(["node", "gk", "memory", ...args], { run: true });
  } finally {
    console.log = origLog;
    process.exit = origExit;
    process.chdir(origCwd);
  }
  const code = process.exitCode ? Number(process.exitCode) : exitCode;
  process.exitCode = 0; // fail() paths set process.exitCode=1 — reset so bun:test exits 0
  return { stdout: logs.join("\n"), code };
}

function seedStore(root: string): string {
  const memDir = join(root, ".graphkit", "memory");
  mkdirSync(memDir, { recursive: true });
  // a-first sorts first: if the CLI ever regressed to full-store rescans per
  // hit (old touchMemory path), the non-matching file would be re-read too.
  writeFileSync(
    join(memDir, "a-first.md"),
    "---\nid: a-first\ntype: knowledge\nsalience: 0.9\n---\nunrelated applesauce content\n",
  );
  writeFileSync(
    join(memDir, "b-hit1.md"),
    "---\nid: b-hit1\ntype: knowledge\nsalience: 0.9\n---\noauth token rotation\n",
  );
  writeFileSync(
    join(memDir, "c-hit2.md"),
    "---\nid: c-hit2\ntype: knowledge\nsalience: 0.9\n---\noauth refresh flow\n",
  );
  return memDir;
}

describe("gk memory recall — reinforcement by path (O(k))", () => {
  let root: string;
  let memDir: string;
  const mk = () => {
    root = join(tmpdir(), `gk-recall-cli-${process.pid}-${Date.now()}`);
    memDir = seedStore(root);
  };

  test("recall with k hits issues exactly k single-file touches", () => {
    mk();
    try {
      const touches: Array<{ path: string; id: string }> = [];
      _setTouchSeam((cwd, relPath, id, now) => {
        touches.push({ path: relPath, id });
        // call through to the real single-file touch so side effects are real
        return touchMemoryByPath(cwd, relPath, id, now ?? new Date().toISOString());
      });
      let code = 0;
      let stdout = "";
      try {
        ({ stdout, code } = runMemoryCli(["recall", "--json", "oauth"], root));
      } finally {
        _resetTouchSeam();
      }
      expect(code).toBe(0);
      const envelope = JSON.parse(stdout);
      expect(envelope.status).toBe("ok");
      expect(envelope.data.results.map((h: { id: string }) => h.id).sort()).toEqual(["b-hit1", "c-hit2"]);
      // hits carry the store-relative path the single-file touch uses
      expect(envelope.data.results.map((h: { path: string }) => h.path).sort()).toEqual(["b-hit1.md", "c-hit2.md"]);
      // exactly k touches, one per hit, each targeting a single file path
      // (order-agnostic: readdir order is not guaranteed)
      expect(touches.map((t) => `${t.id}:${t.path}`).sort()).toEqual(["b-hit1:b-hit1.md", "c-hit2:c-hit2.md"]);
      // every hit was actually reinforced; the non-hit was not
      expect(readFileSync(join(memDir, "b-hit1.md"), "utf-8")).toContain("use_count: 2");
      expect(readFileSync(join(memDir, "c-hit2.md"), "utf-8")).toContain("use_count: 2");
      expect(readFileSync(join(memDir, "a-first.md"), "utf-8")).not.toContain("use_count");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("default recall output is human; --json keeps the machine envelope", () => {
    mk();
    try {
      const human = runMemoryCli(["recall", "oauth"], root);
      expect(human.code).toBe(0);
      expect(() => JSON.parse(human.stdout)).toThrow(); // default output is not JSON
      expect(human.stdout).toContain("b-hit1");
      expect(human.stdout).toContain("score");
      expect(human.stdout).toContain("salience");
      expect(human.stdout).toContain("oauth token rotation"); // body snippet
      // fresh store for the json run — reinforcement ties are order-stable only
      // within one pass, and the envelope assertion must not depend on readdir order
      rmSync(root, { recursive: true, force: true });
      mk();
      const json = runMemoryCli(["recall", "--json", "oauth"], root);
      const envelope = JSON.parse(json.stdout);
      expect(envelope.status).toBe("ok");
      expect(envelope.data.results.map((h: { id: string }) => h.id).sort()).toEqual(["b-hit1", "c-hit2"]);
      expect(envelope.data.results.every((h: { path: string }) => h.path === `${h.id}.md`)).toBe(true);
      expect(envelope.data.recall_topk).toBe(5);
      expect(envelope.data.top_k).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("human renderer reports a miss plainly", () => {
    mk();
    try {
      const out = runMemoryCli(["recall", "quantum entanglement"], root);
      expect(out.code).toBe(0);
      expect(out.stdout).toContain('no memories matched "quantum entanglement"');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
