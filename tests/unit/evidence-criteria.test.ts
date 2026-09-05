import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { loadCriteria } from "../../src/evidence/criteria.js";
import { GraphSchema } from "../../src/schemas/graph.schema.js";
import { validateGraph } from "../../src/compiler/validate.js";

let cwd: string;
beforeEach(() => {
  cwd = join(tmpdir(), `gk-crit-${process.pid}-${Date.now()}`);
  mkdirSync(join(cwd, "criteria"), { recursive: true });
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

function graphObj(ev: unknown) {
  return YAML.parse(
    YAML.stringify({
      apiVersion: "graphkit.dev/v2",
      kind: "Graph",
      metadata: { name: "t" },
      topology: "diamond",
      nodes: { probe: { agent: "a", objective: "o", depend_on: [], evidence: ["api-response"] } },
      evidence: ev,
    }),
  );
}
function parseGraph(ev: unknown) {
  return GraphSchema.parse(graphObj(ev));
}

describe("criteria schema + validation", () => {
  test("criteria is an id list; freshness defaults to report", () => {
    const g = parseGraph({
      required_keys: ["api-response"],
      criteria: ["api-response"],
      freshness: "strict",
    });
    expect(g.evidence.criteria).toEqual(["api-response"]);
    expect(g.evidence.freshness).toBe("strict");
    expect(parseGraph({ required_keys: ["api-response"] }).evidence.freshness).toBe("report");
  });

  test("rejects object entries and bad freshness", () => {
    expect(
      GraphSchema.safeParse(graphObj({ required_keys: ["api-response"], criteria: [{ id: "api-response" }] }))
        .success,
    ).toBe(false);
    expect(GraphSchema.safeParse(graphObj({ required_keys: ["api-response"], freshness: "always" })).success).toBe(
      false,
    );
  });

  test("criteria-keys rejects orphans and duplicates", () => {
    const orphan = parseGraph({ required_keys: ["api-response"], criteria: ["nope"] });
    expect(
      validateGraph(orphan, cwd).some((f) => f.check === "criteria-keys" && f.message.includes("nope")),
    ).toBe(true);

    const dup = parseGraph({ required_keys: ["api-response"], criteria: ["api-response", "api-response"] });
    expect(
      validateGraph(dup, cwd).some((f) => f.check === "criteria-keys" && f.message.includes("Duplicate")),
    ).toBe(true);
  });

  test("criteria-file rejects missing registry file and id mismatch", () => {
    writeFileSync(join(cwd, "criteria", "api-response.md"), "---\nkind: json\n---\nGET /users returns 200\n");
    const okGraph = parseGraph({ required_keys: ["api-response"], criteria: ["api-response"] });
    expect(
      validateGraph(okGraph, cwd).filter((f) => f.check === "criteria-file" || f.check === "criteria-keys"),
    ).toEqual([]);

    const missing = parseGraph({ required_keys: ["api-response"], criteria: ["api-response"] });
    rmSync(join(cwd, "criteria", "api-response.md"));
    expect(
      validateGraph(missing, cwd).some((f) => f.check === "criteria-file" && f.message.includes("api-response")),
    ).toBe(true);

    writeFileSync(join(cwd, "criteria", "api-response.md"), "---\nid: other\nkind: json\n---\nbody\n");
    expect(
      validateGraph(missing, cwd).some((f) => f.check === "criteria-file" && f.message.includes("id")),
    ).toBe(true);
  });

  test("loadCriteria: kind default, body is description, never throws", () => {
    writeFileSync(join(cwd, "criteria", "a.md"), "---\nkind: screenshot\n---\nshot of the thing\n");
    writeFileSync(join(cwd, "criteria", "b.md"), "just a body\n");
    const m = loadCriteria(cwd, ["a", "b", "missing"]);
    expect(m.get("a")).toEqual({ id: "a", description: "shot of the thing", kind: "screenshot" });
    expect(m.get("b")).toEqual({ id: "b", description: "just a body", kind: "report" });
    expect(m.get("missing")).toEqual({ id: "missing", description: "", kind: "report" });
  });
});
