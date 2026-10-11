import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cac } from "cac";
import { loadGraph } from "../../src/cli/commands/graph.js";
import { registerRunCommands } from "../../src/cli/commands/run.js";
import { addEvidence } from "../../src/evidence/store.js";
import { appendNode, endRun, startRun, verifyTraceChain } from "../../src/runs/ledger.js";

function runCli(args: string[], cwd: string) {
  const cli = cac("gk");
  registerRunCommands(cli);
  const logs: string[] = [];
  const origLog = console.log;
  const origCwd = process.cwd();
  console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  process.chdir(cwd);
  try {
    cli.parse(["node", "gk", ...args], { run: true });
  } finally {
    console.log = origLog;
    process.chdir(origCwd);
  }
  const code = process.exitCode ? Number(process.exitCode) : 0;
  process.exitCode = 0; // fail() sets exitCode=1 — reset so bun:test exits 0
  return { stdout: logs.join("\n"), code };
}

const GRAPH =
  "apiVersion: graphkit.dev/v2\nkind: Graph\nmetadata:\n  name: verify-graph\ntopology: custom\nevidence:\n  required_keys: [spec]\nnodes:\n  alpha:\n    agent: a\n    objective: do alpha\n  beta:\n    agent: b\n    objective: do beta\n";

describe("gk run verify — hash-chained trace", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = join(tmpdir(), `gk-verify-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(cwd, "graph.yaml"), GRAPH);
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  function startWithTwoLines() {
    const { id } = startRun(cwd, join(cwd, "graph.yaml"), "2026-10-11T10:00:00.000Z");
    appendNode(cwd, {
      node: "alpha",
      wave: 0,
      agent: "a",
      model: null,
      status: "ok",
      evidence: [],
      duration_ms: 10,
      notes: null,
    });
    appendNode(cwd, {
      node: "beta",
      wave: 0,
      agent: "b",
      model: null,
      status: "fail",
      evidence: [],
      duration_ms: 20,
      notes: "boom",
    });
    endRun(cwd, "failed");
    return id;
  }

  const tracePath = (id: string) => join(cwd, ".graphkit", "runs", id, "trace.jsonl");

  test("fresh lines carry prev/hash and verify OK", () => {
    const id = startWithTwoLines();
    const lines = readFileSync(tracePath(id), "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines[0].prev).toBe("genesis");
    expect(lines[0].hash).toMatch(/^[0-9a-f]{64}$/);
    expect(lines[1].prev).toBe(lines[0].hash);
    const verdict = verifyTraceChain(cwd, id);
    expect(verdict).toMatchObject({ ok: true, lines: 2, legacy_lines: 0, chained_lines: 2, divergence: null });
    const res = JSON.parse(runCli(["run", "verify", id], cwd).stdout);
    expect(res.status).toBe("ok");
    expect(res.data.verdict).toBe("OK");
    expect(res.data.chained_lines).toBe(2);
  });

  test("corrupting a middle line's bytes flags that index", () => {
    const id = startWithTwoLines();
    const f = tracePath(id);
    const lines = readFileSync(f, "utf-8").trim().split("\n");
    const mid = JSON.parse(lines[0]);
    mid.notes = "tampered"; // rewrite payload without re-sealing
    lines[0] = JSON.stringify(mid);
    writeFileSync(f, `${lines.join("\n")}\n`);
    const verdict = verifyTraceChain(cwd, id);
    expect(verdict.ok).toBe(false);
    expect(verdict.divergence?.index).toBe(0);
    expect(verdict.divergence?.kind).toBe("hash");
    const res = runCli(["run", "verify", id], cwd);
    expect(res.code).toBe(1);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.error.code).toBe("RUN_TAMPERED");
    expect(parsed.error.details.divergence.index).toBe(0);
  });

  test("a forged prev is flagged", () => {
    const id = startWithTwoLines();
    const f = tracePath(id);
    const lines = readFileSync(f, "utf-8").trim().split("\n");
    const second = JSON.parse(lines[1]);
    second.prev = "0".repeat(64);
    lines[1] = JSON.stringify(second);
    writeFileSync(f, `${lines.join("\n")}\n`);
    const verdict = verifyTraceChain(cwd, id);
    expect(verdict.ok).toBe(false);
    expect(verdict.divergence?.index).toBe(1);
    expect(verdict.divergence?.kind).toBe("prev");
  });

  test("legacy hashless prefix is reported, not failed; mid-chain hashless is flagged", () => {
    const { id } = startRun(cwd, join(cwd, "graph.yaml"), "2026-10-11T10:00:00.000Z");
    // Hand-write a pre-chain line, then a chained line on top of it.
    writeFileSync(
      tracePath(id),
      `${JSON.stringify({ at: "2026-01-01T00:00:00.000Z", node: "old", wave: 0, agent: null, model: null, status: "ok", evidence: [], duration_ms: 1, notes: null })}\n`,
    );
    appendNode(cwd, {
      node: "alpha",
      wave: 0,
      agent: null,
      model: null,
      status: "ok",
      evidence: [],
      duration_ms: 1,
      notes: null,
    });
    endRun(cwd, "merged");
    const verdict = verifyTraceChain(cwd, id);
    expect(verdict).toMatchObject({ ok: true, lines: 2, legacy_lines: 1, chained_lines: 1 });
    // A hashless line AFTER the chain began = tamper evidence.
    const f = tracePath(id);
    writeFileSync(f, `${readFileSync(f, "utf-8")}${JSON.stringify({ node: "sneaky", status: "ok" })}\n`);
    const after = verifyTraceChain(cwd, id);
    expect(after.ok).toBe(false);
    expect(after.divergence?.kind).toBe("missing_hash");
    expect(after.divergence?.index).toBe(2);
  });

  test("--evidence catches a modified artifact file", () => {
    const { id } = startRun(cwd, join(cwd, "graph.yaml"), "2026-10-11T10:00:00.000Z");
    const src = join(cwd, "spec.md");
    writeFileSync(src, "# spec v1\n");
    const graph = loadGraph(join(cwd, "graph.yaml"));
    const added = addEvidence(cwd, graph, { file: src, key: "spec", node: "alpha" });
    endRun(cwd, "merged");
    // Baseline: clean verify incl. evidence.
    const clean = JSON.parse(runCli(["run", "verify", id, "--evidence"], cwd).stdout);
    expect(clean.status).toBe("ok");
    expect(clean.data.evidence).toEqual({ checked: 1, mismatches: [] });
    // Tamper the artifact bytes in place.
    writeFileSync(join(cwd, ".graphkit", "evidence", added.artifact), "# spec EVIL\n");
    const res = runCli(["run", "verify", id, "--evidence"], cwd);
    expect(res.code).toBe(1);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.error.code).toBe("RUN_TAMPERED");
    expect(parsed.error.details.evidence.mismatches).toHaveLength(1);
    expect(parsed.error.details.evidence.mismatches[0].expected).toBe(added.sha256);
  });

  test("unknown run id fails", () => {
    const res = runCli(["run", "verify", "20990101-000000-nope"], cwd);
    expect(res.code).toBe(1);
    expect(JSON.parse(res.stdout).error.code).toBe("RESUME_RUN_NOT_FOUND");
  });
});
