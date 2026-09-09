import { describe, expect, test } from "bun:test";
import type { CbmClient } from "../../src/cbm/client.js";
import { classifyQuestion, deriveFiles, routeAndRetrieve } from "../../src/cbm/route.js";

describe("classifyQuestion", () => {
  test("routes the five kinds", () => {
    expect(classifyQuestion("Who calls validateGraph in production code?")).toBe("callers");
    expect(classifyQuestion("Trace gk graph index from CLI input to the CBM tool call.")).toBe("dataflow");
    expect(classifyQuestion("How does actRScore combine relevance and recency?")).toBe("dataflow");
    expect(classifyQuestion("Find a source variable declared but never read elsewhere.")).toBe("deadcode");
    expect(classifyQuestion("Where is the main graph validation function defined?")).toBe("wheredef");
    expect(classifyQuestion("What does renderAscii depend on for graph input?")).toBe("deps");
  });
});

describe("deriveFiles", () => {
  test("derives file candidates from qualified names", () => {
    const proj = "Users-x.Desktop-graph-engineering-graph-kit";
    expect(deriveFiles(`${proj}.src.cli.commands.graph.registerGraphCommands`)).toContain("src/cli/commands/graph.ts");
    expect(deriveFiles(`${proj}.src.eval.forgetting.actRScore`)).toContain("src/eval/forgetting.ts");
    expect(deriveFiles(`${proj}.src.index`)).toContain("src/index.ts");
    expect(deriveFiles("noseparator")).toEqual([]);
  });
});

// Fake client that records every primitive call. The first search returns one
// hit so routing proceeds to trace_path; only the forwarded args are under
// test here, so empty structural results are fine.
function fakeClient() {
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  const client = {
    call: async (tool: string, args: Record<string, unknown>) => {
      calls.push({ tool, args });
      if (tool === "search_graph") {
        return calls.filter((c) => c.tool === "search_graph").length === 1
          ? {
              results: [
                {
                  name: "loadGraph",
                  qualified_name: "proj.src.cli.commands.graph.loadGraph",
                  file_path: "src/cli/commands/graph.ts",
                  label: "Function",
                  start_line: 56,
                },
              ],
            }
          : { results: [] };
      }
      return { callers: [], callees: [] };
    },
    close: async () => {},
  } as unknown as CbmClient;
  return { client, calls };
}

describe("routeAndRetrieve limit/depth knobs", () => {
  const q = "Who calls validateGraph in production code?"; // callers kind: 2 searches + 1 trace, no snippets

  test("defaults unchanged — search limit 8, trace depth 3", async () => {
    const { client, calls } = fakeClient();
    await routeAndRetrieve(client, q);
    const searches = calls.filter((c) => c.tool === "search_graph");
    expect(searches).toHaveLength(2);
    for (const c of searches) expect(c.args.limit).toBe(8);
    expect(calls.find((c) => c.tool === "trace_path")?.args.depth).toBe(3);
  });

  test("explicit opts override the defaults on both primitives", async () => {
    const { client, calls } = fakeClient();
    await routeAndRetrieve(client, q, undefined, { limit: 3, depth: 5 });
    for (const c of calls.filter((c) => c.tool === "search_graph")) expect(c.args.limit).toBe(3);
    expect(calls.find((c) => c.tool === "trace_path")?.args.depth).toBe(5);
  });
});

// R5: hop() anchors — server-provided coordinates win verbatim; the fallback
// returns the FULL derived candidate when the qualified-name tail is a
// file/dir node (all-lowercase) and the parent when it is a function (camelCase).
describe("routeAndRetrieve hop coordinates (R5)", () => {
  const q = "Who calls validateGraph in production code?"; // callers kind → trace inbound

  function traceClient(callers: { name: string; qualified_name: string; file_path?: string; start_line?: number }[]) {
    const calls: { tool: string; args: Record<string, unknown> }[] = [];
    const client = {
      call: async (tool: string, args: Record<string, unknown>) => {
        calls.push({ tool, args });
        if (tool === "search_graph") {
          return calls.filter((c) => c.tool === "search_graph").length === 1
            ? {
                results: [
                  {
                    name: "validateGraph",
                    qualified_name: "proj.src.compiler.validate.validateGraph",
                    file_path: "src/compiler/validate.ts",
                    label: "Function",
                    start_line: 20,
                  },
                ],
              }
            : { results: [] };
        }
        return { callers, callees: [] };
      },
      close: async () => {},
    } as unknown as CbmClient;
    return { client, calls };
  }

  test("server file_path/start_line are used verbatim and surface as line", async () => {
    const { client } = traceClient([
      { name: "srvHit", qualified_name: "proj.src.a.b.SrvHit", file_path: "server/anchor.ts", start_line: 42 },
    ]);
    const out = await routeAndRetrieve(client, q);
    expect(out.structural?.callers).toEqual([{ fn: "srvHit", file: "server/anchor.ts", line: 42 }]);
  });

  test("lowercase tail (file/dir node) returns the full derived candidate, not the parent", async () => {
    const { client } = traceClient([{ name: "fileNode", qualified_name: "proj.src.cli.commands.graph" }]);
    const out = await routeAndRetrieve(client, q);
    expect(out.structural?.callers?.[0]?.file).toBe("src/cli/commands/graph.ts");
  });

  test("proj.src.index resolves to src/index.ts (not src.ts)", async () => {
    const { client } = traceClient([{ name: "bareIndex", qualified_name: "proj.src.index" }]);
    const out = await routeAndRetrieve(client, q);
    expect(out.structural?.callers?.[0]?.file).toBe("src/index.ts");
  });

  test("camelCase tail (function) keeps the parent candidate — byte-identical when fields absent", async () => {
    const { client } = traceClient([
      { name: "fnTail", qualified_name: "proj.src.cli.commands.graph.registerGraphCommands" },
    ]);
    const out = await routeAndRetrieve(client, q);
    expect(out.structural?.callers?.[0]).toEqual({ fn: "fnTail", file: "src/cli/commands/graph.ts" });
    expect(out.structural?.callers?.[0]).not.toHaveProperty("line");
  });
});
