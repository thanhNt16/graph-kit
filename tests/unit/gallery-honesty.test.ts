// Gallery honesty pass (audit F3, F4, F6, F7, F8): every gallery template
// materializes with defaults, validates, previews waves, and its topology
// label tells the truth about the wave shape. Runs the REAL command surface
// a user hits — `template materialize` → `validate` → `graph waves --json`
// — through the registered CLI, plus T1's template-direct preview path.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cac } from "cac";
import YAML from "yaml";
import { registerGraphCommands } from "../../src/cli/commands/graph.js";
import { registerTemplateCommands } from "../../src/cli/commands/template.js";
import { APP_VERSION } from "../../src/version.js";

const ROOT = join(import.meta.dir, "..", "..");
const GALLERY = join(ROOT, "templates", "gallery");

// Minimal user context per parameter-gated demo — the one value each
// required parameter exists to carry. dream is the zero-context case.
const REQUIRED_STUBS: Record<string, Record<string, string>> = {
  dream: {},
  "audit-pr": { task: "the auth module" },
  "bench-eval": { workload: "summarization" },
  "doc-sweep": { topic: "CLI commands" },
  "cook-plan": { goal: "Ship the CSV export feature" },
  "refactor-module": { module: "src/store" },
};

// The honest label per template (audit F3): chains are `custom`, the
// produce→verify→synthesize audit is `adversarial-verification`, the only
// real fan-out keeps `tournament`.
const EXPECTED_LABEL: Record<string, string> = {
  dream: "custom",
  "audit-pr": "adversarial-verification",
  "bench-eval": "tournament",
  "doc-sweep": "custom",
  "cook-plan": "custom",
  "refactor-module": "custom",
};

// Labels that promise a fan-out contract: a graph carrying one must actually
// fan out AND converge. A linear chain under any of these fails — the
// "chain under diamond" honesty rule, asserted generically for all six.
const FANOUT_CONTRACT: Record<string, true> = {
  diamond: true,
  tournament: true,
  "generate-and-filter": true,
};

// Skills the kit actually ships (audit F8): gk-* plus excalidraw-diagram.
const SHIPPED_SKILL_RE = /^(gk-|excalidraw-diagram$)/;

interface Wave {
  wave: number;
  parallel: boolean;
  nodes: Array<{ id: string }>;
}

function fullCli() {
  const cli = cac("gk").version(APP_VERSION);
  registerGraphCommands(cli);
  registerTemplateCommands(cli);
  cli.help();
  return cli;
}

function runCli(args: string[], cwd: string) {
  const cli = fullCli();
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  let exitCode = 0;
  const origExit = process.exit;
  process.exit = (c?: number) => {
    exitCode = c ?? 1;
  };
  const origCwd = process.cwd;
  process.cwd = () => cwd;
  try {
    cli.parse(["node", "gk", ...args], { run: true });
  } finally {
    console.log = origLog;
    process.exit = origExit;
    process.cwd = origCwd;
    exitCode = exitCode || ((process.exitCode as number | undefined) ?? 0);
    process.exitCode = 0; // emit-fail sets exitCode=1; reset so later tests start clean
  }
  return { stdout: logs.join("\n"), code: exitCode };
}

function runOk(args: string[], cwd: string): Record<string, any> {
  const { stdout, code } = runCli(args, cwd);
  expect(code).toBe(0);
  const parsed = JSON.parse(stdout);
  expect(parsed.status).toBe("ok");
  return parsed.data;
}

describe("gallery honesty (audit F3/F4/F6/F7/F8)", () => {
  let root: string;
  let cwd: string;
  let prevGalleryDir: string | undefined;

  beforeEach(() => {
    const stamp = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    root = join(tmpdir(), `gk-gallery-honesty-${stamp}`);
    cwd = join(root, "proj");
    mkdirSync(join(cwd, ".graphkit"), { recursive: true });
    prevGalleryDir = process.env.GK_GALLERY_DIR;
    process.env.GK_GALLERY_DIR = GALLERY; // resolve names against the repo working tree
  });

  afterEach(() => {
    if (prevGalleryDir === undefined) delete process.env.GK_GALLERY_DIR;
    else process.env.GK_GALLERY_DIR = prevGalleryDir;
    process.exitCode = 0;
    rmSync(root, { recursive: true, force: true });
  });

  const readTpl = (name: string) => YAML.parse(readFileSync(join(GALLERY, `${name}.gk.yaml`), "utf-8"));
  const materialize = (name: string, params: Record<string, string>): string => {
    const data = runOk(["template", "materialize", name, "--params", JSON.stringify(params)], cwd);
    return data.path as string;
  };
  const waveOf = (waves: Wave[], id: string) => waves.findIndex((w) => w.nodes.some((n) => n.id === id));

  for (const [name, stubs] of Object.entries(REQUIRED_STUBS)) {
    describe(name, () => {
      test("materializes with defaults and `gk validate` passes", () => {
        const path = materialize(name, stubs);
        const v = runOk(["validate", path], cwd);
        expect(v.valid).toBe(true);
      });

      test("topology label matches the actual wave shape", () => {
        const tpl = readTpl(name);
        const path = materialize(name, stubs);
        const payload = runOk(["graph", "waves", path], cwd);
        const waves = payload.waves as Wave[];
        const label = payload.topology as string;

        const hasFanout = waves.some((w) => w.parallel && w.nodes.length > 1);
        const hasConverge = Object.values<Record<string, any>>(tpl.graph.nodes).some(
          (n) => Array.isArray(n.depend_on) && n.depend_on.length >= 2,
        );
        if (FANOUT_CONTRACT[label]) {
          expect(hasFanout).toBe(true);
          expect(hasConverge).toBe(true);
        }
        if (label === "loop-until-done") {
          const hasLoop =
            Object.values<Record<string, any>>(tpl.graph.nodes).some((n) => n.loop?.enabled) ||
            (Array.isArray(tpl.graph.loops) && tpl.graph.loops.length > 0);
          expect(hasLoop).toBe(true);
        }
        expect(label).toBe(EXPECTED_LABEL[name]);
      });

      test("recommendations carry no duplicate agent bindings or unshipped skills", () => {
        const tpl = readTpl(name);
        const rec = tpl.recommendations ?? {};
        expect(rec.agents ?? []).toEqual([]); // derivable from nodes[].agent — dropped (F8)
        for (const skill of rec.skills ?? []) {
          expect(skill).toMatch(SHIPPED_SKILL_RE);
        }
      });

      // Template-specific honesty contracts.
      if (name === "dream") {
        test("is an honest linear chain: sequential waves, no empty-string sentinels", () => {
          const tpl = readTpl(name);
          expect(tpl.parameters.focus.default).toBeUndefined();
          expect(tpl.parameters.since.default).toBeUndefined();
          // T1 preview path: a fully-defaulting template previews waves
          // directly on the .gk.yaml — no materialize needed.
          const payload = runOk(["graph", "waves", join(GALLERY, `${name}.gk.yaml`)], cwd);
          const waves = payload.waves as Wave[];
          expect(payload.total_waves).toBe(3);
          expect(waves.every((w) => !w.parallel)).toBe(true);
          // F7: the unprovided optionals render clean, not "Focus theme: ."
          const materialized = YAML.parse(readFileSync(materialize(name, {}), "utf-8"));
          const objective = materialized.nodes.harvest.objective as string;
          expect(objective).not.toMatch(/:\s*\./);
        });
        test("provided focus/since substitute into the objective", () => {
          const materialized = YAML.parse(
            readFileSync(materialize(name, { focus: "release workflow", since: "2026-01-01" }), "utf-8"),
          );
          const objective = materialized.nodes.harvest.objective as string;
          expect(objective).toContain("release workflow");
          expect(objective).toContain("2026-01-01");
        });
      }

      if (name === "audit-pr") {
        test("adversarial-verification shape: produce → verify → synthesize, sequential", () => {
          const path = materialize(name, stubs);
          const payload = runOk(["graph", "waves", path], cwd);
          const waves = payload.waves as Wave[];
          expect(waveOf(waves, "reviewer")).toBe(0);
          expect(waveOf(waves, "verifier")).toBe(1);
          expect(waveOf(waves, "synthesizer")).toBe(2);
          expect(waves.every((w) => !w.parallel)).toBe(true);
        });
      }

      if (name === "bench-eval") {
        test("tournament shape: real fan-out wave of three runners", () => {
          const path = materialize(name, stubs);
          const payload = runOk(["graph", "waves", path], cwd);
          const wave0 = (payload.waves as Wave[])[0];
          expect(wave0.parallel).toBe(true);
          expect(wave0.nodes.length).toBe(3);
        });
      }

      if (name === "doc-sweep") {
        test("keeps node.loop as its declared idiom (F4: honest per-template choice)", () => {
          const tpl = readTpl(name);
          expect(tpl.graph.nodes.writer.loop?.enabled).toBe(true);
          expect(tpl.graph.nodes.writer.loop?.stop_when).toBeTruthy();
        });
      }

      if (name === "cook-plan") {
        test("declares a goal channel: parameter → input → plan objective (F6)", () => {
          const tpl = readTpl(name);
          expect(tpl.parameters.goal.required).toBe(true);
          expect(tpl.graph.inputs.goal.required).toBe(true);
          expect(tpl.graph.nodes.plan.objective).toContain("{{goal}}");
          // Required goal gates materialize: no params → nonzero exit.
          const { code } = runCli(["template", "materialize", name, "--params", "{}"], cwd);
          expect(code).toBe(1);
          // And the goal value reaches the materialized objective.
          const materialized = YAML.parse(readFileSync(materialize(name, stubs), "utf-8"));
          expect(materialized.nodes.plan.objective).toContain(stubs.goal);
        });
      }
    });
  }
});
