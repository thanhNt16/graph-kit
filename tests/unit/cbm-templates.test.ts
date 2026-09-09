import { describe, expect, test } from "bun:test";
import type { CbmClient } from "../../src/cbm/client.js";
import { routeAndRetrieve } from "../../src/cbm/route.js";
import { listTemplates, QUERY_TEMPLATES, runTemplate } from "../../src/cbm/templates.js";

// Fake CBM client that records calls and answers query_graph from canned rows,
// keyed by the query shape the templates are allowed to use.
function fakeClient(queryResult: (tool: string, args: Record<string, unknown>) => unknown) {
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  const client = {
    call: async (tool: string, args: Record<string, unknown>) => {
      calls.push({ tool, args });
      return queryResult(tool, args);
    },
    close: async () => {},
  } as unknown as CbmClient;
  return { client, calls };
}

describe("QUERY_TEMPLATES.dead-code", () => {
  const ALL_VARS = {
    columns: ["n.name", "n.file_path", "n.start_line"],
    rows: [
      ["usedVar", "src/a.ts", 1],
      ["readmeVar", "README.md", 3],
      ["zetaVar", "src/zeta.ts", 9],
      ["alphaVar", "src/alpha.ts", 5],
      ["scriptVar", "scripts/boot.mjs", 7],
    ],
    total: 5,
  };
  const WITH_EDGES = { columns: ["n.name"], rows: [["usedVar"]], total: 1 };

  test("anti-join excludes linked vars and non-source files, even sort, limit caps", async () => {
    const { client, calls } = fakeClient((_tool, args) =>
      String((args as { query: string }).query).includes("DISTINCT") ? WITH_EDGES : ALL_VARS,
    );
    const out = (await runTemplate(client, "dead-code", undefined, undefined, 25)) as {
      isolated: { name: string; file: string; line: number }[];
    };
    // linked var dropped, README.md dropped, scripts/*.mjs KEPT (source ext), sorted by file
    expect(out.isolated).toEqual([
      { name: "scriptVar", file: "scripts/boot.mjs", line: 7 },
      { name: "alphaVar", file: "src/alpha.ts", line: 5 },
      { name: "zetaVar", file: "src/zeta.ts", line: 9 },
    ]);
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      expect(c.tool).toBe("query_graph");
      expect(c.args.project).toBeUndefined();
    }
  });

  test("limit overrides the default 25 cap", async () => {
    const big = {
      columns: ALL_VARS.columns,
      rows: Array.from({ length: 30 }, (_, i) => [`v${i}`, `src/f${i}.ts`, i + 1]),
      total: 30,
    };
    const { client } = fakeClient((_tool, args) =>
      String((args as { query: string }).query).includes("DISTINCT") ? { columns: [], rows: [] } : big,
    );
    const capped = (await runTemplate(client, "dead-code", undefined, undefined, 5)) as {
      isolated: unknown[];
    };
    expect(capped.isolated).toHaveLength(5);
  });
});

describe("QUERY_TEMPLATES.callers-of", () => {
  test("filters the broad edge scan client-side on n.name === arg", async () => {
    const rows = [
      ["callerOne", "src/one.ts", "target", 10],
      ["callerTwo", "src/two.ts", "target", 20],
      ["callerThree", "src/three.ts", "other", 30],
    ];
    const { client, calls } = fakeClient(() => ({ columns: [], rows, total: rows.length }));
    const out = (await runTemplate(client, "callers-of", "target", "proj-x", 25)) as {
      symbol: string;
      callers: { name: string; file: string; line: number }[];
    };
    expect(out.symbol).toBe("target");
    expect(out.callers).toEqual([
      { name: "callerOne", file: "src/one.ts", line: 10 },
      { name: "callerTwo", file: "src/two.ts", line: 20 },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0].tool).toBe("query_graph");
    expect(calls[0].args.project).toBe("proj-x");
    // proven Cypher subset only
    expect(String(calls[0].args.query)).toMatch(/^MATCH \(m\)-\[r\]->\(n\)/);
    expect(String(calls[0].args.query)).toContain("DISTINCT");
    expect(String(calls[0].args.query)).toContain("LIMIT 500");
  });
});

describe("QUERY_TEMPLATES.symbol-set", () => {
  test("partitions declared vs referencing files vs unreferenced", async () => {
    const rows = [
      ["ownA", "src/own.ts", "Function", 1],
      ["ownB", "src/own.ts", "Variable", 5],
      ["ownA", "src/user-one.ts", "Identifier", 9],
      ["ownA", "src/user-two.ts", "Identifier", 11],
      ["ownC", "src/user-one.ts", "Identifier", 13], // references nothing declared
      ["foreign", "src/other.ts", "Function", 17], // unrelated symbol
    ];
    const { client, calls } = fakeClient(() => ({ columns: [], rows, total: rows.length }));
    const out = (await runTemplate(client, "symbol-set", "src/own.ts", undefined, 25)) as {
      file: string;
      declared: { name: string; file: string; line: number }[];
      referencing_files: string[];
      unreferenced: { name: string }[];
    };
    expect(out.file).toBe("src/own.ts");
    expect(out.declared).toEqual([
      { name: "ownA", file: "src/own.ts", line: 1 },
      { name: "ownB", file: "src/own.ts", line: 5 },
    ]);
    expect(out.referencing_files).toEqual(["src/user-one.ts", "src/user-two.ts"]);
    expect(out.unreferenced).toEqual([{ name: "ownB", file: "src/own.ts", line: 5 }]);
    expect(calls).toHaveLength(1);
    expect(String(calls[0].args.query)).toContain("LIMIT 2000");
  });
});

describe("runTemplate / listTemplates", () => {
  test("unknown template throws UNKNOWN_TEMPLATE with available list", async () => {
    const { client } = fakeClient(() => ({}));
    try {
      await runTemplate(client, "no-such-template", undefined, undefined, 25);
      throw new Error("expected runTemplate to throw");
    } catch (e) {
      expect((e as { code?: string }).code).toBe("UNKNOWN_TEMPLATE");
      expect((e as { details?: { available?: string[] } }).details?.available).toEqual(Object.keys(QUERY_TEMPLATES));
    }
  });

  test("listTemplates names every template and carries arg hints", () => {
    const listed = listTemplates();
    expect(listed.map((t) => t.name).sort()).toEqual(["callers-of", "dead-code", "symbol-set"]);
    expect(listed.find((t) => t.name === "dead-code")?.arg_hint).toBeUndefined();
    expect(listed.find((t) => t.name === "callers-of")?.arg_hint).toBe("<symbol>");
    expect(listed.find((t) => t.name === "symbol-set")?.arg_hint).toBe("<file-path>");
  });
});

describe("routeAndRetrieve deadcode branch delegates to the shared template", () => {
  test("structural.isolated matches the dead-code template output", async () => {
    const searchHit = {
      results: [
        {
          name: "unusedHelper",
          qualified_name: "proj.src.cli.commands.graph.unusedHelper",
          file_path: "src/cli/commands/graph.ts",
          label: "Function",
          start_line: 3,
        },
      ],
    };
    const all = {
      columns: [],
      rows: [
        ["usedVar", "src/a.ts", 1],
        ["lonelyVar", "src/b.ts", 2],
      ],
      total: 2,
    };
    const calls: { tool: string; args: Record<string, unknown> }[] = [];
    const client = {
      call: async (tool: string, args: Record<string, unknown>) => {
        calls.push({ tool, args });
        if (tool === "search_graph") return searchHit;
        return String((args as { query: string }).query).includes("DISTINCT")
          ? { columns: [], rows: [["usedVar"]] }
          : all;
      },
      close: async () => {},
    } as unknown as CbmClient;
    const out = await routeAndRetrieve(client, "Find a source variable declared but never read elsewhere.");
    expect(out.kind).toBe("deadcode");
    expect(out.structural?.isolated).toEqual([{ name: "lonelyVar", file: "src/b.ts", line: 2 }]);
    // exactly the two query_graph calls the shared template issues
    expect(calls.filter((c) => c.tool === "query_graph")).toHaveLength(2);
  });
});
