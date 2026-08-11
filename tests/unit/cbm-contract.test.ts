import { describe, expect, test } from "bun:test";
import { CBM_CONTRACT_VERSION, type QueryResult, type SearchResult, type TraceResult } from "../../src/cbm/contract";

describe("CBM contract", () => {
  test("version is 2", () => {
    expect(CBM_CONTRACT_VERSION).toBe("2");
  });

  test("SearchResult literal type-checks", () => {
    const r: SearchResult = {
      total: 1,
      search_mode: "bm25",
      results: [
        {
          name: "validateGraph",
          qualified_name: "validateGraph",
          label: "Function",
          file_path: "src/compiler/validate.ts",
          start_line: 1,
          end_line: 10,
          rank: -12.5,
        },
      ],
      has_more: false,
    };
    expect(r.results).toHaveLength(1);
  });

  test("TraceResult literal type-checks", () => {
    const r: TraceResult = {
      function: "validateGraph",
      direction: "inbound",
      callers: [{ name: "registerGraphCommands", qualified_name: "registerGraphCommands", hop: 1 }],
      callees: [],
    };
    expect(r.callers).toHaveLength(1);
  });

  test("QueryResult literal type-checks", () => {
    const r: QueryResult = {
      columns: ["f.name", "f.qualified_name"],
      rows: [["validateGraph", "validateGraph"]],
      total: 1,
    };
    expect(r.total).toBe(1);
  });
});
