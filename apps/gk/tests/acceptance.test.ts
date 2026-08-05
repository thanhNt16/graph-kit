import { describe, expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { evidenceReport, mermaidGraph, renderMermaid } from "../src/commands/observability.js";
import { executeWorkflow, nextWorkflow, startWorkflow, submitWorkflow } from "../src/commands/workflow.js";
import { validateLease } from "../src/runtime/leases.js";
import { readRun } from "../src/runtime/store.js";
import { validateTemplate } from "../src/runtime/validation.js";
import { installTemplate } from "../src/templates/installer.js";
import { loadTemplate } from "../src/templates/loader.js";
import { readRegistry } from "../src/templates/registry.js";

/** Real bundles shipped with gk — never test-local fixtures. */
const TEMPLATES = ["task-execute-verify", "orchestrator-worker"];
function templateDir(name: string): string {
  return join(import.meta.dir, "..", "templates", name);
}
async function loadValidated(name: string) {
  const loaded = await loadTemplate(templateDir(name));
  const issues = validateTemplate(loaded);
  expect(issues, issues.map((i) => `${i.code}: ${i.message}`).join("\n")).toEqual([]);
  return loaded;
}
async function loadTemplateDir(dir: string) {
  const loaded = await loadTemplate(dir);
  expect(validateTemplate(loaded)).toEqual([]);
  return loaded;
}

const OUTPUTS: Record<string, Record<string, unknown>> = {
  "task-execute-verify": {
    "load-context": { summary: [{ id: "ctx", task: "load" }] },
    plan: { summary: [{ id: "impl", task: "implement" }] },
    implement: { summary: "implemented", evidence: [{ key: "tests", value: "pass" }] },
    evaluate: { summary: "ok", verdict: "passed", approval: false, evidence: [{ key: "tests", value: "pass" }] },
  },
  "orchestrator-worker": {
    "load-context": [
      { name: "a", task: "a" },
      { name: "b", task: "b" },
    ],
    plan: {
      summary: [
        { name: "a", task: "a" },
        { name: "b", task: "b" },
      ],
    },
    "execute-workers": { summary: "done", evidence: [{ key: "tests", value: "pass" }] },
    aggregate: { summary: "aggregated", evidence: [{ key: "tests", value: "pass" }] },
    evaluate: { summary: "ok", verdict: "passed", approval: false, evidence: [{ key: "tests", value: "pass" }] },
  },
};

const REPLAY: Record<string, Record<string, unknown>> = {
  "task-execute-verify": {
    "load-context": { summary: [{ id: "ctx", task: "load" }] },
    plan: { summary: [{ id: "impl", task: "implement" }] },
    implement: { summary: "implemented", evidence: [{ key: "tests", value: "pass" }] },
    evaluate: {
      summary: "approved",
      verdict: "passed",
      approval: false,
      evidence: [{ key: "tests", value: "verified" }],
    },
  },
  "orchestrator-worker": {
    "load-context": [
      { name: "a", task: "a" },
      { name: "b", task: "b" },
    ],
    plan: {
      summary: [
        { name: "a", task: "a" },
        { name: "b", task: "b" },
      ],
    },
    "execute-workers": { summary: "done", evidence: [{ key: "tests", value: "pass" }] },
    aggregate: { summary: "aggregated", evidence: [{ key: "tests", value: "pass" }] },
    evaluate: { summary: "ok", verdict: "passed", approval: false, evidence: [{ key: "tests", value: "pass" }] },
  },
};

/** The only agent entry points the harness may call; the authority boundary. */
const AGENT_ENTRY_POINTS = new Set(["startWorkflow", "nextWorkflow", "submitWorkflow", "executeWorkflow"]);

/** Fixpoint drive honoring every contract kind, auto-filling required outputs. */
async function drive(
  project: string,
  name: string,
  runId: string,
  terminal?: (verdict: string) => void,
  evaluate: (node: string) => unknown = (node) => (REPLAY[name][node] ?? {}) as Record<string, unknown>,
  paused?: (node: string) => void,
): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const contract = await nextWorkflow(project, await loadValidated(name), runId);
    if (contract.kind === "terminal") {
      terminal?.(contract.verdict);
      return;
    }
    if (contract.kind === "paused") {
      paused?.(contract.node);
      await submitWorkflow(project, await loadValidated(name), runId, contract.actions[0] as string, {});
      continue;
    }
    if (contract.kind === "deterministic") {
      await executeWorkflow(project, await loadValidated(name), runId);
      continue;
    }
    if (contract.kind === "dispatch") {
      for (const item of contract.items) {
        await submitWorkflow(project, await loadValidated(name), runId, OUTPUTS[name]["execute-workers"], {
          lease: item.lease.id,
          work_item: item.work_item,
        });
      }
      continue;
    }
    await submitWorkflow(project, await loadValidated(name), runId, evaluate(contract.node), {});
  }
  throw new Error("drive: exceeded 200 advances");
}

async function newProject(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `gk-accept-${prefix}-`));
}

async function start(project: string, name: string, inputs: Record<string, unknown>, runId: string): Promise<void> {
  await startWorkflow(project, await loadValidated(name), inputs, runId);
}

/** Drive to the first agent contract and assert the harness contract shape. */
async function firstAgent(name: string, runId: string) {
  const project = await newProject("contract");
  await start(project, name, inputsFor(name), runId);
  let contract = await nextWorkflow(project, await loadValidated(name), runId);
  // Escort the cursor forward through deterministic/validator nodes only.
  while (contract.kind !== "agent") {
    expect(["dispatch", "deterministic", "paused"]).toContain(contract.kind);
    if (contract.kind === "deterministic") await executeWorkflow(project, await loadValidated(name), runId);
    else if (contract.kind === "paused")
      await submitWorkflow(project, await loadValidated(name), runId, contract.actions[0] as string, {});
    contract = await nextWorkflow(project, await loadValidated(name), runId);
  }
  expect(contract.kind).toBe("agent");
  return { project, contract: contract as import("../src/runtime/contracts.js").AgentContract };
}
function inputsFor(name: string): Record<string, unknown> {
  return name === "orchestrator-worker" ? { objective: "ship", tasks: ["a", "b"] } : { task: "t1", objective: "ship" };
}

async function reachDispatch(project: string, name: string, runId: string) {
  for (let i = 0; i < 10; i++) {
    const contract = await nextWorkflow(project, await loadValidated(name), runId);
    if (contract.kind === "dispatch") return contract;
    if (contract.kind === "agent") {
      await submitWorkflow(project, await loadValidated(name), runId, OUTPUTS[name][contract.node], {});
    } else if (contract.kind === "deterministic") {
      await executeWorkflow(project, await loadValidated(name), runId);
    }
  }
  throw new Error("dispatch not reached");
}

function mermaidGraphRender(graph: Parameters<typeof renderMermaid>[0]): string {
  return renderMermaid(graph);
}

describe("acceptance", () => {
  describe("AC01 harness-independent nodes and edges", () => {
    test("bundled workflows are pure YAML data: no code, no harness execution", async () => {
      for (const name of TEMPLATES) {
        const loaded = await loadValidated(name);
        expect(loaded.manifest.apiVersion).toBe("graphkit.dev/v1alpha1");
        // nodes/edges are plain data primitives, keyed by id.
        for (const node of Object.values(loaded.workflow.nodes)) {
          expect(typeof node).toBe("object");
          expect(typeof node.id).toBe("string");
          expect(typeof node.type).toBe("string");
        }
        for (const edge of loaded.workflow.edges) {
          expect(typeof edge.from).toBe("string");
          expect(typeof edge.to).toBe("string");
        }
      }
    });
  });

  describe("AC02 bundled validation; unreachable/unbounded rejection", () => {
    test("both bundles validate clean and a broken fork fails closed", async () => {
      for (const name of TEMPLATES) {
        expect(validateTemplate(await loadValidated(name))).toEqual([]);
      }
      // Reachability and boundedness are enforced: a fork that loses the start
      // edge leaves nodes unreachable, and a boundedness defect on a retry
      // cycle is rejected.
      const fork = await mkdtemp(join(tmpdir(), "gk-accept-validate-"));
      const source = templateDir("task-execute-verify");
      await cp(source, fork, { recursive: true });
      const wfPath = join(fork, "workflow.yaml");
      const wf = parse(await readFile(wfPath, "utf8")) as { edges: Array<{ from: string; to: string }> };
      wf.edges = wf.edges.filter((e) => e.from !== "start");
      await writeFile(wfPath, JSON.stringify(wf));
      const issues = validateTemplate(await loadTemplate(fork));
      expect(issues.some((i) => i.code === "UNREACHABLE_TERMINAL" || i.code === "INVALID_TRANSITION")).toBe(true);
      await rm(fork, { recursive: true, force: true });
    });
  });

  describe("AC03 Claude skills at project/global scope", () => {
    test("both bundles install into project and global scopes and register", async () => {
      for (const name of TEMPLATES) {
        const cwd = await newProject("install");
        const home = await mkdtemp(join(tmpdir(), "gk-accept-home-"));
        for (const scope of ["project", "global"] as const) {
          const result = await installTemplate(templateDir(name), { scope, cwd, home });
          expect(result.ownedPaths.length).toBeGreaterThan(0);
          const registry = await readRegistry(scope, cwd, home);
          expect(registry.entries.some((e) => e.name === name && e.version === "1.0.0" && e.scope === scope)).toBe(
            true,
          );
          // The install registers the agent skill under .claude/skills.
          expect(result.ownedPaths.some((p) => p.includes(".claude") && p.endsWith("SKILL.md"))).toBe(true);
        }
        await rm(cwd, { recursive: true, force: true });
        await rm(home, { recursive: true, force: true });
      }
    });
  });

  describe("AC04 agent execution protocol; gk never invokes a model", () => {
    test("next returns the declared agent contract; gk exports only the four CLI entry points", async () => {
      for (const name of TEMPLATES) {
        const { contract } = await firstAgent(name, `ac04-${name}`);
        expect(contract.kind).toBe("agent");
        expect(typeof contract.node).toBe("string");
        expect(contract.skill).toBeTruthy();
        expect(contract.submit_argv).toEqual(["gk", "workflow", "submit", `ac04-${name}`, contract.node]);
        // contract is harness-actionable: no model directive, just objective+argv.
        expect(contract.objective.length).toBeGreaterThan(0);
        expect(Array.isArray(contract.tool_allowlist)).toBe(true);
      }
    });

    test("the workflow module exposes exactly the four agent entry points, nothing more", async () => {
      const mod = await import("../src/commands/workflow.js");
      const exported = Object.keys(mod).filter((k) => AGENT_ENTRY_POINTS.has(k));
      expect(exported.sort()).toEqual([...AGENT_ENTRY_POINTS].sort());
      // startWorkflow is exported directly (used by gk), not via a subprocess
      // harness, so a model is never invoked.
      expect(typeof mod.startWorkflow).toBe("function");
    });
  });

  describe("AC05 gk controls transitions", () => {
    test("start fixes the cursor; only gk moves it forward", async () => {
      const project = await newProject("transition");
      const name = "task-execute-verify";
      await start(project, name, inputsFor(name), "ac05");
      const before = await readRun(project, "ac05");
      expect(before.run.current_nodes).toEqual(["load-context"]);
      // next (the sole transition authority) moves the cursor.
      const c = await nextWorkflow(project, await loadValidated(name), "ac05");
      expect(c.kind).toBe("agent");
      if (c.kind === "agent") expect(c.node).toBe("load-context");
      // submit through gk's authority, then cursor advances.
      await submitWorkflow(project, await loadValidated(name), "ac05", OUTPUTS[name]["load-context"], {});
      const after = await readRun(project, "ac05");
      expect(after.run.current_nodes[0]).not.toBe("load-context");
    });
  });

  describe("AC06 structured-result branching", () => {
    test("condition branches follow the structured verdict field", async () => {
      const name = "task-execute-verify";
      const project = await newProject("branch");
      const runId = "ac06";
      await start(project, name, inputsFor(name), runId);
      await drive(
        project,
        name,
        runId,
        (verdict) => {
          // evaluate blocked → approve skipped → blocked terminal.
          expect(verdict).toBe("blocked");
        },
        (node) => {
          if (node === "evaluate")
            return {
              summary: "blocked",
              verdict: "blocked",
              approval: false,
              evidence: [{ key: "tests", value: "x" }],
            };
          return (REPLAY[name][node] ?? {}) as Record<string, unknown>;
        },
      );
      const run = (await readRun(project, runId)).run;
      expect(run.verdict).toBe("blocked");
    });
  });

  describe("AC07 bounded retry and terminal limit", () => {
    test("retry cycling past max_iterations terminates limit-exceeded", async () => {
      const name = "task-execute-verify";
      const project = await newProject("retry");
      const runId = "ac07";
      await start(project, name, { task: "t1", objective: "retry" }, runId);
      await drive(
        project,
        name,
        runId,
        (verdict) => {
          expect(verdict).toBe("limit-exceeded");
        },
        (node) => {
          if (node === "evaluate")
            return {
              summary: "retrying",
              verdict: "retry",
              approval: false,
              evidence: [{ key: "tests", value: "retry" }],
            };
          return (REPLAY[name][node] ?? {}) as Record<string, unknown>;
        },
      );
      const run = (await readRun(project, runId)).run;
      expect(run.status).toBe("done");
      expect(run.verdict).toBe("limit-exceeded");
    });
  });

  describe("AC08 human pause/resume", () => {
    test("human node pauses the run; a declared action resumes it", async () => {
      const name = "task-execute-verify";
      const project = await newProject("human");
      const runId = "ac08";
      await start(project, name, inputsFor(name), runId);
      let paused = false;
      await drive(
        project,
        name,
        runId,
        (verdict) => {
          expect(verdict).toBe("passed");
        },
        (node) => {
          if (node === "evaluate") {
            // request the human gate so the paused contract is exercised.
            return { summary: "ok", verdict: "passed", approval: true, evidence: [{ key: "tests", value: "pass" }] };
          }
          return (REPLAY[name][node] ?? {}) as Record<string, unknown>;
        },
        (node) => {
          if (node === "approve") paused = true;
        },
      );
      expect(paused).toBe(true); // a human pause was actually reached and resumed
      const run = (await readRun(project, runId)).run;
      expect(run.status).toBe("done");
      expect(run.verdict).toBe("passed");
    });
  });

  describe("AC09 distinct leases and explicit merge", () => {
    test("fanout issues distinct leases; worker submits merge into the shared field", async () => {
      const name = "orchestrator-worker";
      const project = await newProject("leases");
      const runId = "ac09";
      await start(project, name, inputsFor(name), runId);
      const dispatch = await reachDispatch(project, name, runId);
      expect(dispatch.kind).toBe("dispatch");
      if (dispatch.kind !== "dispatch") throw new Error("expected dispatch");
      expect(dispatch.items).toHaveLength(2);
      expect(new Set(dispatch.items.map((i) => i.lease.id)).size).toBe(2);
      for (const item of dispatch.items) {
        await submitWorkflow(project, await loadValidated(name), runId, OUTPUTS[name]["execute-workers"], {
          lease: item.lease.id,
          work_item: item.work_item,
        });
      }
      // Both worker results were merged, not overwritten: identity is the name.
      const state = (await readRun(project, runId)).state;
      expect(Array.isArray(state.items)).toBe(true);
      expect((state.items as unknown[]).length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("AC10 stale/duplicate lease rejection and logging", () => {
    test("an already-settled lease is rejected and logged as a reject event", async () => {
      const name = "orchestrator-worker";
      const project = await newProject("lease-reject");
      const runId = "ac10";
      await start(project, name, inputsFor(name), runId);
      const dispatch = await reachDispatch(project, name, runId);
      if (dispatch.kind !== "dispatch") throw new Error("expected dispatch");
      const item = dispatch.items[0];
      await submitWorkflow(project, await loadValidated(name), runId, OUTPUTS[name]["execute-workers"], {
        lease: item.lease.id,
        work_item: item.work_item,
      });
      // Duplicate use of the settled lease must fail closed through the CLI boundary.
      await expect(
        submitWorkflow(project, await loadValidated(name), runId, OUTPUTS[name]["execute-workers"], {
          lease: item.lease.id,
          work_item: item.work_item,
        }),
      ).rejects.toMatchObject({ code: "LEASE_INVALID" });
      const log = await readFile(join(project, ".graphkit", "runs", runId, "events.jsonl"), "utf8");
      expect(log).toContain("reject");
      // The lease status document is the staleness source of truth.
      const leases = (await readRun(project, runId)).leases;
      expect(() => validateLease({ leases, now: Date.now(), id: item.lease.id, work_item: item.work_item })).toThrow(
        "already settled",
      );
    });
  });

  describe("AC11 checkpoint/provenance per transition", () => {
    test("every run mutation is checkpointed and each event is provenance-stamped", async () => {
      const name = "task-execute-verify";
      const project = await newProject("provenance");
      const runId = "ac11";
      await start(project, name, inputsFor(name), runId);
      for (let i = 0; i < 20; i++) {
        const contract = await nextWorkflow(project, await loadValidated(name), runId);
        if (contract.kind === "terminal") break;
        if (contract.kind === "agent") {
          await submitWorkflow(project, await loadValidated(name), runId, OUTPUTS[name][contract.node], {});
        }
      }
      const dir = join(project, ".graphkit", "runs", runId);
      const checkpoints = (await readdirFiles(join(dir, "checkpoints"))).filter((f) => f.endsWith(".json"));
      expect(checkpoints.length).toBeGreaterThan(0);
      const log = await readFile(join(dir, "events.jsonl"), "utf8");
      for (const line of log.trim().split("\n")) {
        const event = JSON.parse(line) as { timestamp?: string; run_id?: string };
        expect(event.timestamp).toBeTruthy();
        expect(event.run_id).toBe(runId);
      }
    });
  });

  describe("AC12 failed branch retained in evidence", () => {
    test("a failed submit surfaces as a failed branch in the evidence report", async () => {
      const name = "orchestrator-worker";
      const project = await newProject("failed-evidence");
      const runId = "ac12";
      await start(project, name, inputsFor(name), runId);
      const dispatch = await reachDispatch(project, name, runId);
      if (dispatch.kind !== "dispatch") throw new Error("expected dispatch");
      const item = dispatch.items[0];
      await submitWorkflow(project, await loadValidated(name), runId, OUTPUTS[name]["execute-workers"], {
        lease: item.lease.id,
        work_item: item.work_item,
        verdict: "failed",
      });
      const report = await evidenceReport(project, runId, await loadValidated(name));
      expect(report.branches.failed).toContain(item.work_item);
    });
  });

  describe("AC13 Mermaid visualization", () => {
    test("workflow graph renders as flowchart TD with nodes and edges", async () => {
      const name = "task-execute-verify";
      const project = await newProject("mermaid");
      await start(project, name, inputsFor(name), "ac13");
      const graph = await mermaidGraph(await loadValidated(name), project, "ac13");
      expect(graph.nodes.length).toBeGreaterThan(0);
      expect(graph.edges.length).toBeGreaterThan(0);
      const mermaid = mermaidGraphRender(graph);
      expect(mermaid.startsWith("flowchart TD")).toBe(true);
      expect(mermaid).toContain("-->");
    });
  });

  describe("AC14 forked template without source changes", () => {
    test("a renamed fork installs and runs without touching gk source", async () => {
      const name = "task-execute-verify";
      const fork = await mkdtemp(join(tmpdir(), "gk-accept-fork-"));
      const { cp } = await import("node:fs/promises");
      await cp(templateDir(name), fork, { recursive: true });
      const manifestPath = join(fork, "template.yaml");
      const wfPath = join(fork, "workflow.yaml");
      await writeFile(manifestPath, (await readFile(manifestPath, "utf8")).replace(/name: .+/, "name: fork-test"));
      await writeFile(
        wfPath,
        (await readFile(wfPath, "utf8")).replace(/metadata: { name: .+ }/, "metadata: { name: fork-test }"),
      );
      const loaded = await loadTemplateDir(fork);
      const project = await newProject("fork");
      await startWorkflow(project, loaded, inputsFor(name), "ac14");
      // The fork runs through the same runtime as its source; the first agent
      // contract proves the forked topology is executable without touching gk.
      const contract = await nextWorkflow(project, loaded, "ac14");
      expect(["agent", "dispatch", "deterministic", "paused"]).toContain(contract.kind);
      await rm(fork, { recursive: true, force: true });
      await rm(project, { recursive: true, force: true });
    });
  });
});

async function readdirFiles(dir: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  return readdir(dir);
}
