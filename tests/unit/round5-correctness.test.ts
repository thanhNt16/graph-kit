// Round 5 A4–A9 correctness batch: failing-first repros, one describe per item.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { registerEvidenceCommand } from "../../src/cli/commands/evidence.js";
import { registerGraphCommands } from "../../src/cli/commands/graph.js";
import { registerMemoryCommands } from "../../src/cli/commands/memory.js";
import { renderSvg } from "../../src/cli/svg.js";
import { loadCriteria } from "../../src/evidence/criteria.js";
import { consolidate } from "../../src/memory/consolidate.js";
import { expandedRecall } from "../../src/memory/recall-expanded.js";
import { createCliHarness } from "../helpers/cli-harness.js";

function tmpProject(tag: string): string {
  const cwd = join(tmpdir(), `gk-r5-${tag}-${process.pid}-${Date.now()}`);
  mkdirSync(join(cwd, ".graphkit"), { recursive: true });
  return cwd;
}

const simpleYaml = `apiVersion: graphkit.dev/v2
kind: Graph
metadata:
  name: t
topology: diamond
nodes:
  a:
    agent: a
    objective: o
    depend_on: []
`;

describe("A4: consolidate tolerates a directory named *.md and envelopes failures", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = tmpProject("cons");
    // one ended run so consolidate has ledger input
    const runDir = join(cwd, ".graphkit", "runs", "20260913-100000-t");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "trace.jsonl"), "");
    writeFileSync(
      join(cwd, ".graphkit", "runs", "index.jsonl"),
      `${JSON.stringify({ id: "20260913-100000-t", graph: "t", graph_sha256: "x", started_at: "2026-09-13T10:00:00Z", ended_at: "2026-09-13T10:01:00Z", status: "merged", node_count: 0, failures: 0, evidence_keys: [] })}\n`,
    );
    writeFileSync(join(cwd, "graph.yaml"), simpleYaml);
    // hostile: a DIRECTORY named like a generated entry, in pruned dirs
    mkdirSync(join(cwd, ".graphkit", "memory", "patterns", "boom.md"), { recursive: true });
    mkdirSync(join(cwd, ".graphkit", "memory", "suggestions"), { recursive: true });
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  test("consolidate() does not EISDIR on the hostile dir", () => {
    const result = consolidate(cwd);
    expect(result.runs).toBe(1);
    expect(existsSync(join(cwd, ".graphkit", "memory", "index.md"))).toBe(true);
  });

  test("CLI consolidate action fails with an envelope, never a raw stack", () => {
    // .graphkit/memory replaced by a FILE → mkdirSync inside consolidate throws
    rmSync(join(cwd, ".graphkit", "memory"), { recursive: true, force: true });
    writeFileSync(join(cwd, ".graphkit", "memory"), "not a dir");
    const run = createCliHarness(registerMemoryCommands, { cwd }).run(["memory", "consolidate"]);
    const parsed = JSON.parse(run.stdout);
    expect(parsed.status).toBe("fail");
    expect(parsed.error.code).toBe("CONSOLIDATE_ERROR");
  });
});

describe("A5: proposed suggestions are recallable, not 'malformed'", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = tmpProject("sugg");
    const mem = join(cwd, ".graphkit", "memory");
    mkdirSync(join(mem, "suggestions"), { recursive: true });
    writeFileSync(
      join(mem, "note.md"),
      `---\nid: note-1\ntype: knowledge\nstatus: draft\nsalience: 0.8\ncreated_at: 2026-09-13T00:00:00Z\nvalid_from: 2026-09-13T00:00:00Z\n---\ndeploy pipeline runs on friday\n`,
    );
    // exact consolidate output shape (consolidate.ts writeEntry)
    writeFileSync(
      join(mem, "suggestions", "suggestion-abc12345.md"),
      `---\nid: suggestion-abc12345\ntype: suggestion\naction: capture-skill\nrationale: "The chain \\"shipit flow\\" recurred — capture it."\nbased_on:\n  - pattern-x\nstatus: proposed\ncreated_at: 2026-09-13T00:00:00Z\nvalid_from: 2026-09-13T00:00:00Z\nsalience: 0.6\nexpired: false\ntags:\n  - capture-skill\ngenerated:\n  by: process:gk-memory-consolidate\n  at: 2026-09-13T00:00:00Z\nrecorded_at: 2026-09-13T00:00:00Z\n---\nThe chain "shipit flow" recurred — capture it.\n`,
    );
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  test("suggestion matches recall; malformed stays 0", () => {
    const out = expandedRecall(join(cwd, ".graphkit", "memory"), "shipit flow", 5);
    expect(out.malformed).toBe(0);
    expect(out.results.map((r) => r.id)).toContain("suggestion-abc12345");
  });
});

describe("A6: loadCriteria is CRLF-tolerant", () => {
  test("CRLF criteria file keeps kind and a clean description", () => {
    const cwd = tmpProject("crit");
    mkdirSync(join(cwd, "criteria"), { recursive: true });
    writeFileSync(
      join(cwd, "criteria", "deploy-pass.md"),
      "---\r\nid: deploy-pass\r\nkind: screenshot\r\n---\r\nA screenshot of the deploy.\r\n",
    );
    const crit = loadCriteria(cwd, ["deploy-pass"]).get("deploy-pass");
    expect(crit?.kind).toBe("screenshot");
    expect(crit?.description).toBe("A screenshot of the deploy.");
    rmSync(cwd, { recursive: true, force: true });
  });
});

describe("A7: evidence add accepts absolute artifact paths", () => {
  let cwd: string;
  let absArtifact: string;
  beforeEach(() => {
    cwd = tmpProject("evadd");
    writeFileSync(join(cwd, "graph.yaml"), `${simpleYaml}evidence:\n  required_keys: [k]\n`);
    mkdirSync(join(cwd, ".graphkit", "evidence"), { recursive: true });
    absArtifact = join(tmpdir(), `gk-r5-artifact-${process.pid}-${Date.now()}.md`);
    writeFileSync(absArtifact, "artifact body — absolute path is the caller's choice\n");
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(absArtifact, { force: true });
  });

  test("absolute path is not joined onto cwd", () => {
    const run = createCliHarness(registerEvidenceCommand, { cwd }).run(["evidence", "add", absArtifact, "--key", "k"]);
    const parsed = JSON.parse(run.stdout);
    expect(parsed.status).toBe("ok");
    expect(existsSync(join(cwd, ".graphkit", "evidence", "k.md"))).toBe(true);
  });
});

describe("A8: corrupt active session graph fails with YAML_INVALID, not a raw parse error", () => {
  test("bare validate surfaces YAML_INVALID with the file field", () => {
    const cwd = tmpProject("active");
    const id = "2026-09-13-broken";
    writeFileSync(join(cwd, ".graphkit", "active"), id);
    mkdirSync(join(cwd, ".graphkit", "graphs"), { recursive: true });
    writeFileSync(join(cwd, ".graphkit", "graphs", `${id}.yaml`), "metadata: [unclosed\n");
    const run = createCliHarness(registerGraphCommands, { cwd }).run(["validate"]);
    const parsed = JSON.parse(run.stdout);
    expect(parsed.status).toBe("fail");
    expect(parsed.error.code).toBe("YAML_INVALID");
    expect(parsed.error.details.file).toContain("broken.yaml");
    rmSync(cwd, { recursive: true, force: true });
  });
});

describe("A9: svg escapes agent-authored text", () => {
  test("node ids and titles cannot inject markup", () => {
    const graph = YAML.parse(`apiVersion: graphkit.dev/v2
kind: Graph
metadata:
  name: "<script>alert(1)</script>"
topology: diamond
nodes:
  "<img src=x onerror=alert(2)>":
    agent: "a<b>"
    objective: o
    depend_on: []
`);
    const svg = renderSvg(graph);
    expect(svg).not.toContain("<script>alert(1)</script>");
    expect(svg).not.toContain("<img src=x");
    expect(svg).toContain("&lt;script&gt;");
    expect(svg).toContain("&lt;img");
  });
});
