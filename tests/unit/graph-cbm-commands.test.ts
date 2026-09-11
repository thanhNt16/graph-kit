import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CBM_UNAVAILABLE_MSG } from "../../src/cbm/client.js";

// --- Mutable refs — the seam reads these at call time ---
let fakeCallFn: ((tool: string, args: Record<string, unknown>) => Promise<unknown>) | undefined;
let fakeCloseFn: (() => Promise<void>) | undefined;
let fakeIndexFn: ((client: unknown, opts: Record<string, unknown>) => Promise<unknown>) | undefined;
let capturedTool: string | undefined;
let _capturedArgs: Record<string, unknown> | undefined;

import { _resetCbmSeam, _setCbmSeam, registerGraphCommands } from "../../src/cli/commands/graph.js";
import { createCliHarness } from "../helpers/cli-harness.js";

describe("gk graph CBM subcommands", () => {
  beforeEach(() => {
    capturedTool = undefined;
    _capturedArgs = undefined;
    // Inject fakes via the DI seam (no module mock → no cross-file bleed)
    _setCbmSeam({
      clientFactory: () => ({
        call: async (tool: string, args: Record<string, unknown>) => {
          capturedTool = tool;
          _capturedArgs = args;
          return fakeCallFn ? fakeCallFn(tool, args) : {};
        },
        close: async () => fakeCloseFn?.(),
      }),
      indexProject: async (_client: unknown, opts: Record<string, unknown>) =>
        fakeIndexFn ? fakeIndexFn(_client, opts) : { project: opts.repoPath ?? "test", indexed: true },
    });
  });

  afterEach(() => {
    process.exitCode = 0; // fail() sets process.exitCode=1 — reset so bun:test exits 0
    fakeCallFn = undefined;
    fakeCloseFn = undefined;
    fakeIndexFn = undefined;
    _resetCbmSeam();
  });

  // --- index ---
  test("graph index emits ok with indexProject result", async () => {
    fakeIndexFn = async () => ({ project: "test-proj", indexed: true, nodes: 42 });
    fakeCloseFn = async () => {};

    const run = await createCliHarness(registerGraphCommands).runAsync(["graph", "index", "fast"], 50);

    const parsed = JSON.parse(run.stdout);
    expect(parsed.status).toBe("ok");
    expect(parsed.data.indexed).toBe(true);
    expect(parsed.data.project).toBe("test-proj");
  });

  // --- search ---
  test("graph search emits ok with SearchResult", async () => {
    fakeCallFn = async (_tool, _args) => ({
      total: 1,
      search_mode: "bm25",
      results: [
        {
          name: "sampleAdd",
          qualified_name: "sampleAdd",
          label: "Function",
          file_path: "sample-a.ts",
          start_line: 1,
          end_line: 10,
          rank: -15.3,
        },
      ],
      has_more: false,
    });
    fakeCloseFn = async () => {};

    const run = await createCliHarness(registerGraphCommands).runAsync(["graph", "search", "sampleAdd"], 50);

    const parsed = JSON.parse(run.stdout);
    expect(parsed.status).toBe("ok");
    expect(parsed.data.results).toHaveLength(1);
    expect(parsed.data.results[0].qualified_name).toBe("sampleAdd");
    expect(parsed.data.total).toBe(1);
    expect(parsed.data.search_mode).toBe("bm25");
    expect(parsed.data.has_more).toBe(false);
    expect(capturedTool).toBe("search_graph");
  });

  test("graph search without pattern emits fail MISSING_ARG", async () => {
    const run = await createCliHarness(registerGraphCommands).runAsync(["graph", "search"], 50);
    const parsed = JSON.parse(run.stdout);
    expect(parsed.status).toBe("fail");
    expect(parsed.error.code).toBe("MISSING_ARG");
  });

  // --- trace ---
  test("graph trace emits ok with TraceResult", async () => {
    fakeCallFn = async (_tool, args) => ({
      function: args.function_name,
      direction: "both",
      callers: [{ name: "sampleMain", qualified_name: "sampleMain", hop: 1 }],
      callees: [{ name: "sampleMul", qualified_name: "sampleMul", hop: 1 }],
    });
    fakeCloseFn = async () => {};

    const run = await createCliHarness(registerGraphCommands).runAsync(["graph", "trace", "sampleAdd"], 50);

    const parsed = JSON.parse(run.stdout);
    expect(parsed.status).toBe("ok");
    expect(parsed.data.function).toBe("sampleAdd");
    expect(parsed.data.direction).toBe("both");
    expect(parsed.data.callers).toHaveLength(1);
    expect(parsed.data.callers[0].name).toBe("sampleMain");
    expect(parsed.data.callees).toHaveLength(1);
    expect(parsed.data.callees[0].name).toBe("sampleMul");
    expect(capturedTool).toBe("trace_path");
  });

  test("graph trace without arg emits fail MISSING_ARG", async () => {
    const run = await createCliHarness(registerGraphCommands).runAsync(["graph", "trace"], 50);
    const parsed = JSON.parse(run.stdout);
    expect(parsed.status).toBe("fail");
    expect(parsed.error.code).toBe("MISSING_ARG");
  });

  // --- query ---
  test("graph query emits ok with QueryResult", async () => {
    fakeCallFn = async () => ({
      columns: ["f.name", "f.label"],
      rows: [["sampleAdd", "Function"]],
      total: 1,
    });
    fakeCloseFn = async () => {};

    const run = await createCliHarness(registerGraphCommands).runAsync(
      ["graph", "query", "MATCH (n) RETURN n LIMIT 1"],
      50,
    );

    const parsed = JSON.parse(run.stdout);
    expect(parsed.status).toBe("ok");
    expect(parsed.data.columns).toEqual(["f.name", "f.label"]);
    expect(parsed.data.rows).toEqual([["sampleAdd", "Function"]]);
    expect(parsed.data.total).toBe(1);
    expect(capturedTool).toBe("query_graph");
  });

  test("graph query without arg emits fail MISSING_ARG", async () => {
    const run = await createCliHarness(registerGraphCommands).runAsync(["graph", "query"], 50);
    const parsed = JSON.parse(run.stdout);
    expect(parsed.status).toBe("fail");
    expect(parsed.error.code).toBe("MISSING_ARG");
  });

  // --- error handling ---
  test("CBM_UNAVAILABLE on client.call error", async () => {
    fakeCallFn = async () => {
      throw new Error("spawn ENOENT");
    };
    fakeCloseFn = async () => {};

    const run = await createCliHarness(registerGraphCommands).runAsync(["graph", "search", "foo"], 50);

    const parsed = JSON.parse(run.stdout);
    expect(parsed.status).toBe("fail");
    expect(parsed.error.code).toBe("CBM_UNAVAILABLE");
  });

  test("ask on a dead bridge fails honestly, not ok-with-zero-hits", async () => {
    // route.ts used to swallow the fatal bridge rejection into empty results —
    // an empty `ok` payload is indistinguishable from a real empty index.
    fakeCallFn = async () => {
      throw new Error(CBM_UNAVAILABLE_MSG);
    };
    fakeCloseFn = async () => {};

    const run = await createCliHarness(registerGraphCommands).runAsync(
      ["graph", "ask", "Who calls validateGraph in production code?"],
      50,
    );

    const parsed = JSON.parse(run.stdout);
    expect(parsed.status).toBe("fail");
    expect(parsed.error.code).toBe("CBM_UNAVAILABLE");
    expect(run.exitCode).toBe(1);
  });

  test("client.close called after successful search", async () => {
    let closeCalled = false;
    fakeCallFn = async () => ({ total: 0, search_mode: "bm25", results: [], has_more: false });
    fakeCloseFn = async () => {
      closeCalled = true;
    };

    await createCliHarness(registerGraphCommands).runAsync(["graph", "search", "sampleAdd"], 50);

    expect(closeCalled).toBe(true);
  });

  test("client.close called even when the call throws (no child-process leak)", async () => {
    let closeCalled = false;
    fakeCallFn = async () => {
      throw new Error("boom");
    };
    fakeCloseFn = async () => {
      closeCalled = true;
    };

    await createCliHarness(registerGraphCommands).runAsync(["graph", "search", "sampleAdd"], 50);

    expect(closeCalled).toBe(true);
  });

  // --- R7: flag validation (previously uncovered INVALID_LIMIT / INVALID_DEPTH) ---
  test("graph search --limit 0 emits fail INVALID_LIMIT with no CBM call", async () => {
    const run = await createCliHarness(registerGraphCommands).runAsync(["graph", "search", "foo", "--limit", "0"], 50);

    const parsed = JSON.parse(run.stdout);
    expect(parsed.status).toBe("fail");
    expect(parsed.error.code).toBe("INVALID_LIMIT");
    expect(parsed.error.message).toContain("must be a positive integer");
    expect(capturedTool).toBeUndefined();
  });

  test("graph ask --limit 0 emits fail INVALID_LIMIT", async () => {
    const run = await createCliHarness(registerGraphCommands).runAsync(
      ["graph", "ask", "Who calls validateGraph?", "--limit", "0"],
      50,
    );

    const parsed = JSON.parse(run.stdout);
    expect(parsed.status).toBe("fail");
    expect(parsed.error.code).toBe("INVALID_LIMIT");
    expect(capturedTool).toBeUndefined();
  });

  test("graph ask --depth -1 emits fail INVALID_DEPTH (limit checked before depth)", async () => {
    const run = await createCliHarness(registerGraphCommands).runAsync(
      ["graph", "ask", "Who calls validateGraph?", "--depth=-1"],
      50,
    );

    const parsed = JSON.parse(run.stdout);
    expect(parsed.status).toBe("fail");
    expect(parsed.error.code).toBe("INVALID_DEPTH");
    expect(parsed.error.message).toContain("must be a positive integer");
    expect(capturedTool).toBeUndefined();
  });

  test("graph trace --depth -1 emits fail INVALID_DEPTH with no CBM call", async () => {
    const run = await createCliHarness(registerGraphCommands).runAsync(
      ["graph", "trace", "sampleAdd", "--depth=-1"],
      50,
    );

    const parsed = JSON.parse(run.stdout);
    expect(parsed.status).toBe("fail");
    expect(parsed.error.code).toBe("INVALID_DEPTH");
    expect(capturedTool).toBeUndefined();
  });

  // --- R7: happy-path flag threading ---
  test("graph search --limit 2 threads limit into the search_graph call", async () => {
    fakeCallFn = async () => ({ total: 0, search_mode: "bm25", results: [], has_more: false });
    fakeCloseFn = async () => {};

    await createCliHarness(registerGraphCommands).runAsync(["graph", "search", "sampleAdd", "--limit", "2"], 50);

    expect(capturedTool).toBe("search_graph");
    expect(_capturedArgs?.limit).toBe(2);
    expect(_capturedArgs?.pattern).toBe("sampleAdd");
  });

  test("graph ask --limit 2 --depth 2 threads both into the routed primitives", async () => {
    const calls: { tool: string; args: Record<string, unknown> }[] = [];
    fakeCallFn = async (tool, args) => {
      calls.push({ tool, args });
      if (tool === "search_graph") {
        return {
          results: [
            {
              name: "validateGraph",
              qualified_name: "proj.src.compiler.validate.validateGraph",
              file_path: "src/compiler/validate.ts",
              label: "Function",
              start_line: 1,
            },
          ],
        };
      }
      return { callers: [], callees: [] };
    };
    fakeCloseFn = async () => {};

    const run = await createCliHarness(registerGraphCommands).runAsync(
      ["graph", "ask", "Who calls validateGraph in production code?", "--limit", "2", "--depth", "2"],
      50,
    );

    const parsed = JSON.parse(run.stdout);
    expect(parsed.status).toBe("ok");
    expect(parsed.data.kind).toBe("callers");
    const searches = calls.filter((c) => c.tool === "search_graph");
    expect(searches.length).toBeGreaterThan(0);
    for (const c of searches) expect(c.args.limit).toBe(2);
    const trace = calls.find((c) => c.tool === "trace_path");
    expect(trace?.args.depth).toBe(2);
  });

  test("graph trace --depth 2 threads depth into the trace_path call", async () => {
    fakeCallFn = async () => ({ function: "sampleAdd", direction: "both", callers: [], callees: [] });
    fakeCloseFn = async () => {};

    await createCliHarness(registerGraphCommands).runAsync(["graph", "trace", "sampleAdd", "--depth", "2"], 50);

    expect(capturedTool).toBe("trace_path");
    expect(_capturedArgs?.depth).toBe(2);
  });

  // --- R5: trace pass-through of server-provided hop coordinates ---
  test("graph trace forwards server file_path/start_line/end_line on hops", async () => {
    fakeCallFn = async (_tool, args) => ({
      function: args.function_name,
      direction: "both",
      callers: [
        {
          name: "bigCaller",
          qualified_name: "proj.src.cli.commands.graph.bigCaller",
          hop: 1,
          file_path: "server/anchor.ts",
          start_line: 42,
          end_line: 60,
        },
      ],
      callees: [],
    });
    fakeCloseFn = async () => {};

    const run = await createCliHarness(registerGraphCommands).runAsync(["graph", "trace", "sampleAdd"], 50);

    const parsed = JSON.parse(run.stdout);
    expect(parsed.status).toBe("ok");
    expect(parsed.data.callers[0].file_path).toBe("server/anchor.ts");
    expect(parsed.data.callers[0].start_line).toBe(42);
    expect(parsed.data.callers[0].end_line).toBe(60);
  });

  // --- R6: query templates ---
  test("graph query --template dead-code emits ok via query_graph", async () => {
    fakeCallFn = async (_tool, args) => {
      const query = String((args as { query: string }).query);
      if (query.includes("DISTINCT")) return { columns: ["n.name"], rows: [["usedVar"]], total: 1 };
      return {
        columns: ["n.name", "n.file_path", "n.start_line"],
        rows: [
          ["usedVar", "src/a.ts", 1],
          ["lonelyVar", "src/b.ts", 2],
        ],
        total: 2,
      };
    };
    fakeCloseFn = async () => {};

    const run = await createCliHarness(registerGraphCommands).runAsync(
      ["graph", "query", "--template", "dead-code"],
      50,
    );

    expect(capturedTool).toBe("query_graph");
    const parsed = JSON.parse(run.stdout);
    expect(parsed.status).toBe("ok");
    expect(parsed.data.isolated).toEqual([{ name: "lonelyVar", file: "src/b.ts", line: 2 }]);
  });

  test("graph query --templates lists offline — the CBM client factory is never invoked", async () => {
    let factoryCalls = 0;
    _setCbmSeam({
      clientFactory: () => {
        factoryCalls++;
        throw new Error("client must not be created for --templates");
      },
    });

    const run = await createCliHarness(registerGraphCommands).runAsync(["graph", "query", "--templates", "--json"], 50);
    const parsed = JSON.parse(run.stdout);
    expect(parsed.status).toBe("ok");
    expect(parsed.data.templates.map((t: { name: string }) => t.name).sort()).toEqual([
      "callers-of",
      "dead-code",
      "symbol-set",
    ]);
    expect(factoryCalls).toBe(0);
    expect(capturedTool).toBeUndefined();
  });

  test("graph query --template nope emits fail UNKNOWN_TEMPLATE with available, no CBM call", async () => {
    const run = await createCliHarness(registerGraphCommands).runAsync(["graph", "query", "--template", "nope"], 50);

    const parsed = JSON.parse(run.stdout);
    expect(parsed.status).toBe("fail");
    expect(parsed.error.code).toBe("UNKNOWN_TEMPLATE");
    expect(parsed.error.details.available).toContain("dead-code");
    expect(capturedTool).toBeUndefined();
  });

  test("graph query --template dead-code maps an escaping CBM failure to CBM_UNAVAILABLE", async () => {
    // The dead-code anti-join fail-opens on query_graph rejections (route.ts
    // semantics, preserved verbatim) — the honest CBM_UNAVAILABLE surface is for
    // failures that escape the template, e.g. the client lifecycle itself.
    _setCbmSeam({
      clientFactory: () => {
        throw new Error("spawn ENOENT");
      },
    });

    const run = await createCliHarness(registerGraphCommands).runAsync(
      ["graph", "query", "--template", "dead-code"],
      50,
    );

    const parsed = JSON.parse(run.stdout);
    expect(parsed.status).toBe("fail");
    expect(parsed.error.code).toBe("CBM_UNAVAILABLE");
  });
});
