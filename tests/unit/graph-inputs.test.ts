import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseInputs, recordRunInputs, requiredMissing } from "../../src/cli/graph-inputs.js";

function graphFile(inputs: string): string {
  const dir = mkdtempSync(join(tmpdir(), "gk-inputs-"));
  const file = join(dir, "graph.yaml");
  writeFileSync(
    file,
    `apiVersion: graphkit.dev/v2\nkind: Graph\nmetadata: { name: t }\ntopology: custom\nnodes:\n  a: { agent: A, objective: x }\ninputs:\n${inputs}`,
  );
  return file;
}

describe("parseInputs", () => {
  test("parses repeatable k=v flags, keeping = inside values", () => {
    expect(parseInputs(["region=us-east-1", "prompt=a=b"])).toEqual({ region: "us-east-1", prompt: "a=b" });
  });

  test("accepts a single flag and undefined", () => {
    expect(parseInputs("k=v")).toEqual({ k: "v" });
    expect(parseInputs(undefined)).toEqual({});
  });

  test("rejects a flag without k=v", () => {
    expect(() => parseInputs(["region"])).toThrow(/k=v/);
    expect(() => parseInputs(["=v"])).toThrow(/k=v/);
  });
});

describe("requiredMissing", () => {
  test("lists required inputs with no default and no provided value", () => {
    const file = graphFile("  region:\n    type: string\n    required: true\n  env:\n    type: string\n");
    expect(requiredMissing(file, {})).toEqual(["region"]);
  });

  test("a declared default satisfies required", () => {
    const file = graphFile("  env:\n    type: string\n    required: true\n    default: dev\n");
    expect(requiredMissing(file, {})).toEqual([]);
  });

  test("a provided value satisfies required", () => {
    const file = graphFile("  region:\n    type: string\n    required: true\n");
    expect(requiredMissing(file, { region: "us-east-1" })).toEqual([]);
  });

  test("optional inputs are never missing", () => {
    const file = graphFile("  env:\n    type: string\n    description: env\n");
    expect(requiredMissing(file, {})).toEqual([]);
  });

  test("unreadable or missing inputs yield no missing keys", () => {
    expect(requiredMissing(join(tmpdir(), "gk-inputs-does-not-exist", "graph.yaml"), {})).toEqual([]);
  });
});

describe("recordRunInputs", () => {
  test("merges provided inputs into the run meta", () => {
    const dir = mkdtempSync(join(tmpdir(), "gk-runmeta-"));
    writeFileSync(join(dir, "meta.json"), JSON.stringify({ id: "r1", graph: "t" }));
    recordRunInputs(dir, { region: "us-east-1" });
    const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf-8"));
    expect(meta.inputs).toEqual({ region: "us-east-1" });
    expect(meta.id).toBe("r1");
  });

  test("best-effort: a missing meta never throws", () => {
    const dir = mkdtempSync(join(tmpdir(), "gk-runmeta-"));
    mkdirSync(dir, { recursive: true });
    expect(() => recordRunInputs(dir, { k: "v" })).not.toThrow();
  });
});
