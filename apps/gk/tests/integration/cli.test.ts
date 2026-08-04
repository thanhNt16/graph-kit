import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMMAND_NAMES, cliManifest, createCli, generateCliManifest } from "../../src/cli/command-registry.js";
import { createRun, mutateRun } from "../../src/runtime/store.js";
import { loadTemplate } from "../../src/templates/loader.js";

const fixture = join(import.meta.dir, "..", "fixtures", "valid-chain");
const root = join(import.meta.dir, "..", "..");
let project = "";
let home = "";

beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), "gk-cli-"));
  home = project;
});
afterEach(async () => {
  await rm(project, { recursive: true, force: true });
});

const gk = `${root}/src/index.ts`;

/** Spawn the CLI once; stdout must contain exactly one JSON envelope. */
async function runCli(args: string[]): Promise<{ code: number; stdout: unknown }> {
  const proc = Bun.spawn(["bun", gk, ...args], {
    cwd: home,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GRAPHKIT_PROJECT: project },
  });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (err) throw new Error(`stderr: ${err}`);
  const trimmed = out.trim();
  const lines = trimmed.split("\n");
  if (lines.length !== 1) throw new Error(`expected exactly one envelope, got ${lines.length}: ${out}`);
  return { code, stdout: JSON.parse(lines[0]) };
}

describe("CLI envelope contract", () => {
  test("template validate emits one ok envelope", async () => {
    const { code, stdout } = await runCli(["template", "validate", fixture]);
    expect(code).toBe(0);
    expect(stdout).toMatchObject({ ok: true, data: [] });
  });

  test("template validate on a missing directory fails non-zero with a stable code", async () => {
    const { code, stdout } = await runCli(["template", "validate", join(project, "nope")]);
    expect(code).not.toBe(0);
    expect(stdout).toMatchObject({ ok: false, error: { code: "SCHEMA_VIOLATION" } });
  });

  test("workflow start then next drive a run through the CLI", async () => {
    const start = await runCli(["workflow", "start", fixture, "r1", "--inputs", '{"task":"x"}']);
    expect(start.code).toBe(0);
    expect(start.stdout).toMatchObject({ ok: true, data: { run_id: "r1", current_nodes: ["start"] } });
    const next = await runCli(["workflow", "next", fixture, "r1"]);
    expect(next.code).toBe(0);
    expect(next.stdout).toMatchObject({ ok: true, data: { kind: "agent", node: "work" } });
  });

  test("invalid lease fails non-zero with LEASE_INVALID and exactly one envelope", async () => {
    await runCli(["workflow", "start", fixture, "r1"]);
    const bad = await runCli(["workflow", "submit", fixture, "r1", '{"summary":"x"}', "--lease", "nope"]);
    expect(bad.code).not.toBe(0);
    expect(bad.stdout).toMatchObject({ ok: false, error: { code: "LEASE_INVALID" } });
  });

  test("status returns the run documents", async () => {
    await runCli(["workflow", "start", fixture, "r1"]);
    const { code, stdout } = await runCli(["workflow", "status", "r1"]);
    expect(code).toBe(0);
    expect(stdout).toMatchObject({ ok: true, data: { run: { run_id: "r1" }, state: expect.any(Object), leases: [] } });
  });

  test("unknown subcommand fails non-zero and emits an error envelope", async () => {
    const { code, stdout } = await runCli(["template", "explode"]);
    expect(code).not.toBe(0);
    expect(stdout).toMatchObject({ ok: false });
  });
});

describe("evidence, trace and Mermaid read models", () => {
  /** Drive a run with one failed branch, a command result, an artifact, and a human action. */
  async function driveMixedRun(): Promise<void> {
    const workflow = join(project, "wf");
    await mkdir(join(workflow, "schemas"), { recursive: true });
    await mkdir(join(workflow, "skills", "worker"), { recursive: true });
    await writeFile(
      join(workflow, "schemas", "result.schema.json"),
      JSON.stringify({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        required: ["summary"],
        properties: { summary: { type: "string" } },
        additionalProperties: false,
      }),
    );
    await writeFile(
      join(workflow, "template.yaml"),
      `${["name: mixed", "version: 2.0.0", "apiVersion: graphkit.dev/v1alpha1", "harness: claude"].join("\n")}\n`,
    );
    await writeFile(
      join(workflow, "workflow.yaml"),
      `${[
        "apiVersion: graphkit.dev/v1alpha1",
        "kind: Workflow",
        "metadata: { name: mixed }",
        "limits: { max_iterations: 4, max_workers: 2, max_failures: 2 }",
        "state: { items: { merge: append_unique, identity: name }, result: { merge: replace } }",
        "start: start",
        "nodes:",
        "  fan:",
        "    type: fanout",
        "    from: items",
        "    max_workers: 2",
        "  work:",
        "    type: agent",
        "    skill: worker",
        "    objective: Process.",
        "    output: { schema: schemas/result.schema.json, save_as: result }",
        "  review:",
        "    type: human",
        "    prompt: Approve?",
        "    actions: [approve, reject]",
        "  cmd:",
        "    type: command",
        "    command: [printf, hello]",
        "  join: { type: join, merge: items }",
        "  done: { type: graph, operation: complete-task }",
        "edges:",
        "  - { from: start, to: fan }",
        "  - { from: fan, to: join }",
        "  - { from: join, to: review }",
        "  - { from: review, to: cmd }",
        "  - { from: cmd, to: done }",
        "terminal:",
        "  - { node: done, verdict: passed }",
      ].join("\n")}\n`,
    );
    await runCli(["workflow", "start", workflow, "m1", "--inputs", '{"items":[{"name":"i1"},{"name":"i2"}]}']);
    const dispatch = await runCli(["workflow", "next", workflow, "m1"]);
    const items = (dispatch.stdout as { data: { items: Array<{ work_item: string; lease: { id: string } }> } }).data
      .items;
    await runCli([
      "workflow",
      "submit",
      workflow,
      "m1",
      '{"summary":"ok"}',
      "--lease",
      items[0].lease.id,
      "--work-item",
      items[0].work_item,
      "--verdict",
      "failed",
    ]);
    await runCli([
      "workflow",
      "submit",
      workflow,
      "m1",
      '{"summary":"ok"}',
      "--lease",
      items[1].lease.id,
      "--work-item",
      items[1].work_item,
      "--verdict",
      "passed",
    ]);
    // human action, then command execution
    const human = await runCli(["workflow", "next", workflow, "m1"]);
    expect(human.stdout).toMatchObject({ data: { kind: "paused", node: "review" } });
    await runCli(["workflow", "submit", workflow, "m1", "approve", "--node", "review", "--actor", "reviewer"]);
    const next = await runCli(["workflow", "next", workflow, "m1"]);
    expect(next.stdout).toMatchObject({ data: { kind: "deterministic", node: "cmd" } });
    await runCli(["workflow", "execute", workflow, "m1"]);
  }

  test("evidence report folds events without hiding the failed attempt", async () => {
    await driveMixedRun();
    const { code, stdout } = await runCli(["evidence", "report", join(project, "wf"), "m1"]);
    expect(code).toBe(0);
    const data = stdout as {
      ok: true;
      data: {
        run_id: string;
        template: string;
        version: string;
        harness: string;
        current_node: string | null;
        iteration: number;
        verdict: string | null;
        branches: { pending: string[]; completed: string[]; failed: string[] };
        elapsed_ms: number;
        commands: Array<{ node: string; argv: string[]; exit_code: number }>;
        human_actions: Array<{ node: string; actor: string }>;
        artifacts: Array<{ save_as: string; value: unknown }>;
        entries: Array<{ kind: string; node?: string; verdict?: string; exit_code?: number }>;
        events: number;
      };
    };
    expect(data.data.run_id).toBe("m1");
    expect(data.data.template).toBe("mixed");
    expect(data.data.version).toBe("2.0.0");
    expect(data.data.harness).toBe("claude");
    expect(data.data.elapsed_ms).toBeGreaterThanOrEqual(0);
    // failed branch is not hidden: the failed submit is in the log
    const failedEntry = data.data.entries.find((e) => e.kind === "submit" && e.verdict === "failed");
    expect(failedEntry).toBeTruthy();
    expect(data.data.branches.failed).toContain("work");
    // completed command result
    const cmd = data.data.commands.find((c) => c.node === "cmd");
    expect(cmd).toMatchObject({ node: "cmd", argv: ["printf", "hello"], exit_code: 0 });
    // human action
    expect(data.data.human_actions.some((h) => h.node === "review" && h.actor === "reviewer")).toBe(true);
    // artifact
    expect(data.data.artifacts.some((a) => a.save_as === "items")).toBe(true);
  });

  test("trace renders events in append order", async () => {
    await driveMixedRun();
    const { code, stdout } = await runCli(["workflow", "trace", "m1"]);
    expect(code).toBe(0);
    const data = stdout as { data: Array<{ seq: number; event: { type: string; node?: string } }> };
    const seqs = data.data.map((l) => l.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(data.data[0].event.type).toBe("command");
  });

  test("graph --format mermaid starts with flowchart TD and includes nodes, edges, run status", async () => {
    await driveMixedRun();
    const { code, stdout } = await runCli(["workflow", "graph", join(project, "wf"), "m1"]);
    expect(code).toBe(0);
    const mermaid = (stdout as { data: string }).data;
    expect(mermaid.startsWith("flowchart TD")).toBe(true);
    expect(mermaid).toContain("work[work agent]");
    expect(mermaid).toContain("done[done graph]");
    expect(mermaid).toContain("start --> fan");
    expect(mermaid).toContain("status[");
  });
});

describe("cli manifest parity", () => {
  test("every registered command appears in the manifest with --json", async () => {
    const cli = createCli().cli;
    const runtime = new Set<string>();
    for (const command of cli.commands) {
      for (const alias of [command.name, ...command.aliasNames]) runtime.add(alias);
    }
    const manifest = cliManifest();
    expect(manifest.cli).toBe("gk");
    for (const entry of manifest.commands) {
      expect(COMMAND_NAMES).toContain(entry.name as (typeof COMMAND_NAMES)[number]);
      expect(runtime).toContain(entry.name.split(" ")[0]);
      expect(entry.options).toContain("--json");
    }
    expect(manifest.commands.length).toBe(COMMAND_NAMES.length);
  });

  test("generateCliManifest writes the file and stays byte-stable", async () => {
    const a = await generateCliManifest(project);
    const { readFile } = await import("node:fs/promises");
    const onDisk = JSON.parse(await readFile(join(project, "cli-manifest.json"), "utf8"));
    expect(onDisk).toEqual(a);
    expect(onDisk.commands.length).toBe(COMMAND_NAMES.length);
    await generateCliManifest(project);
    expect(JSON.parse(await readFile(join(project, "cli-manifest.json"), "utf8"))).toEqual(onDisk);
  });

  test("committed cli-manifest.json matches the registry", async () => {
    const { readFile } = await import("node:fs/promises");
    const committed = JSON.parse(await readFile(join(root, "cli-manifest.json"), "utf8"));
    expect(committed.commands.map((c: { name: string }) => c.name).sort()).toEqual([...COMMAND_NAMES].sort());
  });
});

describe("CLI read models exercise store resume", () => {
  test("status reads run documents restored from checkpoint after corruption", async () => {
    const loaded = await loadTemplate(fixture);
    await createRun(
      project,
      {
        run_id: "rc",
        template: "valid-chain",
        harness: "claude",
        status: "running",
        current_nodes: ["work"],
        pending_items: [],
        in_flight: {},
        iteration: 1,
        failures: 0,
        completed_deterministic_nodes: [],
        verdict: null,
      },
      { task: "x" },
      [],
    );
    await mutateRun(project, "rc", (d) => d);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(project, ".graphkit", "runs", "rc", "run.json"), "{corrupt");
    void loaded;
    const { code, stdout } = await runCli(["workflow", "status", "rc"]);
    expect(code).toBe(0);
    expect(stdout).toMatchObject({ ok: true, data: { run: { run_id: "rc", status: "running" } } });
  });
});
