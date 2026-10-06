import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import type { GraphKitError } from "../../src/errors.js";
import { addEvidence, DEFAULT_MAX_BYTES, maxBytesFromConfig } from "../../src/evidence/store.js";
import { GraphSchema } from "../../src/schemas/graph.schema.js";

let cwd: string;
const graphYaml = `apiVersion: graphkit.dev/v2
kind: Graph
metadata:
  name: t
topology: diamond
nodes:
  probe:
    agent: a
    objective: o
    depend_on: []
    evidence: [api-response]
evidence:
  required_keys: [api-response]
`;

beforeEach(() => {
  cwd = join(tmpdir(), `gk-store-${process.pid}-${Date.now()}`);
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(cwd, "graph.yaml"), graphYaml);
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

function thrownCode(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return (e as GraphKitError).code;
  }
  throw new Error("expected a throw");
}

function graph() {
  return GraphSchema.parse(YAML.parse(readFileSync(join(cwd, "graph.yaml"), "utf-8")));
}

describe("addEvidence", () => {
  test("stores content-addressed artifact + marker, no .index", () => {
    writeFileSync(join(cwd, "resp.json"), '{"ok":true}');
    const out = addEvidence(cwd, graph(), {
      file: join(cwd, "resp.json"),
      key: "api-response",
      node: "probe",
      note: "n",
    });
    const sha = createHash("sha256").update('{"ok":true}').digest("hex");
    expect(out.sha256).toBe(sha);
    const artifact = join(cwd, ".graphkit", "evidence", "api-response", `${sha}.json`);
    expect(readFileSync(artifact, "utf-8")).toBe('{"ok":true}');

    const marker = readFileSync(join(cwd, ".graphkit", "evidence", "api-response.md"), "utf-8");
    expect(marker.startsWith("---\n")).toBe(true);
    expect(marker).toContain(`artifact: api-response/${sha}.json`);
    expect(marker).toContain(`artifact_sha256: ${sha}`);
    expect(marker.trimEnd().split("---").pop()!.trim().length).toBeGreaterThan(0); // ADR-002: non-whitespace body

    expect(existsSync(join(cwd, ".graphkit", "evidence", ".index"))).toBe(false);
  });

  test("same content twice reuses blob and rewrites marker", () => {
    writeFileSync(join(cwd, "resp.json"), '{"ok":true}');
    const a = addEvidence(cwd, graph(), { file: join(cwd, "resp.json"), key: "api-response" });
    const b = addEvidence(cwd, graph(), {
      file: join(cwd, "resp.json"),
      key: "api-response",
      note: "second",
    });
    expect(b.sha256).toBe(a.sha256);
    expect(readFileSync(join(cwd, ".graphkit", "evidence", "api-response.md"), "utf-8")).toContain("note: second");
  });

  test("key not declared → EVIDENCE_KEY_NOT_DECLARED", () => {
    writeFileSync(join(cwd, "x"), "x");
    expect(thrownCode(() => addEvidence(cwd, graph(), { file: join(cwd, "x"), key: "bogus" }))).toBe(
      "EVIDENCE_KEY_NOT_DECLARED",
    );
  });

  test("missing file → EVIDENCE_FILE_MISSING; oversize → EVIDENCE_TOO_LARGE", () => {
    expect(thrownCode(() => addEvidence(cwd, graph(), { file: join(cwd, "nope"), key: "api-response" }))).toBe(
      "EVIDENCE_FILE_MISSING",
    );
    writeFileSync(join(cwd, "big"), "x".repeat(11 * 1024 * 1024));
    expect(thrownCode(() => addEvidence(cwd, graph(), { file: join(cwd, "big"), key: "api-response" }))).toBe(
      "EVIDENCE_TOO_LARGE",
    );
    expect(() =>
      addEvidence(cwd, graph(), { file: join(cwd, "big"), key: "api-response", maxBytes: 12 * 1024 * 1024 }),
    ).not.toThrow();
  });

  test(".gk.json evidence_max_bytes overrides default", () => {
    expect(DEFAULT_MAX_BYTES).toBe(10 * 1024 * 1024);
    expect(maxBytesFromConfig(cwd)).toBe(DEFAULT_MAX_BYTES);
    writeFileSync(join(cwd, ".gk.json"), JSON.stringify({ evidence_max_bytes: 5 }));
    expect(maxBytesFromConfig(cwd)).toBe(5);
    writeFileSync(join(cwd, ".gk.json"), JSON.stringify({ evidence_max_bytes: "bad" }));
    expect(maxBytesFromConfig(cwd)).toBe(DEFAULT_MAX_BYTES);
  });
});
