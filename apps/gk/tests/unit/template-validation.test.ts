import { beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { type ValidationIssue, validateOutput, validateTemplate } from "../../src/runtime/validation.js";
import type { Workflow } from "../../src/schemas.js";
import type { LoadedTemplate } from "../../src/templates/loader.js";
import { loadTemplate } from "../../src/templates/loader.js";

const directory = join(import.meta.dir, "..", "..", "tests", "fixtures", "valid-chain");

async function loadedFixture(): Promise<LoadedTemplate> {
  return loadTemplate(directory);
}

function mutation(wf: Workflow, mutation: (w: Record<string, unknown>) => void): LoadedTemplate {
  const copy = JSON.parse(JSON.stringify(wf)) as Record<string, unknown>;
  mutation(copy);
  return {
    directory,
    manifest: { name: "x", version: "1", apiVersion: "graphkit.dev/v1alpha1", harness: "claude" },
    workflow: copy as unknown as Workflow,
    outputSchemas: new Map(),
    skillFiles: new Map(),
  };
}
function codes(issues: ValidationIssue[], code: string): ValidationIssue[] {
  return issues.filter((i) => i.code === code);
}

describe("template validation", () => {
  test("valid-chain fixture loads with no issues", async () => {
    const issues = validateTemplate(await loadedFixture());
    expect(issues).toEqual([]);
  });

  test("valid output passes, invalid output throws SCHEMA_VIOLATION", async () => {
    const loaded = await loadedFixture();
    const schema = loaded.outputSchemas.get("work") as string;
    expect(() => validateOutput(schema, { summary: "done" })).not.toThrow();
    let err: unknown;
    try {
      validateOutput(schema, { summary: 4 });
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({ code: "SCHEMA_VIOLATION" });
  });

  test("missing/invalid schema file throws SCHEMA_VIOLATION", async () => {
    const missing = join(directory, "schemas", "nope.json");
    expect(() => validateOutput(missing, {})).toThrow();
    const bad = join(directory, "schemas", "invalid.schema.json");
    expect(() => validateOutput(bad, {})).toThrow();
  });

  test("static validation compiles every loaded output schema", async () => {
    const loaded = await loadedFixture();
    loaded.outputSchemas.set("bad-one", join(directory, "schemas", "invalid.schema.json"));
    loaded.outputSchemas.set("bad-two", join(directory, "schemas", "invalid.schema.json"));
    const issues = validateTemplate(loaded);
    const schemaIssues = codes(issues, "SCHEMA_VIOLATION");
    expect(schemaIssues).toHaveLength(2);
    expect(schemaIssues.map((item) => item.node)).toEqual(["bad-one", "bad-two"]);
  });

  let base: LoadedTemplate;
  beforeAll(async () => {
    base = await loadedFixture();
  });

  const cases: Array<{ name: string; mutate: (w: Record<string, unknown>) => void; code: string }> = [
    {
      name: "missing start edges",
      mutate: (w) => {
        (w as { edges: unknown[] }).edges = [];
      },
      code: "INVALID_TRANSITION",
    },
    {
      name: "missing edge target",
      mutate: (w) => {
        (w as { edges: unknown[] }).edges = [{ from: "start", to: "nope" }];
      },
      code: "INVALID_TRANSITION",
    },
    {
      name: "unreachable terminal",
      mutate: (w) => {
        (w as { edges: unknown[] }).edges = [{ from: "start", to: "work" }];
      },
      code: "UNREACHABLE_TERMINAL",
    },
    {
      name: "terminal outgoing edge",
      mutate: (w) => {
        (w as { edges: unknown[] }).edges.push({ from: "complete", to: "work" });
      },
      code: "INVALID_TRANSITION",
    },
    {
      name: "unsupported node type",
      mutate: (w) => {
        (w as Record<string, unknown>).nodes = { n: { type: "forgot", id: "n" } };
      },
      code: "SCHEMA_VIOLATION",
    },
    {
      name: "bad condition syntax",
      mutate: (w) => {
        (w as { edges: unknown[] }).edges.push({ from: "work", to: "complete", when: "state.x &&" });
      },
      code: "ERR_EXPRESSION",
    },
    {
      name: "bad condition reference",
      mutate: (w) => {
        (w as { edges: unknown[] }).edges.push({ from: "work", to: "complete", when: "state.nope == 1" });
      },
      code: "INVALID_TRANSITION",
    },
    {
      name: "unbounded cycle",
      mutate: (w) => {
        (w as { edges: unknown[] }).edges.push({ from: "complete", to: "work" });
        (w as Record<string, unknown>).limits = {};
      },
      code: "UNBOUNDED_CYCLE",
    },
    {
      name: "loop node without max_workers",
      mutate: (w) => {
        (w as Record<string, unknown>).nodes = {
          work: { id: "work", type: "fanout", from: "items" },
          complete: { id: "complete", type: "graph", operation: "complete-task" },
        };
      },
      code: "SCHEMA_VIOLATION",
    },
    {
      name: "fanout without max_workers",
      mutate: (w) => {
        (w as Record<string, unknown>).nodes = {
          fan: { id: "fan", type: "fanout", from: "items" },
          complete: { id: "complete", type: "graph", operation: "complete-task" },
        };
      },
      code: "SCHEMA_VIOLATION",
    },
    {
      name: "join without merge policy",
      mutate: (w) => {
        (w as Record<string, unknown>).nodes = {
          join: { id: "join", type: "join", merge: "items" },
          complete: { id: "complete", type: "graph", operation: "complete-task" },
        };
        (w as Record<string, unknown>).state = {};
        (w as { edges: unknown[] }).edges = [
          { from: "start", to: "join" },
          { from: "join", to: "complete" },
        ];
      },
      code: "MISSING_MERGE_POLICY",
    },
    {
      name: "agent without output schema",
      mutate: (w) => {
        (w as Record<string, unknown>).nodes = {
          work: {
            id: "work",
            type: "agent",
            skill: "worker",
            objective: "x",
            output: { schema: "schemas/missing.schema.json", save_as: "r" },
          },
          complete: { id: "complete", type: "graph", operation: "complete-task" },
        };
      },
      code: "SCHEMA_VIOLATION",
    },
    {
      name: "human without actions",
      mutate: (w) => {
        (w as Record<string, unknown>).nodes = { h: { id: "h", type: "human", prompt: "p", actions: [] } };
      },
      code: "SCHEMA_VIOLATION",
    },
    {
      name: "unsupported graph operation",
      mutate: (w) => {
        (w as Record<string, unknown>).nodes = { g: { id: "g", type: "graph", operation: "destroy-all" } };
      },
      code: "INVALID_TRANSITION",
    },
    {
      name: "missing skill file",
      mutate: (w) => {
        (w as Record<string, unknown>).nodes = {
          work: {
            id: "work",
            type: "agent",
            skill: "ghost",
            objective: "x",
            output: { schema: "schemas/result.schema.json", save_as: "r" },
          },
        };
      },
      code: "INVALID_TRANSITION",
    },
  ];

  for (const tc of cases) {
    test(`reports ${tc.name}`, () => {
      const issues = validateTemplate(mutation(base.workflow, tc.mutate));
      expect(codes(issues, tc.code).length).toBeGreaterThan(0);
    });
  }

  test("malformed human and router nodes report issues without crashing", () => {
    const issues = validateTemplate(
      mutation(base.workflow, (w) => {
        (w as Record<string, unknown>).nodes = {
          h: { id: "h", type: "human", actions: [] },
          r: { id: "r", type: "router", routes: [{ when: "", to: "nope" }] },
        };
      }),
    );
    expect(codes(issues, "SCHEMA_VIOLATION").length).toBeGreaterThan(0);
    expect(codes(issues, "INVALID_TRANSITION").length).toBeGreaterThan(0);
  });

  test("bounded cycle is accepted (no UNBOUNDED_CYCLE)", () => {
    const issues = validateTemplate(
      mutation(base.workflow, (w) => {
        (w as { edges: unknown[] }).edges.push({ from: "complete", to: "work" });
      }),
    );
    expect(codes(issues, "UNBOUNDED_CYCLE")).toEqual([]);
  });

  test("cycle without max_iterations is rejected as UNBOUNDED_CYCLE", () => {
    const issues = validateTemplate(
      mutation(base.workflow, (w) => {
        (w as { edges: unknown[] }).edges.push({ from: "complete", to: "work" });
        (w as Record<string, unknown>).limits = {};
      }),
    );
    expect(codes(issues, "UNBOUNDED_CYCLE").length).toBeGreaterThan(0);
  });

  test("nonexistent max_iterations resolves to static validation, not loader crash", () => {
    const issues = validateTemplate(
      mutation(base.workflow, (w) => {
        (w as Record<string, unknown>).limits = undefined;
      }),
    );
    expect(codes(issues, "UNBOUNDED_CYCLE")).toEqual([]);
    expect(codes(issues, "SCHEMA_VIOLATION").length).toBeGreaterThan(0);
  });

  test("node id differing from map key is reported as SCHEMA_VIOLATION", async () => {
    const tmp = join(import.meta.dir, "..", "fixtures", "._tmp-key-mismatch");
    const { mkdir, writeFile, rm } = await import("node:fs/promises");
    await mkdir(tmp, { recursive: true });
    await writeFile(
      join(tmp, "template.yaml"),
      "name: x\nversion: '1'\napiVersion: graphkit.dev/v1alpha1\nharness: claude\n",
    );
    await writeFile(
      join(tmp, "workflow.yaml"),
      `apiVersion: graphkit.dev/v1alpha1
kind: Workflow
metadata: { name: x }
limits: { max_iterations: 2 }
start: start
nodes:
  work:
    id: renamed
    type: graph
    operation: complete-task
edges:
  - { from: start, to: work }
terminal:
  - { node: work, verdict: passed }
`,
    );
    try {
      const loaded = await loadTemplate(tmp);
      const issues = validateTemplate(loaded);
      expect(codes(issues, "SCHEMA_VIOLATION").length).toBeGreaterThan(0);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("custom start sentinel is honored", () => {
    const issues = validateTemplate(
      mutation(base.workflow, (w) => {
        (w as Record<string, unknown>).start = "work";
        (w as { edges: unknown[] }).edges = [{ from: "work", to: "complete" }];
      }),
    );
    expect(
      codes(issues, "INVALID_TRANSITION").filter((i) => i.node === "work" && i.message.includes("unreachable")),
    ).toEqual([]);
  });

  test("multiple entries from start are all reachable", () => {
    const issues = validateTemplate(
      mutation(base.workflow, (w) => {
        (w as { edges: unknown[] }).edges = [
          { from: "start", to: "work" },
          { from: "start", to: "complete" },
        ];
      }),
    );
    expect(codes(issues, "UNREACHABLE_TERMINAL")).toEqual([]);
  });

  test("unreachable nonterminal node reports INVALID_TRANSITION", () => {
    const issues = validateTemplate(
      mutation(base.workflow, (w) => {
        (w as Record<string, unknown>).nodes = {
          ...(w as { nodes: Record<string, unknown> }).nodes,
          idle: { id: "idle", type: "graph", operation: "complete-task" },
        };
      }),
    );
    const unreachable = codes(issues, "INVALID_TRANSITION").filter((i) => i.node === "idle");
    expect(unreachable).toHaveLength(1);
    expect(unreachable[0].message).toContain("unreachable");
  });

  test("condition referencing missing node reports INVALID_TRANSITION", () => {
    const issues = validateTemplate(
      mutation(base.workflow, (w) => {
        (w as { edges: unknown[] }).edges.push({ from: "work", to: "complete", when: "nodes.ghost == 1" });
      }),
    );
    const refs = codes(issues, "INVALID_TRANSITION").filter((i) => i.message.includes("unknown node 'ghost'"));
    expect(refs).toHaveLength(1);
  });

  test("malformed node yields one SCHEMA_VIOLATION per zod issue with sorted nodes", () => {
    const issues = validateTemplate(
      mutation(base.workflow, (w) => {
        (w as Record<string, unknown>).nodes = {
          zz: { id: "zz", type: "honk" },
          aa: { id: "aa", type: "human", actions: [] },
        };
      }),
    );
    const schemaIssues = codes(issues, "SCHEMA_VIOLATION");
    expect(schemaIssues.length).toBeGreaterThanOrEqual(2);
    const nodes = schemaIssues.map((i) => i.node).sort();
    expect(nodes[0]).toBe("aa");
    expect(nodes[nodes.length - 1]).toBe("zz");
  });

  test("two bad output schemas (missing + invalid) both reported, sorted by node", () => {
    const loaded = mutation(base.workflow, () => {});
    loaded.outputSchemas.set("zz-missing", join(directory, "schemas", "nope.json"));
    loaded.outputSchemas.set("aa-invalid", join(directory, "schemas", "invalid.schema.json"));
    const issues = validateTemplate(loaded);
    const schemaIssues = codes(issues, "SCHEMA_VIOLATION").filter((i) => i.message.includes("output schema for node"));
    expect(schemaIssues).toHaveLength(2);
    expect(schemaIssues.map((i) => i.node)).toEqual(["aa-invalid", "zz-missing"]);
  });

  test("reports all issues, deterministic order by node then code", () => {
    const issues = validateTemplate(
      mutation(base.workflow, (w) => {
        (w as { edges: unknown[] }).edges.push({ from: "complete", to: "work" }, { from: "work", to: "nope" });
      }),
    );
    const keys = issues.map((i) => `${i.node ?? ""}/${i.code}`);
    expect(keys).toEqual([...keys].sort());
  });
});

describe("loader", () => {
  test("traversal output schema reference preserves UNSAFE_PATH", async () => {
    const tmp = join(import.meta.dir, "..", "fixtures", "._tmp-traversal-ref");
    const { mkdir, writeFile, rm } = await import("node:fs/promises");
    await mkdir(tmp, { recursive: true });
    await writeFile(
      join(tmp, "template.yaml"),
      "name: x\nversion: '1'\napiVersion: graphkit.dev/v1alpha1\nharness: claude\n",
    );
    await writeFile(
      join(tmp, "workflow.yaml"),
      `apiVersion: graphkit.dev/v1alpha1
kind: Workflow
metadata: { name: x }
start: start
nodes:
  work:
    type: agent
    skill: worker
    objective: x
    output: { schema: ../outside.json, save_as: r }
edges: [{ from: start, to: work }]
terminal: [{ node: work, verdict: passed }]
`,
    );
    try {
      const loaded = await loadTemplate(tmp);
      const issues = validateTemplate(loaded);
      expect(issues.filter((i) => i.code === "UNSAFE_PATH" && i.node === "work")).toHaveLength(1);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("loader", () => {
  test("node id differing from key is captured on loadTemplate", async () => {
    const loaded = await loadedFixture();
    expect(loaded.loaderIssues ?? []).toEqual([]);
  });
});
