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
