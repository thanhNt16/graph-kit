import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cac } from "cac";

// --- Mutable refs — the seam reads these at call time ---
let fakeCallFn: ((tool: string, args: Record<string, unknown>) => Promise<unknown>) | undefined;
let fakeCloseFn: (() => Promise<void>) | undefined;
let fakeIndexFn: ((client: unknown, opts: Record<string, unknown>) => Promise<unknown>) | undefined;
let capturedTool: string | undefined;
let _capturedArgs: Record<string, unknown> | undefined;

import { _resetCbmSeam, _setCbmSeam, registerGraphCommands } from "../../src/cli/commands/graph.js";

describe("gk graph CBM subcommands", () => {
  const sink: string[] = [];
  let origLog: typeof console.log;
  let origExit: typeof process.exit;

  beforeEach(() => {
    capturedTool = undefined;
    _capturedArgs = undefined;
    sink.length = 0;
    origLog = console.log;
    origExit = process.exit;
    console.log = (...a: unknown[]) => sink.push(a.map(String).join(" "));
    process.exit = () => {};
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
    console.log = origLog;
    process.exit = origExit;
    fakeCallFn = undefined;
    fakeCloseFn = undefined;
    fakeIndexFn = undefined;
    _resetCbmSeam();
  });

  function runCli(args: string[]) {
    const cli = cac("gk");
    registerGraphCommands(cli);
    try {
      cli.parse(["node", "gk", ...args], { run: true });
    } catch {
      // async handlers settle later
    }
    return {
      get stdout() {
        return sink.join("\n");
      },
    };
  }

  // --- index ---
  test("graph index emits ok with indexProject result", async () => {
    fakeIndexFn = async () => ({ project: "test-proj", indexed: true, nodes: 42 });
    fakeCloseFn = async () => {};

    runCli(["graph", "index", "fast"]);
    await new Promise((r) => setTimeout(r, 50));

    const parsed = JSON.parse(sink.join("\n"));
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

    runCli(["graph", "search", "sampleAdd"]);
    await new Promise((r) => setTimeout(r, 50));

    const parsed = JSON.parse(sink.join("\n"));
    expect(parsed.status).toBe("ok");
    expect(parsed.data.results).toHaveLength(1);
    expect(parsed.data.results[0].qualified_name).toBe("sampleAdd");
    expect(parsed.data.total).toBe(1);
    expect(parsed.data.search_mode).toBe("bm25");
    expect(parsed.data.has_more).toBe(false);
    expect(capturedTool).toBe("search_graph");
  });

  test("graph search without pattern emits fail MISSING_ARG", () => {
    runCli(["graph", "search"]);
    const parsed = JSON.parse(sink.join("\n"));
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

    runCli(["graph", "trace", "sampleAdd"]);
    await new Promise((r) => setTimeout(r, 50));

    const parsed = JSON.parse(sink.join("\n"));
    expect(parsed.status).toBe("ok");
    expect(parsed.data.function).toBe("sampleAdd");
    expect(parsed.data.direction).toBe("both");
    expect(parsed.data.callers).toHaveLength(1);
    expect(parsed.data.callers[0].name).toBe("sampleMain");
    expect(parsed.data.callees).toHaveLength(1);
    expect(parsed.data.callees[0].name).toBe("sampleMul");
    expect(capturedTool).toBe("trace_path");
  });

  test("graph trace without arg emits fail MISSING_ARG", () => {
    runCli(["graph", "trace"]);
    const parsed = JSON.parse(sink.join("\n"));
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

    runCli(["graph", "query", "MATCH (n) RETURN n LIMIT 1"]);
    await new Promise((r) => setTimeout(r, 50));

    const parsed = JSON.parse(sink.join("\n"));
    expect(parsed.status).toBe("ok");
    expect(parsed.data.columns).toEqual(["f.name", "f.label"]);
    expect(parsed.data.rows).toEqual([["sampleAdd", "Function"]]);
    expect(parsed.data.total).toBe(1);
    expect(capturedTool).toBe("query_graph");
  });

  test("graph query without arg emits fail MISSING_ARG", () => {
    runCli(["graph", "query"]);
    const parsed = JSON.parse(sink.join("\n"));
    expect(parsed.status).toBe("fail");
    expect(parsed.error.code).toBe("MISSING_ARG");
  });

  // --- error handling ---
  test("CBM_UNAVAILABLE on client.call error", async () => {
    fakeCallFn = async () => {
      throw new Error("spawn ENOENT");
    };
    fakeCloseFn = async () => {};

    runCli(["graph", "search", "foo"]);
    await new Promise((r) => setTimeout(r, 50));

    const parsed = JSON.parse(sink.join("\n"));
    expect(parsed.status).toBe("fail");
    expect(parsed.error.code).toBe("CBM_UNAVAILABLE");
  });

  test("client.close called after successful search", async () => {
    let closeCalled = false;
    fakeCallFn = async () => ({ total: 0, search_mode: "bm25", results: [], has_more: false });
    fakeCloseFn = async () => {
      closeCalled = true;
    };

    runCli(["graph", "search", "sampleAdd"]);
    await new Promise((r) => setTimeout(r, 50));

    expect(closeCalled).toBe(true);
  });
});
