import { beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { validateOutput, validateTemplate } from "../../src/runtime/validation.js";
import type { Workflow } from "../../src/schemas.js";
import type { LoadedTemplate } from "../../src/templates/loader.js";
import { loadTemplate } from "../../src/templates/loader.js";

const directory = join(import.meta.dir, "..", "..", "tests", "fixtures", "valid-chain");

async function loadedFixture(): Promise<LoadedTemplate> {
  return loadTemplate(directory);
}

/** Deep-clone the fixture workflow with an arbitrary mutation applied. */
function mutate(wf: Workflow, mutation: (w: Record<string, unknown>) => void): LoadedTemplate {
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

function find(issues: import("../../src/runtime/validation.js").ValidationIssue[], code: string) {
  return issues.find((i) => i.code === code);
}

describe("template validation", () => {
  test("valid-chain fixture loads with no issues", async () => {
    const issues = validateTemplate(await loadedFixture());
    expect(issues).toEqual([]);
  });

  test("valid output passes, invalid output throws SCHEMA_VIOLATION", async () => {
    const loaded = await loadedFixture();
    const schema = loaded.outputSchemas.get("work") as string;
    await expect(validateOutput(schema, { summary: "done" })).resolves.toBeUndefined();
    await expect(validateOutput(schema, { summary: 4 })).rejects.toMatchObject({ code: "SCHEMA_VIOLATION" });
  });

  let base: LoadedTemplate;
  beforeAll(async () => {
    base = await loadedFixture();
  });

  const cases: Array<{
    name: string;
    mutate: (w: Record<string, unknown>) => void;
    code: string;
  }> = [
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
      code: "INVALID_TRANSITION",
    },
    {
      name: "fanout without max_workers",
      mutate: (w) => {
        (w as Record<string, unknown>).nodes = {
          fan: { id: "fan", type: "fanout", from: "items" },
          complete: { id: "complete", type: "graph", operation: "complete-task" },
        };
      },
      code: "INVALID_TRANSITION",
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
    test(`reports ${tc.name}`, async () => {
      const issues = validateTemplate(mutate(base.workflow, tc.mutate));
      expect(find(issues, tc.code)).toBeDefined();
    });
  }

  test("reports all issues, deterministic order by node then code", async () => {
    const issues = validateTemplate(
      mutate(base.workflow, (w) => {
        (w as { edges: unknown[] }).edges.push({ from: "complete", to: "work" }, { from: "work", to: "nope" });
      }),
    );
    const keys = issues.map((i) => `${i.node ?? ""}/${i.code}`);
    expect(keys).toEqual([...keys].sort());
  });
});
