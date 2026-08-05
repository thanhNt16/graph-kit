import { cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { executeWorkflow, nextWorkflow, startWorkflow, submitWorkflow } from "../../src/commands/workflow.js";
import type { WorkflowContract } from "../../src/runtime/contracts.js";
import { resumeRun } from "../../src/runtime/store.js";
import { loadTemplate } from "../../src/templates/loader.js";
import { validateTemplate } from "../../src/runtime/validation.js";
import { installTemplate } from "../../src/templates/installer.js";
import { evidenceReport } from "../../src/commands/observability.js";

const TEMPLATES = ["task-execute-verify", "orchestrator-worker"];

let project: string;
let runSeq = 0;

beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), "gk-int-"));
});
afterEach(async () => {
  await rm(project, { recursive: true, force: true });
});

function templateDir(name: string) {
  return join(import.meta.dir, "..", "..", "templates", name);
}
async function loadValidated(name: string) {
  const loaded = await loadTemplate(templateDir(name));
  const issues = validateTemplate(loaded);
  expect(issues, issues.map((i) => `${i.code}: ${i.message}`).join("\n")).toEqual([]);
  return loaded;
}

const OUTPUTS: Record<string, unknown> = {
  "task-execute-verify": {
    "load-context": { summary: [{ id: "ctx", task: "load" }] },
    plan: { summary: [{ id: "impl", task: "implement" }] },
    implement: { summary: "implemented", evidence: [{ key: "tests", value: "pass" }] },
    evaluate: { summary: "ok", verdict: "passed", approval: false, evidence: [{ key: "tests", value: "pass" }] },
  },
  "orchestrator-worker": {
    "load-context": [{ name: "a", task: "a" }, { name: "b", task: "b" }],
    plan: { summary: [{ name: "a", task: "a" }, { name: "b", task: "b" }] },
    "execute-workers": { summary: "done", evidence: [{ key: "tests", value: "pass" }] },
    aggregate: { summary: "aggregated", evidence: [{ key: "tests", value: "pass" }] },
    evaluate: { summary: "ok", verdict: "passed", approval: false, evidence: [{ key: "tests", value: "pass" }] },
  },
};

/** Drive a template to its terminal verdict, auto-playing contracts. */
async function driveToTerminal(name: string, inputs: Record<string, unknown>, runId: string): Promise<string> {
  await startWorkflow(project, await loadValidated(name), inputs, runId);
  const outputs = OUTPUTS[name];
  for (let i = 0; i < 200; i++) {
    const contract: WorkflowContract = await nextWorkflow(project, await loadValidated(name), runId);
    if (contract.kind === "terminal") return contract.verdict;
    if (contract.kind === "agent") {
      const out = outputs[contract.node];
      expect(out, `no fixture for ${contract.node}`).toBeDefined();
      await submitWorkflow(project, await loadValidated(name), runId, out, {});
    } else if (contract.kind === "deterministic") {
      await executeWorkflow(project, await loadValidated(name), runId);
    } else if (contract.kind === "dispatch") {
      for (const item of contract.items) {
        await submitWorkflow(project, await loadValidated(name), runId, outputs["execute-workers"], {
          lease: item.lease.id,
          work_item: item.work_item,
        });
      }
    } else {
      throw new Error(`unexpected contract '${contract.kind}'`);
    }
  }
  throw new Error("driveToTerminal: exceeded 200 advances");
}

for (const name of TEMPLATES) {
  describe(`integration ${name}`, () => {
    test("runs end-to-end to a passed terminal and writes replayable evidence", async () => {
      const runId = `e2e-${runSeq++}`;
      const inputs =
        name === "task-execute-verify"
          ? { task: "t1", objective: "ship" }
          : { objective: "ship", tasks: ["a", "b"] };
      const verdict = await driveToTerminal(name, inputs, runId);
      expect(verdict).toBe("passed");
      const report = await evidenceReport(project, runId, await loadValidated(name));
      expect(report.verdict).toBe("passed");
      expect(report.events).toBeGreaterThan(0);
      // required_evidence is carried on every agent contract.
      for (const [id, node] of Object.entries((await loadValidated(name)).workflow.nodes)) {
        if (node.type === "agent") {
          expect(node.output.evidence).toBeInstanceOf(Array);
          expect((node.output.evidence as string[]).length).toBeGreaterThan(0);
        }
      }
    });

    test("crash after a checkpoint is reconstructed by resumeRun and completes", async () => {
      const runId = `crash-${runSeq++}`;
      const inputs =
        name === "task-execute-verify"
          ? { task: "t1", objective: "ship" }
          : { objective: "ship", tasks: ["a", "b"] };
      await startWorkflow(project, await loadValidated(name), inputs, runId);
      // Simulate a crash mid-run: truncate the live documents so resumeRun must
      // fall back to the newest valid checkpoint.
      const dir = join(project, ".graphkit", "runs", runId);
      await writeFile(join(dir, "run.json"), "{corrupt");
      await writeFile(join(dir, "state.json"), "{corrupt");
      await writeFile(join(dir, "leases.json"), "{corrupt");
      const resumed = await resumeRun(project, runId);
      expect(resumed.run.run_id).toBe(runId);
      // Continue from the reconstructed state to a terminal.
      const outputs = OUTPUTS[name];
      for (let i = 0; i < 200; i++) {
        const contract = await nextWorkflow(project, await loadValidated(name), runId);
        if (contract.kind === "terminal") break;
        if (contract.kind === "agent") {
          await submitWorkflow(project, await loadValidated(name), runId, outputs[contract.node], {});
        } else if (contract.kind === "deterministic") {
          await executeWorkflow(project, await loadValidated(name), runId);
        } else if (contract.kind === "dispatch") {
          for (const item of contract.items) {
            await submitWorkflow(project, await loadValidated(name), runId, outputs["execute-workers"], {
              lease: item.lease.id,
              work_item: item.work_item,
            });
          }
        } else {
          throw new Error(`unexpected contract '${contract.kind}'`);
        }
      }
      const final = (await resumeRun(project, runId)).run;
      expect(final.status).toBe("done");
      expect(final.verdict).toBe("passed");
    });

    test("forked template validates, installs, and runs without touching gk source", async () => {
      const source = templateDir(name);
      const fork = await mkdtemp(join(tmpdir(), "gk-fork-"));
      await cp(source, fork, { recursive: true });
      // Rename metadata.
      const manifest = join(fork, "template.yaml");
      const wf = join(fork, "workflow.yaml");
      const manifestText = (await readFile(manifest, "utf8")).replace(/name: .+/, "name: fork-test");
      const wfText = (await readFile(wf, "utf8")).replace(/metadata: { name: .+ }/, "metadata: { name: fork-test }");
      await writeFile(manifest, manifestText);
      await writeFile(wf, wfText);

      const loaded = await loadTemplate(fork);
      const issues = validateTemplate(loaded);
      expect(issues, issues.map((i) => `${i.code}: ${i.message}`).join("\n")).toEqual([]);

      // Install into the temp project and verify it is registered.
      const result = await installTemplate(fork, { scope: "project", cwd: project, home: join(tmpdir(), "gk-home") });
      expect(result.ownedPaths.length).toBeGreaterThan(0);
      const entries = (await import("../../src/templates/registry.js")).readRegistry;
      const registry = await entries("project", project, join(tmpdir(), "gk-home"));
      expect(registry.entries.some((e) => e.name === "fork-test")).toBe(true);

      // Run the installed copy (no gk source files under its dir).
      const installedDir = join(project, ".graphkit", "templates", "fork-test@1.0.0");
      const runId = `fork-${runSeq++}`;
      const inputs =
        name === "task-execute-verify"
          ? { task: "t1", objective: "ship" }
          : { objective: "ship", tasks: ["a", "b"] };
      await startWorkflow(project, await loadTemplate(installedDir), inputs, runId);
      const outputs = OUTPUTS[name];
      for (let i = 0; i < 200; i++) {
        const contract = await nextWorkflow(project, await loadTemplate(installedDir), runId);
        if (contract.kind === "terminal") break;
        if (contract.kind === "agent") {
          await submitWorkflow(project, await loadTemplate(installedDir), runId, outputs[contract.node], {});
        } else if (contract.kind === "deterministic") {
          await executeWorkflow(project, await loadTemplate(installedDir), runId);
        } else if (contract.kind === "dispatch") {
          for (const item of contract.items) {
            await submitWorkflow(project, await loadTemplate(installedDir), runId, outputs["execute-workers"], {
              lease: item.lease.id,
              work_item: item.work_item,
            });
          }
        } else {
          throw new Error(`unexpected contract '${contract.kind}'`);
        }
      }
      const final = (await resumeRun(project, runId)).run;
      expect(final.status).toBe("done");
      expect(final.verdict).toBe("passed");
      await rm(fork, { recursive: true, force: true });
    });
  });
}

describe("required_evidence", () => {
  test("all bundled templates declare non-empty evidence keys on every agent node", async () => {
    for (const name of TEMPLATES) {
      const loaded = await loadValidated(name);
      for (const [id, node] of Object.entries(loaded.workflow.nodes)) {
        if (node.type === "agent") {
          expect(node.output.evidence, `${name}/${id}`).toBeInstanceOf(Array);
          expect((node.output.evidence as string[]).length, `${name}/${id} evidence empty`).toBeGreaterThan(0);
        }
      }
    }
  });
});
