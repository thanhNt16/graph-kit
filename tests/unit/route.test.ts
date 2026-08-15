import { describe, expect, test } from "bun:test";
import { classifyQuestion, deriveFiles } from "../../src/cbm/route.js";

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
