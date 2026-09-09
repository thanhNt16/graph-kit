import { describe, expect, test } from "bun:test";
import {
  CBM_CONTRACT_VERSION,
  type QueryResult,
  type SearchResult,
  type TraceHop,
  type TraceResult,
} from "../../src/cbm/contract";

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

  test("TraceHop literal type-checks with optional server coordinates (R5)", () => {
    const hop: TraceHop = {
      name: "registerGraphCommands",
      qualified_name: "proj.src.cli.commands.graph.registerGraphCommands",
      hop: 1,
      file_path: "src/cli/commands/graph.ts",
      start_line: 231,
      end_line: 812,
    };
    expect(hop.file_path).toBe("src/cli/commands/graph.ts");
    expect(hop.start_line).toBe(231);
    expect(hop.end_line).toBe(812);
    // and a bare hop still type-checks (additive change)
    const bare: TraceHop = { name: "x", qualified_name: "y", hop: 2 };
    expect(bare.file_path).toBeUndefined();
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
