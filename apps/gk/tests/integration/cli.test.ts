import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COMMAND_NAMES,
  cliManifest,
  createCli,
  generateCliManifest,
  manifestText,
} from "../../src/cli/command-registry.js";
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
    await runCli(["workflow", "submit", workflow, "m1", "approve", "--actor", "reviewer"]);
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
        commands: Array<{ node: string; executable: string; exit_code: number }>;
        human_actions: Array<{ node: string; actor: string }>;
        artifacts: Array<{ save_as: string }>;
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
    expect(data.data.branches.failed).toContain("i1");
    // completed command result (sanitized: executable, not full argv)
    const cmd = data.data.commands.find((c) => c.node === "cmd");
    expect(cmd).toMatchObject({ node: "cmd", executable: "printf", exit_code: 0 });
    // human action
    expect(data.data.human_actions.some((h) => h.node === "review" && h.actor === "reviewer")).toBe(true);
    // artifact identity, never payload values
    expect(data.data.artifacts.some((a) => a.save_as === "items")).toBe(true);
    expect(data.data.artifacts.every((a) => !("value" in a))).toBe(true);
  });

  test("trace renders events in append order", async () => {
    await driveMixedRun();
    const { code, stdout } = await runCli(["workflow", "trace", "m1"]);
    expect(code).toBe(0);
    const data = stdout as { data: Array<{ seq: number; event: { type: string; node?: string } }> };
    expect(data.data.map((l) => l.seq)).toEqual(data.data.map((_, index) => index));
    expect(data.data.map((l) => l.event.type)).toEqual([
      "command",
      "command",
      "dispatch",
      "submit",
      "submit",
      "command",
      "human",
      "submit",
      "command",
    ]);
    expect(data.data[0].event.type).toBe("command");
  });

  test("graph --format mermaid starts with flowchart TD and includes nodes, edges, run status", async () => {
    await driveMixedRun();
    const { code, stdout } = await runCli(["workflow", "graph", join(project, "wf"), "m1"]);
    expect(code).toBe(0);
    const mermaid = (stdout as { data: string }).data;
    expect(mermaid.startsWith("flowchart TD")).toBe(true);
    expect(mermaid).toContain('"work agent"');
    expect(mermaid).toContain('"done graph"');
    expect(mermaid).toMatch(/--> n\d/);
    expect(mermaid).toContain("status:");
  });
});

describe("cli manifest parity", () => {
  test("manifest matches the descriptor source exactly", async () => {
    const { CLI_COMMANDS } = await import("../../src/cli/command-registry.js");
    const manifest = cliManifest();
    expect(manifest.commands).toEqual(
      CLI_COMMANDS.map((d) => ({
        name: d.path,
        description: d.description,
        options: [
          "--json",
          ...d.options.map((o) => (o.default === undefined ? o.flag : `${o.flag} (default: ${o.default})`)),
        ],
      })),
    );
    expect(manifest.commands.map((c) => c.name)).toEqual(COMMAND_NAMES);
  });

  test("cac introspection exposes each full command family and descriptor options", async () => {
    const cli = createCli().cli;
    const raw = new Set(cli.commands.map((command) => command.rawName));
    expect(raw).toEqual(
      new Set([
        "template [subcommand] [...args]",
        "workflow [subcommand] [...args]",
        "evidence [subcommand] [...args]",
        "manifest [subcommand]",
      ]),
    );
    const globalFlags = cli.globalCommand.options.map((option) => option.rawName);
    for (const flag of ["--json", "--format <format>"]) expect(globalFlags).toContain(flag);
    const { CLI_COMMANDS } = await import("../../src/cli/command-registry.js");
    for (const descriptor of CLI_COMMANDS) {
      expect(descriptor.path.split(" ").length).toBe(2);
      expect(descriptor.options.every((o) => typeof o.flag === "string")).toBe(true);
    }
  });

  test("committed cli-manifest.json is byte-equivalent to generated manifest", async () => {
    const { readFile } = await import("node:fs/promises");
    const generated = await generateCliManifest(project);
    const regenerated = await readFile(join(project, "cli-manifest.json"), "utf8");
    const committed = await readFile(join(root, "cli-manifest.json"), "utf8");
    expect(generated).toEqual(cliManifest());
    expect(committed).toBe(regenerated);
  });

  test("generateCliManifest writes the descriptor manifest byte-stably", async () => {
    const a = await generateCliManifest(project);
    const { readFile } = await import("node:fs/promises");
    expect(JSON.parse(await readFile(join(project, "cli-manifest.json"), "utf8"))).toEqual(a);
    await generateCliManifest(project);
    expect(await readFile(join(project, "cli-manifest.json"), "utf8")).toBe(manifestText(a));
  });
});

describe("CLI parse failure channel", () => {
  test("unknown option emits one stdout envelope and no stderr JSON", async () => {
    const proc = Bun.spawn(["bun", gk, "template", "list", "--unknown"], {
      cwd: home,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, GRAPHKIT_PROJECT: project },
    });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    expect(await proc.exited).not.toBe(0);
    expect(stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(stdout)).toMatchObject({ ok: false, error: { code: "SCHEMA_VIOLATION" } });
    expect(stderr).not.toContain("{");
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

describe("graph --format mermaid option", () => {
  test("--format mermaid succeeds with one envelope", async () => {
    const { code, stdout } = await runCli(["workflow", "graph", fixture, "r1", "--format", "mermaid"]);
    expect(code).toBe(0);
    expect((stdout as { data: string }).data.startsWith("flowchart TD")).toBe(true);
    expect(stdout).toMatchObject({ ok: true });
  });

  test("unsupported --format fails one envelope, nonzero, stable code", async () => {
    const { code, stdout } = await runCli(["workflow", "graph", fixture, "r1", "--format", "dot"]);
    expect(code).not.toBe(0);
    expect(stdout).toMatchObject({ ok: false, error: { code: "SCHEMA_VIOLATION" } });
  });
});

describe("sensitive logging sanitization", () => {
  async function seededRun(): Promise<{ size: () => Promise<number> }> {
    await runCli(["workflow", "start", fixture, "s1", "--inputs", '{"task":"x"}']);
    await runCli(["workflow", "next", fixture, "s1"]);
    return { size: async () => 0 };
  }

  test("submit secret output is never persisted in events.jsonl", async () => {
    await seededRun();
    const secret = "super-secret-value-xyz";
    await runCli(["workflow", "submit", fixture, "s1", JSON.stringify({ summary: secret })]);
    const { readFile } = await import("node:fs/promises");
    const log = await readFile(join(project, ".graphkit", "runs", "s1", "events.jsonl"), "utf8");
    expect(log).not.toContain(secret);
    // verdict + work_item identities still present
    expect(log).toContain('"verdict":"passed"');
    const { code, stdout } = await runCli(["evidence", "report", fixture, "s1"]);
    expect(code).toBe(0);
    const report = JSON.stringify(stdout);
    expect(report).not.toContain(secret);
  });

  test("command argv secrets are never persisted; executable and exit_code are", async () => {
    const wf = join(project, "wf");
    await mkdir(join(wf, "schemas"), { recursive: true });
    await writeFile(join(wf, "schemas", "result.schema.json"), "{}");
    await writeFile(
      join(wf, "template.yaml"),
      `${["name: cmdsec", "version: 1.0.0", "apiVersion: graphkit.dev/v1alpha1", "harness: claude"].join("\n")}\n`,
    );
    await writeFile(
      join(wf, "workflow.yaml"),
      `${[
        "apiVersion: graphkit.dev/v1alpha1",
        "kind: Workflow",
        "metadata: { name: cmdsec }",
        "limits: { max_iterations: 2, max_workers: 1 }",
        "state: {}",
        "start: start",
        "nodes:",
        "  run:",
        "    type: command",
        "    command: [printf, topsecret-arg]",
        "  done: { type: graph, operation: complete-task }",
        "edges:",
        "  - { from: start, to: run }",
        "  - { from: run, to: done }",
        "terminal:",
        "  - { node: done, verdict: passed }",
      ].join("\n")}\n`,
    );
    await runCli(["workflow", "start", wf, "c1"]);
    await runCli(["workflow", "execute", wf, "c1"]);
    const { readFile } = await import("node:fs/promises");
    const log = await readFile(join(project, ".graphkit", "runs", "c1", "events.jsonl"), "utf8");
    expect(log).not.toContain("topsecret-arg");
    expect(log).toContain('"executable":"printf"');
    const { code, stdout } = await runCli(["evidence", "report", wf, "c1"]);
    expect(code).toBe(0);
    const report = JSON.stringify(stdout);
    expect(report).not.toContain("topsecret-arg");
    expect(report).toContain('"executable":"printf"');
  });
});

describe("branch evidence identity and persistence", () => {
  test("stale active lease yields a failed branch without calling next", async () => {
    const { createRun } = await import("../../src/runtime/store.js");
    await createRun(
      project,
      {
        run_id: "stale",
        template: "t",
        harness: "claude",
        status: "running",
        current_nodes: ["work"],
        pending_items: [],
        in_flight: { i1: "L1" },
        iteration: 0,
        failures: 0,
        completed_deterministic_nodes: [],
        verdict: null,
      },
      {},
      [
        {
          id: "L1",
          work_item: "i1",
          node: "work",
          issued_at: new Date(Date.now() - 60_000).toISOString(),
          expires_at: new Date(Date.now() - 30_000).toISOString(),
          status: "active",
        },
      ],
    );
    const { evidenceReport } = await import("../../src/commands/observability.js");
    const report = await evidenceReport(project, "stale", undefined);
    expect(report.branches.failed).toContain("i1");
  });

  test("failed command produces a failed branch item", async () => {
    const wf = join(project, "cf");
    await mkdir(join(wf, "schemas"), { recursive: true });
    await writeFile(join(wf, "schemas", "result.schema.json"), "{}");
    await writeFile(
      join(wf, "template.yaml"),
      `${["name: cf", "version: 1.0.0", "apiVersion: graphkit.dev/v1alpha1", "harness: claude"].join("\n")}\n`,
    );
    await writeFile(
      join(wf, "workflow.yaml"),
      `${[
        "apiVersion: graphkit.dev/v1alpha1",
        "kind: Workflow",
        "metadata: { name: cf }",
        "limits: { max_iterations: 2, max_workers: 1 }",
        "state: {}",
        "start: start",
        "nodes:",
        "  fail:",
        "    type: command",
        "    command: [sh, -c, exit 3]",
        "  done: { type: graph, operation: complete-task }",
        "edges:",
        "  - { from: start, to: fail }",
        "  - { from: fail, to: done }",
        "terminal:",
        "  - { node: done, verdict: passed }",
      ].join("\n")}\n`,
    );
    await runCli(["workflow", "start", wf, "cf1"]);
    await runCli(["workflow", "execute", wf, "cf1"]);
    const { code, stdout } = await runCli(["evidence", "report", wf, "cf1"]);
    expect(code).toBe(0);
    const data = stdout as { data: { branches: { failed: string[] } } };
    expect(data.data.branches.failed).toContain("fail");
  });

  test("two failed work items on same worker node stay distinct", async () => {
    const { createRun } = await import("../../src/runtime/store.js");
    await createRun(
      project,
      {
        run_id: "two",
        template: "t",
        harness: "claude",
        status: "running",
        current_nodes: ["work"],
        pending_items: [],
        in_flight: {},
        iteration: 1,
        failures: 2,
        completed_deterministic_nodes: [],
        verdict: null,
      },
      {},
      [
        {
          id: "L1",
          work_item: "a",
          node: "work",
          issued_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          status: "settled",
        },
        {
          id: "L2",
          work_item: "b",
          node: "work",
          issued_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          status: "settled",
        },
      ],
    );
    const { appendRunEvent } = await import("../../src/runtime/store.js");
    const { evidenceReport } = await import("../../src/commands/observability.js");
    await appendRunEvent(project, "two", {
      type: "submit",
      run_id: "two",
      node: "work",
      lease: "L1",
      timestamp: new Date().toISOString(),
      details: { verdict: "failed", work_item: "a" },
    });
    await appendRunEvent(project, "two", {
      type: "submit",
      run_id: "two",
      node: "work",
      lease: "L2",
      timestamp: new Date().toISOString(),
      details: { verdict: "failed", work_item: "b" },
    });
    const report = await evidenceReport(project, "two", undefined);
    expect(report.branches.failed).toContain("a");
    expect(report.branches.failed).toContain("b");
    expect(report.branches.failed).toHaveLength(2);
  });

  test("later successful retry does not erase the failed attempt", async () => {
    const { createRun } = await import("../../src/runtime/store.js");
    await createRun(
      project,
      {
        run_id: "retry",
        template: "t",
        harness: "claude",
        status: "running",
        current_nodes: ["work"],
        pending_items: [],
        in_flight: {},
        iteration: 1,
        failures: 1,
        completed_deterministic_nodes: [],
        verdict: null,
      },
      {},
      [],
    );
    const { appendRunEvent } = await import("../../src/runtime/store.js");
    const { evidenceReport } = await import("../../src/commands/observability.js");
    await appendRunEvent(project, "retry", {
      type: "submit",
      run_id: "retry",
      node: "work",
      lease: "L1",
      timestamp: new Date().toISOString(),
      details: { verdict: "failed", work_item: "x" },
    });
    await appendRunEvent(project, "retry", {
      type: "submit",
      run_id: "retry",
      node: "work",
      lease: "L2",
      timestamp: new Date().toISOString(),
      details: { verdict: "passed", work_item: "x" },
    });
    const report = await evidenceReport(project, "retry", undefined);
    expect(report.branches.failed).toContain("x");
    expect(report.entries.filter((e) => e.kind === "submit" && e.verdict === "failed")).toHaveLength(1);
  });
});

describe("mermaid escaping", () => {
  test("unusual node ids and labels produce deterministic quoted output", async () => {
    const wf = join(project, "weird");
    await mkdir(join(wf, "schemas"), { recursive: true });
    await writeFile(join(wf, "schemas", "result.schema.json"), "{}");
    await writeFile(
      join(wf, "template.yaml"),
      `${["name: weird", "version: 1.0.0", "apiVersion: graphkit.dev/v1alpha1", "harness: claude"].join("\n")}\n`,
    );
    await writeFile(
      join(wf, "workflow.yaml"),
      `${[
        "apiVersion: graphkit.dev/v1alpha1",
        "kind: Workflow",
        "metadata: { name: weird }",
        "limits: { max_iterations: 2, max_workers: 1 }",
        "state: {}",
        "start: start",
        "nodes:",
        '  "a weird node":',
        "    type: command",
        "    command: [sh, -c, exit 0]",
        "  done: { type: graph, operation: complete-task }",
        "edges:",
        '  - { from: "a weird node", to: done }',
        "terminal:",
        "  - { node: done, verdict: passed }",
      ].join("\n")}\n`,
    );
    const { code, stdout } = await runCli(["workflow", "graph", wf, "r1"]);
    expect(code).toBe(0);
    const mermaid = (stdout as { data: string }).data;
    expect(mermaid.startsWith("flowchart TD")).toBe(true);
    expect(mermaid).toContain('"a weird node command"');
    expect(mermaid).not.toContain("a weird node[");
  });

  test("distinct ids aab and aba map to distinct n-ids; control chars escaped and one-line", async () => {
    const { renderMermaid } = await import("../../src/commands/observability.js");
    const mermaid = renderMermaid({
      nodes: [
        { id: "n0", class: "command", label: "aab" },
        { id: "n1", class: "command", label: 'a"b\\c\nd' },
      ],
      edges: [{ from: "n0", to: "n1", label: 'x"y' }],
      status: "running",
      verdict: null,
      current: "n1",
    });
    expect(mermaid).toContain('n0["aab command"]');
    expect(mermaid).toContain('n1["a\\"b\\\\c\\nd command"]');
    expect(mermaid).toContain(' -- "label: x\\"y"');
    expect(mermaid.split("\n").every((line) => !line.includes("\n"))).toBe(true);
    expect(mermaid.split("\n").filter((line) => /^ {4}n\d+\[/.test(line)).length).toBe(2);
  });

  test("real workflow graph maps each node to a unique n-id in sorted order", async () => {
    const { mermaidGraph } = await import("../../src/commands/observability.js");
    const loaded = await loadTemplate(fixture);
    const graph = await mermaidGraph(loaded, project, "no-such-run");
    const ids = graph.nodes.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(["n0", "n1"]);
    expect(graph.nodes.map((n) => n.label)).toEqual(["complete", "work"]);
    expect(new Set(graph.nodes.map((n) => n.id)).size).toBe(2);
    expect(graph.nodes.find((n) => n.label === "complete")?.id).toBe("n0");
    expect(graph.nodes.find((n) => n.label === "work")?.id).toBe("n1");
  });
});

describe("human action receipts and legacy payload sanitization", () => {
  const humanWf = () => {
    const wf = join(project, "hum");
    return mkdir(join(wf, "schemas"), { recursive: true }).then(async () => {
      await writeFile(join(wf, "schemas", "result.schema.json"), "{}");
      await writeFile(
        join(wf, "template.yaml"),
        `${["name: hum", "version: 1.0.0", "apiVersion: graphkit.dev/v1alpha1", "harness: claude"].join("\n")}\n`,
      );
      await writeFile(
        join(wf, "workflow.yaml"),
        `${[
          "apiVersion: graphkit.dev/v1alpha1",
          "kind: Workflow",
          "metadata: { name: hum }",
          "limits: { max_iterations: 2, max_workers: 1 }",
          "state: {}",
          "start: start",
          "nodes:",
          "  review:",
          "    type: human",
          "    prompt: Approve?",
          "    actions: [approve, reject]",
          "  done: { type: graph, operation: complete-task }",
          "edges:",
          "  - { from: start, to: review }",
          "  - { from: review, to: done }",
          "terminal:",
          "  - { node: done, verdict: passed }",
        ].join("\n")}\n`,
      );
      return wf;
    });
  };

  test("undeclared human action is rejected, absent from events and evidence", async () => {
    const wf = await humanWf();
    await runCli(["workflow", "start", wf, "h1"]);
    const secret = "super-secret-action-xyz";
    const { code, stdout } = await runCli(["workflow", "submit", wf, "h1", secret]);
    expect(code).not.toBe(0);
    expect(stdout).toMatchObject({ ok: false, error: { code: "SCHEMA_VIOLATION" } });
    const { readFile } = await import("node:fs/promises");
    const log = await readFile(join(project, ".graphkit", "runs", "h1", "events.jsonl"), "utf8");
    expect(log).not.toContain(secret);
    const ev = await runCli(["evidence", "report", wf, "h1"]);
    expect(JSON.stringify(ev.stdout)).not.toContain(secret);
  });

  test("declared human action is bounded and present as receipt", async () => {
    const wf = await humanWf();
    await runCli(["workflow", "start", wf, "h2"]);
    const ok = await runCli(["workflow", "submit", wf, "h2", "approve", "--actor", "reviewer"]);
    expect(ok.code).toBe(0);
    const { readFile } = await import("node:fs/promises");
    const log = await readFile(join(project, ".graphkit", "runs", "h2", "events.jsonl"), "utf8");
    expect(log).toContain('"action":"approve"');
    const ev = await runCli(["evidence", "report", wf, "h2"]);
    expect(JSON.stringify(ev.stdout)).toContain('"action":"approve"');
    const tr = await runCli(["workflow", "trace", "h2"]);
    expect(JSON.stringify(tr.stdout)).toContain('"action":"approve"');
  });

  test("manually injected legacy details.secret is dropped from evidence and trace", async () => {
    const { createRun, appendRunEvent } = await import("../../src/runtime/store.js");
    const secret = "legacy-secret-payload";
    await createRun(
      project,
      {
        run_id: "legacy",
        template: "t",
        harness: "claude",
        status: "running",
        current_nodes: ["work"],
        pending_items: [],
        in_flight: {},
        iteration: 0,
        failures: 0,
        completed_deterministic_nodes: [],
        verdict: null,
      },
      {},
      [],
    );
    await appendRunEvent(project, "legacy", {
      type: "submit",
      run_id: "legacy",
      node: "work",
      lease: "L1",
      timestamp: new Date().toISOString(),
      details: { verdict: "passed", work_item: "i1", secret, raw_output: { leak: secret } },
    });
    const { evidenceReport, traceRun } = await import("../../src/commands/observability.js");
    const report = await evidenceReport(project, "legacy", undefined);
    expect(JSON.stringify(report)).not.toContain(secret);
    expect(report.entries[0].details).toEqual({ verdict: "passed", work_item: "i1" });
    const trace = await traceRun(project, "legacy");
    expect(JSON.stringify(trace)).not.toContain(secret);
  });
});
