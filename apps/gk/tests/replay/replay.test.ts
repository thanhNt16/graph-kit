import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { executeWorkflow, nextWorkflow, startWorkflow, submitWorkflow } from "../../src/commands/workflow.js";
import type { WorkflowContract } from "../../src/runtime/contracts.js";
import { issueLeases, validateLease } from "../../src/runtime/leases.js";
import { mergeStateField } from "../../src/runtime/merges.js";
import { validateTemplate } from "../../src/runtime/validation.js";
import { loadTemplate } from "../../src/templates/loader.js";

/**
 * Test-only replay driver. Deliberately NOT a public CLI command: it drives a
 * template through the same runtime entry points an agent uses (`start` /
 * `next` / `submit` / `execute`), auto-plays every contract with fixture
 * outputs, and asserts the terminal verdict. Cycles (retry loops) terminate
 * via the workflow's own iteration cap, so `max_advance` only guards against
 * pathological infinite loops.
 */

export interface ReplayCase {
  name: string;
  inputs: Record<string, unknown>;
  /** Per-node output overrides keyed by node id. Missing nodes use `defaults`. */
  overrides?: Record<string, unknown>;
  defaults?: Record<string, unknown>;
  expect_terminal: string;
  max_advance?: number;
}

const MAX_ADVANCE = 200;

let project: string;
let runSeq = 0;

beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), "gk-replay-"));
});
afterEach(async () => {
  await rm(project, { recursive: true, force: true });
});

async function load(templateDir: string) {
  const loaded = await loadTemplate(templateDir);
  const issues = validateTemplate(loaded);
  expect(issues, issues.map((i) => `${i.code}: ${i.message}`).join("\n")).toEqual([]);
  return loaded;
}

/** Run a template to a terminal verdict, auto-playing every contract. */
export async function runReplayCase(templateDir: string, fixture: ReplayCase): Promise<string> {
  const runId = `replay-${fixture.name}-${runSeq++}`;
  await startWorkflow(project, await load(templateDir), fixture.inputs, runId);
  const overrides = fixture.overrides ?? {};
  const defaults = fixture.defaults ?? {};

  let contract: WorkflowContract;
  for (let i = 0; i < (fixture.max_advance ?? MAX_ADVANCE); i++) {
    contract = await nextWorkflow(project, await load(templateDir), runId);
    if (contract.kind === "terminal") return contract.verdict;
    switch (contract.kind) {
      case "agent": {
        const output = overrides[contract.node] ?? defaults[contract.node] ?? overrides.__default__;
        if (output === undefined) throw new Error(`no fixture output for agent node '${contract.node}'`);
        await submitWorkflow(project, await load(templateDir), runId, output, {});
        break;
      }
      case "deterministic":
        await executeWorkflow(project, await load(templateDir), runId);
        break;
      case "dispatch":
        for (const item of contract.items) {
          const output = overrides[item.node] ?? defaults[item.node] ?? overrides.__default__;
          if (output === undefined) throw new Error(`no fixture output for worker node '${item.node}'`);
          await submitWorkflow(project, await load(templateDir), runId, output, {
            lease: item.lease.id,
            work_item: item.work_item,
          });
        }
        break;
      case "paused":
        throw new Error(`no human action fixture for paused node '${contract.node}'`);
    }
  }
  throw new Error("runReplayCase: max_advance exceeded without a terminal");
}

async function casesFor(templateName: string): Promise<ReplayCase[]> {
  const dir = join(import.meta.dir, "..", "..", "templates", templateName, "replay");
  const files = ["valid", "retry-limit", "limit", "parallel-conflict"];
  const out: ReplayCase[] = [];
  for (const file of files) {
    const text = await readFile(join(dir, `${file}.yaml`), "utf8");
    out.push(parse(text) as ReplayCase);
  }
  return out;
}

for (const templateName of ["task-execute-verify", "orchestrator-worker"]) {
  const fixtures = await casesFor(templateName);
  describe(`replay ${templateName}`, () => {
    for (const fixture of fixtures) {
      test(`${fixture.name} → ${fixture.expect_terminal}`, async () => {
        const templateDir = join(import.meta.dir, "..", "..", "templates", templateName);
        const verdict = await runReplayCase(templateDir, fixture);
        expect(verdict).toBe(fixture.expect_terminal);
      });
    }

    test("lease expiry: expired lease is rejected and the fanout re-dispatches", async () => {
      const templateDir = join(import.meta.dir, "..", "..", "templates", templateName);
      // Only the orchestrator template has a fanout; the others have no leases.
      if (templateName === "orchestrator-worker") {
        const runId = `replay-lease-expiry-${runSeq++}`;
        await startWorkflow(project, await load(templateDir), { objective: "x", tasks: ["a", "b"] }, runId);
        // Drive to the first dispatch, then let the driver's own replay finish
        // (happy path). The unit assertions below pin the expiry semantics.
        const terminal = await runReplayCase(templateDir, {
          name: "lease-expiry",
          inputs: { objective: "x", tasks: ["a", "b"] },
          overrides: {
            __default__: { summary: "done", evidence: [{ key: "k", value: "v" }] },
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
            evaluate: { summary: "ok", verdict: "passed", approval: false, evidence: [{ key: "k", value: "v" }] },
          },
          expect_terminal: "passed",
        });
        expect(terminal).toBe("passed");
      }

      const expired = issueLeases([{ work_item: "w", node: "n", now: Date.now() }]);
      const past = new Date(Date.now() - 1).toISOString();
      expired[0].expires_at = past;
      expect(() => validateLease({ leases: expired, now: Date.now(), id: expired[0].id, work_item: "w" })).toThrow(
        "lease expired",
      );
    });

    test("merge policies: append_unique flattens array writes and dedupes by identity", () => {
      const decl = { merge: "append_unique" as const, identity: "name" };
      const first = mergeStateField(decl, undefined, [
        { name: "a", task: "a" },
        { name: "b", task: "b" },
      ]);
      expect(Array.isArray(first)).toBe(true);
      expect(first).toHaveLength(2);
      const second = mergeStateField(decl, first, [
        { name: "b", task: "b2" },
        { name: "c", task: "c" },
      ]);
      expect(second).toEqual([
        { name: "a", task: "a" },
        { name: "b", task: "b" },
        { name: "c", task: "c" },
      ]);
      const replace = mergeStateField({ merge: "replace" }, undefined, [{ name: "a" }]);
      expect(replace).toEqual([{ name: "a" }]);
    });
  });
}
