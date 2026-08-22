import { describe, expect, test } from "bun:test";
import { getTarget, isValidTarget, listTargets } from "../../../src/targets/registry.js";

describe("target registry", () => {
  test("all five targets registered", () => {
    expect(
      listTargets()
        .map((t) => t.id)
        .sort(),
    ).toEqual(["claude", "codex", "cursor", "opencode", "pi"]);
  });

  test("claude reproduces current layout", () => {
    const t = getTarget("claude");
    expect(t.installDir).toBe(".claude");
    expect(t.agents.format).toBe("md-frontmatter");
    expect(t.execution.workflowTool).toBe(true);
  });

  test("cursor reproduces current layout", () => {
    const t = getTarget("cursor");
    expect(t.installDir).toBe(".cursor");
    expect(t.execution.workflowTool).toBe(false);
    expect(t.execution.subagentDispatch).toBe("task-tool");
  });

  test("new hosts declare expected capabilities", () => {
    expect(getTarget("opencode").execution.subagentDispatch).toBe("task-tool");
    expect(getTarget("opencode").hooksKind).toBe("plugin-ts");
    expect(getTarget("codex").execution.subagentDispatch).toBe("spawn-prompt");
    expect(getTarget("codex").agents.format).toBe("toml");
    expect(getTarget("pi").execution.subagentDispatch).toBe("extension");
    expect(getTarget("pi").hooksKind).toBe("extension-ts");
  });

  test("isValidTarget guards bad input", () => {
    expect(isValidTarget("opencode")).toBe(true);
    expect(isValidTarget("vscode")).toBe(false);
  });
});
