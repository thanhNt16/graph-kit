import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { installKit, templatesDir } from "../../src/cli/commands/kit.js";
import { compileGraph } from "../../src/compiler/emitter.js";
import { GraphSchema } from "../../src/schemas/graph.schema.js";

const TMP = join(import.meta.dir, "..", ".tmp-mem-aug");
const FIXTURES = join(import.meta.dir, "..", "fixtures");

describe("memory-augmented topology: compile + runtime injection (exec-tests step 6)", () => {
  beforeAll(() => {
    if (existsSync(TMP)) rmSync(TMP, { recursive: true });
    mkdirSync(TMP, { recursive: true });
    installKit(TMP);
  });
  afterAll(() => {
    if (existsSync(TMP)) rmSync(TMP, { recursive: true });
  });

  test("AC11/AC12: memory-diamond graph parses and compiles to the memory-augmented template", () => {
    const raw = readFileSync(join(FIXTURES, "memory-diamond.yaml"), "utf-8");
    const graph = GraphSchema.parse(YAML.parse(raw));
    expect(graph.topology).toBe("memory-augmented");

    const script = compileGraph(graph, templatesDir());
    expect(script).toContain("createMemoryAugmentedWorkflow");
    expect(script).toContain("createDiamondWorkflow");
    expect(script).toContain("wrappedAgent");
  });

  // ── step 6: execute the compiled wrapper with a fake agent ──────────────────
  //
  // The compiled script is self-contained JS (templates inlined, `export`
  // stripped) ending in `return await _wf(_ctx);`. Wrap it in an async function
  // and eval it with a fake context — no LLM calls, no Workflow tool.

  function runCompiled(config: unknown, fakeContext: { agent: (prompt: string, opts?: unknown) => Promise<unknown> }) {
    const script = compileGraph(GraphSchema.parse(config), templatesDir());
    const body = script
      .replace(/return await _wf\(_ctx\);\s*$/, "return await _wf(__fakeCtx);")
      .replace(/^export /gm, ""); // `export const meta` is Workflow-tool-only; new Function chokes on it
    // eslint-disable-next-line no-new-func -- deterministic template under test
    const fn = new Function("__fakeCtx", `"use strict";return (async () => {\n${body}\n})();`);
    return fn(fakeContext);
  }

  function graphYaml(memory: string) {
    // indent every memory line under `memory:` so nested keys (every,
    // null_intervention_allowed) land in MemoryConfig, not topology_config.
    return YAML.parse(`apiVersion: graphkit.dev/v2
kind: Graph
metadata:
  name: mem-run
topology: memory-augmented
topology_config:
  inner:
    template: diamond
  memory:
    ${memory.replace(/\n/g, "\n    ")}
nodes:
  scouter:
    agent: Software Architect
    objective: Scout work items.
    depend_on: []
  worker:
    agent: Code Reviewer
    objective: Do the item.
    depend_on: [scouter]
  synthesizer:
    agent: Software Architect
    objective: Synthesize.
    depend_on: [worker]
  curator:
    agent: Memory Curator
    model: opus
    objective: Curate memory.
    depend_on: []
evidence:
  required_keys: []
`);
  }

  type Call = { prompt: string };
  function fakeAgent(log: Call[], scriptedCuratorOutput: string[]) {
    let curatorCalls = 0;
    return async (prompt: string): Promise<unknown> => {
      log.push({ prompt });
      if (prompt.includes("Curate memory")) {
        const out = scriptedCuratorOutput[Math.min(curatorCalls, scriptedCuratorOutput.length - 1)];
        curatorCalls++;
        return out;
      }
      if (prompt.startsWith("Scout")) return { items: ["a"] };
      if (prompt.startsWith("Do the item")) return { findings: "done" };
      return { report: "r" };
    };
  }

  test("curator reminder reaches the next action as a [memory] prepend (third action sees it)", () => {
    const log: Call[] = [];
    const ctx = {
      agent: fakeAgent(log, [
        "analysis…\nINJECTION: check the routing lexicon before answering",
        "INJECTION: null",
        "INJECTION: null",
      ]),
      parallel: async (thunks: (() => Promise<unknown>)[]) => Promise.all(thunks.map((t) => t())),
      inputs: {},
    };
    const result = runCompiled(graphYaml("cadence: on_node_complete"), ctx) as Promise<{ report: string }>;

    return result.then(() => {
      const actionPrompts = log.filter((c) => !c.prompt.includes("Curate memory")).map((c) => c.prompt);
      // scouter (no reminder yet), worker (reminder #1 prepended), synthesizer (null → nothing)
      expect(actionPrompts.length).toBeGreaterThanOrEqual(3);
      expect(actionPrompts[0]).not.toContain("[memory]");
      expect(actionPrompts[1]).toContain("[memory]");
      expect(actionPrompts[1]).toContain("check the routing lexicon before answering");
      expect(actionPrompts[2]).not.toContain("[memory]");
    });
  });

  test("INJECTION: null injects nothing; parse failure logs diagnostic and acts null; action never blocked", () => {
    const log: Call[] = [];
    const errs: string[] = [];
    const origErr = console.error;
    console.error = (...a: unknown[]) => errs.push(a.map(String).join(" "));
    const ctx = {
      agent: fakeAgent(log, ["garbage output with no INJECTION line at all", "INJECTION: null", "INJECTION: null"]),
      parallel: async (thunks: (() => Promise<unknown>)[]) => Promise.all(thunks.map((t) => t())),
      inputs: {},
    };
    return runCompiled(graphYaml("cadence: on_node_complete"), ctx).then(
      () => {
        console.error = origErr;
        const actionPrompts = log.filter((c) => !c.prompt.includes("Curate memory")).map((c) => c.prompt);
        expect(actionPrompts.slice(1).every((p) => !p.includes("[memory]"))).toBe(true);
        expect(errs.join("\n")).toMatch(/INJECTION|injection|parse/i); // diagnostic logged
      },
      (e) => {
        console.error = origErr;
        throw e;
      },
    );
  });

  test("curator dispatches are excluded from cadence counting (on_node_complete: one curator per action call)", () => {
    const log: Call[] = [];
    const ctx = {
      agent: fakeAgent(log, ["INJECTION: null", "INJECTION: null", "INJECTION: null"]),
      parallel: async (thunks: (() => Promise<unknown>)[]) => Promise.all(thunks.map((t) => t())),
      inputs: {},
    };
    return runCompiled(graphYaml("cadence: every\nevery: 2"), ctx).then(() => {
      const curatorCalls = log.filter((c) => c.prompt.includes("Curate memory")).length;
      // 3 action-node completions (scouter, worker, synthesizer) → fires at 2 → exactly 1 curator call.
      // If curator calls counted toward cadence, call #3 (the first curator itself) would fire another.
      expect(curatorCalls).toBe(1);
    });
  });

  test("null_intervention_allowed=false rejects an explicit null intervention", async () => {
    const cfg = graphYaml("cadence: on_node_complete\nnull_intervention_allowed: false") as {
      topology_config: { memory: Record<string, unknown> };
    };
    cfg.topology_config.memory.null_intervention_allowed = false;
    const log: Call[] = [];
    const ctx = {
      agent: fakeAgent(log, ["INJECTION: null"]),
      parallel: async (thunks: (() => Promise<unknown>)[]) => Promise.all(thunks.map((t) => t())),
      inputs: {},
    };

    await expect(runCompiled(cfg, ctx)).rejects.toThrow(/null intervention.*forbidden/i);
    const curatorPrompts = log.filter((c) => c.prompt.includes("Curate memory")).map((c) => c.prompt);
    expect(curatorPrompts[0]).toMatch(/MUST end|must end/i);
    expect(curatorPrompts[0]).not.toContain('or "INJECTION: null"');
  });

  test(".last-index remains CBM-only: compiled template does not reference .memory-dirty", () => {
    const raw = readFileSync(join(templatesDir(), "memory-augmented.workflow.js"), "utf-8");
    expect(raw).not.toContain("memory-dirty");
    expect(raw).not.toContain(".last-index"); // watermark stays out of the compiled path
  });
});
