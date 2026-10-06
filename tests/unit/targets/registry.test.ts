import { describe, expect, test } from "bun:test";
import { agentDirsFor, getTarget, isValidTarget, listTargets } from "../../../src/targets/registry.js";

describe("target registry", () => {
  test("exactly pi and claude are registered", () => {
    expect(listTargets().map((t) => t.id)).toEqual(["pi", "claude"]);
  });

  test("pi dir order puts pi first (validate probes .omp agents first)", () => {
    expect(agentDirsFor("/proj")).toEqual(["/proj/.omp/agents", "/proj/.claude/agents"]);
  });

  test("pi reproduces current layout", () => {
    const t = getTarget("pi");
    expect(t.installDir).toBe(".omp");
    expect(t.agents.dir).toBe("agents");
    expect(t.agents.format).toBe("prompt-fragment");
    expect(t.skills.dir).toBe("skills");
    expect(t.rulesStrategy).toBe("agents-md-sections");
    expect(t.hooksKind).toBe("extension-ts");
    expect(t.commandsKind).toBe("prompt-template");
  });

  test("claude reproduces current layout", () => {
    const t = getTarget("claude");
    expect(t.installDir).toBe(".claude");
    expect(t.agents.dir).toBe("agents");
    expect(t.agents.format).toBe("md-frontmatter");
    expect(t.skills.dir).toBe("skills");
    expect(t.rulesStrategy).toBe("rules-dir");
    expect(t.hooksKind).toBe("settings-json");
    expect(t.commandsKind).toBe("slash-skill");
  });

  test("pi and claude declare expected capabilities", () => {
    expect(getTarget("pi").execution.subagentDispatch).toBe("extension");
    expect(getTarget("claude").execution.subagentDispatch).toBe("task-tool");
  });

  test("isValidTarget guards bad input", () => {
    expect(isValidTarget("pi")).toBe(true);
    expect(isValidTarget("claude")).toBe(true);
    expect(isValidTarget("cursor")).toBe(false);
    expect(isValidTarget("opencode")).toBe(false);
    expect(isValidTarget("codex")).toBe(false);
    expect(isValidTarget("vscode")).toBe(false);
  });
});
