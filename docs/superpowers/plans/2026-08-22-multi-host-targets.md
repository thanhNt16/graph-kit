# Multi-Host Targets (OpenCode, Codex, Pi) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add OpenCode, Codex CLI, and pi coding agent as full GraphKit targets — kit templates in each host's native format plus native `/gk:execute` execution.

**Architecture:** A `src/targets/` descriptor registry becomes the single source of truth for per-host install paths, file formats, model-tier maps, and execution capability. Kit template trees move under `kits/<id>/`; `gk init --target <id>` copies them. Each host gets an execution path: opencode via Task tool, codex via TOML agents + spawn-prompt protocol, pi via a shipped TS extension registering a `gk_dispatch_agent` tool.

**Tech Stack:** TypeScript/Bun (existing), TOML emission (hand-rolled string emitter — no new dep), pi extension API (TypeScript).

**Spec:** `docs/superpowers/specs/2026-08-22-multi-host-targets-design.md`

## Global Constraints

- Existing `claude` and `cursor` targets must remain byte-for-byte identical in behavior; all 364 existing tests stay green.
- graph.yaml schema unchanged across targets; compiler/waves output stays target-agnostic.
- Tier vocabulary stays `opus | sonnet | haiku | fable` (`Tier` type from `src/models/cursor-map.ts`).
- No new runtime dependencies.
- Test runner is `bun test`; lint via `bun run lint` (biome); typecheck via `bun run typecheck`.
- Kit files are kit-owned and always overwrite on init; only `.gk.json` survives upgrades.
- Commit after every task; conventional commit messages.

## File Structure

```
src/targets/
  types.ts            # TargetDescriptor interface + Tier re-export
  registry.ts         # TARGETS record + getTarget()/listTargets()
  model-tiers.ts      # resolveModel(targetId, tier, overrides) — replaces cursor-map.ts
kits/
  claude/             # moved from ./claude (git mv)
  cursor/             # moved from ./cursor (git mv)
  opencode/           # new: agent/, skill/, command/, plugin/, rules sections
  codex/              # new: agents/*.toml, skills -> .agents/skills at install, AGENTS.md section
  pi/                 # new: extensions/gk-subagent.ts, agents/*.md, skills/, prompts/gk.md
src/cli/commands/kit.ts       # modify: descriptor-driven init/new
src/models/cursor-map.ts      # kept as one-release shim re-exporting from targets/model-tiers.ts
tests/unit/targets/           # registry, tier resolution tests
tests/integration/init-targets.test.ts  # per-target init tree assertions
```

---

### Task 1: Target descriptor types + registry

**Files:**
- Create: `src/targets/types.ts`
- Create: `src/targets/registry.ts`
- Test: `tests/unit/targets/registry.test.ts`

**Interfaces:**
- Produces:
  - `type TargetId = "claude" | "cursor" | "opencode" | "codex" | "pi"`
  - `interface TargetDescriptor { id, kitDirName, installDir, agents: {dir, format}, skills: {dir}, rulesStrategy, hooksKind, commandsKind, execution: {workflowTool, subagentDispatch} }`
  - `getTarget(id: TargetId): TargetDescriptor`
  - `listTargets(): TargetDescriptor[]`
  - `isValidTarget(s: string): s is TargetId`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/targets/registry.test.ts
import { describe, expect, test } from "bun:test";
import { getTarget, isValidTarget, listTargets } from "../../../src/targets/registry.js";

describe("target registry", () => {
  test("all five targets registered", () => {
    expect(listTargets().map((t) => t.id).sort()).toEqual(["claude", "codex", "cursor", "opencode", "pi"]);
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/targets/registry.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/targets/types.ts
export type Tier = "opus" | "sonnet" | "haiku" | "fable";

export type AgentFormat = "md-frontmatter" | "mdc" | "toml" | "prompt-fragment";
export type RulesStrategy = "rules-dir" | "agents-md-sections" | "instructions-md";
export type HooksKind = "settings-json" | "hooks-json" | "plugin-ts" | "extension-ts" | "instructions";
export type CommandsKind = "slash-skill" | "command-md" | "prompts-dir" | "prompt-template";
export type SubagentDispatch = "task-tool" | "spawn-prompt" | "extension" | "none";

export interface TargetDescriptor {
  id: string;
  kitDirName: string;
  installDir: string;
  agents: { dir: string; format: AgentFormat };
  skills: { dir: string };
  rulesStrategy: RulesStrategy;
  hooksKind: HooksKind;
  commandsKind: CommandsKind;
  execution: { workflowTool: boolean; subagentDispatch: SubagentDispatch };
}
```

```ts
// src/targets/registry.ts
import type { TargetDescriptor } from "./types.js";

const TARGETS: Record<string, TargetDescriptor> = {
  claude: {
    id: "claude",
    kitDirName: "claude",
    installDir: ".claude",
    agents: { dir: "agents", format: "md-frontmatter" },
    skills: { dir: "skills" },
    rulesStrategy: "rules-dir",
    hooksKind: "settings-json",
    commandsKind: "slash-skill",
    execution: { workflowTool: true, subagentDispatch: "task-tool" },
  },
  cursor: {
    id: "cursor",
    kitDirName: "cursor",
    installDir: ".cursor",
    agents: { dir: "agents", format: "mdc" },
    skills: { dir: "skills" },
    rulesStrategy: "rules-dir",
    hooksKind: "hooks-json",
    commandsKind: "slash-skill",
    execution: { workflowTool: false, subagentDispatch: "task-tool" },
  },
  opencode: {
    id: "opencode",
    kitDirName: "opencode",
    installDir: ".opencode",
    agents: { dir: "agent", format: "md-frontmatter" },
    skills: { dir: "skill" },
    rulesStrategy: "agents-md-sections",
    hooksKind: "plugin-ts",
    commandsKind: "command-md",
    execution: { workflowTool: false, subagentDispatch: "task-tool" },
  },
  codex: {
    id: "codex",
    kitDirName: "codex",
    installDir: ".codex",
    agents: { dir: "agents", format: "toml" },
    skills: { dir: "../.agents/skills" }, // installed into sibling .agents/skills
    rulesStrategy: "agents-md-sections",
    hooksKind: "instructions",
    commandsKind: "prompts-dir",
    execution: { workflowTool: false, subagentDispatch: "spawn-prompt" },
  },
  pi: {
    id: "pi",
    kitDirName: "pi",
    installDir: ".pi",
    agents: { dir: "agents", format: "prompt-fragment" },
    skills: { dir: "skills" },
    rulesStrategy: "instructions-md",
    hooksKind: "extension-ts",
    commandsKind: "prompt-template",
    execution: { workflowTool: false, subagentDispatch: "extension" },
  },
};

const VALID = new Set(Object.keys(TARGETS));

export function isValidTarget(s: string): s is keyof typeof TARGETS & string {
  return VALID.has(s);
}

export function getTarget(id: string): TargetDescriptor {
  const t = TARGETS[id];
  if (!t) throw new Error(`Unknown target: ${id}`);
  return t;
}

export function listTargets(): TargetDescriptor[] {
  return Object.values(TARGETS);
}
```

Note: codex skills install into `.agents/skills/` (sibling of `.codex/`). Task 3 handles that special-case in `installKit`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/targets/registry.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/targets tests/unit/targets && git commit -m "feat(targets): target descriptor registry"
```

---

### Task 2: Model tier resolution per target

**Files:**
- Create: `src/targets/model-tiers.ts`
- Modify: `src/models/index.ts`
- Modify: `src/models/cursor-map.ts` (becomes shim)
- Test: `tests/unit/targets/model-tiers.test.ts`

**Interfaces:**
- Consumes: `Tier` from `src/targets/types.ts`
- Produces: `resolveModel(targetId: string, model: string | undefined, overrides?: Record<string, string>): string`; `TARGET_MODEL_DEFAULTS: Record<string, Record<Tier, string>>`. Keep old exports working: `CURSOR_MODEL_DEFAULTS`, `resolveCursorModel` re-exported from `src/models/index.ts` (one-release shim).

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/targets/model-tiers.test.ts
import { describe, expect, test } from "bun:test";
import { resolveModel, TARGET_MODEL_DEFAULTS } from "../../../src/targets/model-tiers.js";

describe("per-target model tiers", () => {
  test("defaults for all five targets cover four tiers", () => {
    for (const t of ["claude", "cursor", "opencode", "codex", "pi"]) {
      for (const tier of ["opus", "sonnet", "haiku", "fable"]) {
        expect(typeof TARGET_MODEL_DEFAULTS[t][tier]).toBe("string");
      }
    }
  });

  test("known defaults", () => {
    expect(TARGET_MODEL_DEFAULTS.cursor.opus).toBe("Grok 4.5"); // regression guard
    expect(TARGET_MODEL_DEFAULTS.opencode.opus).toBe("anthropic/claude-opus-4.5");
    expect(TARGET_MODEL_DEFAULTS.codex.opus).toBe("gpt-5.4");
    expect(TARGET_MODEL_DEFAULTS.codex.sonnet).toBe("gpt-5.3-codex-spark");
  });

  test("override wins over default", () => {
    expect(resolveModel("codex", "opus", { opus: "gpt-5.5" })).toBe("gpt-5.5");
  });

  test("unknown or missing model falls back to Auto", () => {
    expect(resolveModel("codex", undefined)).toBe("Auto");
    expect(resolveModel("codex", "gpt-4")).toBe("Auto");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/targets/model-tiers.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Move the mapping logic from `src/models/cursor-map.ts` into `src/targets/model-tiers.ts`, generalized:

```ts
// src/targets/model-tiers.ts
import type { Tier } from "./types.js";

export const TARGET_MODEL_DEFAULTS: Record<string, Record<Tier, string>> = {
  claude: { opus: "opus", sonnet: "sonnet", haiku: "haiku", fable: "fable" },
  cursor: { opus: "Grok 4.5", sonnet: "Composer 2.5", haiku: "Auto", fable: "Auto" },
  opencode: {
    opus: "anthropic/claude-opus-4.5",
    sonnet: "anthropic/claude-sonnet-4.5",
    haiku: "anthropic/claude-haiku-4.5",
    fable: "Auto",
  },
  codex: { opus: "gpt-5.4", sonnet: "gpt-5.3-codex-spark", haiku: "gpt-5.3-codex-spark", fable: "gpt-5.4" },
  pi: { opus: "", sonnet: "", haiku: "", fable: "" }, // empty → resolved from user's models.json by pi itself; emit no model field
};

export function resolveModel(targetId: string, model: string | undefined, overrides: Record<string, string> = {}): string {
  if (!model) return "Auto";
  if (overrides[model]) return overrides[model];
  const tiers = TARGET_MODEL_DEFAULTS[targetId];
  if (!tiers) return "Auto";
  const v = tiers[model as Tier];
  return v === "" ? "" : (v ?? "Auto");
}
```

Then make `src/models/cursor-map.ts` a shim:

```ts
// src/models/cursor-map.ts — deprecated shim, folds into src/targets/model-tiers.ts
import { TARGET_MODEL_DEFAULTS, resolveModel } from "../targets/model-tiers.js";

export type Tier = "opus" | "sonnet" | "haiku" | "fable";

export const CURSOR_MODEL_DEFAULTS: Record<Tier, string> = TARGET_MODEL_DEFAULTS.cursor;

export function resolveCursorModel(model: string | undefined, overrides: Record<string, string> = {}): string {
  return resolveModel("cursor", model, overrides);
}
```

`src/models/index.ts` stays `export * from "./cursor-map.js";`.

- [ ] **Step 4: Verify both old and new tests pass**

Run: `bun test tests/unit/targets/model-tiers.test.ts tests/unit/cursor-model-map.test.ts`
Expected: PASS (old cursor tests must still pass through the shim).

- [ ] **Step 5: Commit**

```bash
git add src/targets src/models tests/unit/targets && git commit -m "feat(targets): per-target model tier resolution, cursor-map becomes shim"
```

---

### Task 2b: Generalize `gk models` to all targets

**Files:**
- Modify: `src/cli/commands/models.ts`
- Test: `tests/unit/cli-models.test.ts` (extend)

**Interfaces:**
- Consumes: `TARGET_MODEL_DEFAULTS`, `resolveModel` from Task 2; `isValidTarget`, `listTargets` from Task 1.
- Produces: `gk models <target> set|reset|show` for all five targets; overrides stored at `.graphkit/models.<target>.json`. `loadOverrides(cwd)` becomes `loadOverrides(cwd, target)` — old single-arg call sites in this file updated. `models cursor ...` behavior unchanged (same file path as before).

- [ ] **Step 1: Extend failing tests**

Add to `tests/unit/cli-models.test.ts`:

```ts
test("models codex show resolves codex defaults", () => {
  // invoke registerModelsCommands via existing test harness pattern used above;
  // run `models codex` and expect data.opus === "gpt-5.4"
});

test("models vscode is rejected with target list", () => {
  // expect UNKNOWN_MODELS_SUBCOMMAND with available listing all five targets
});

test("codex overrides persist to .graphkit/models.codex.json", () => {
  // models codex set --map opus=gpt-5.5 → loadOverrides(cwd, "codex").opus === "gpt-5.5"
});
```

(Follow the exact invocation pattern already used by the existing cursor tests in this file.)

- [ ] **Step 2: Run new tests to verify they fail**

Run: `bun test tests/unit/cli-models.test.ts`
Expected: FAIL — subcommand rejected.

- [ ] **Step 3: Implement**

In `src/cli/commands/models.ts`:

1. `overridesPath(cwd, target)` → `join(cwd, ".graphkit", \`models.${target}.json\`)`; `loadOverrides`/`writeOverrides` take `target` param.
2. Replace `subcommand !== "cursor"` guard with `!isValidTarget(subcommand)`; failure payload lists `listTargets().map(t => t.id)`.
3. Replace `CURSOR_MODEL_DEFAULTS`/`resolveCursorModel` imports with `resolveModel`, `getTarget` from `src/targets/`.
4. Show branch iterates tiers of `getTarget(subcommand)` via `resolveModel(subcommand, tier, loadOverrides(cwd, subcommand))`.
5. Command description: "Per-target model mapping commands".

- [ ] **Step 4: Run full models tests**

Run: `bun test tests/unit/cli-models.test.ts`
Expected: PASS including pre-existing cursor cases.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/models.ts tests/unit/cli-models.test.ts && git commit -m "feat(models): generalize gk models to all five targets"
```

---

### Task 3: Descriptor-driven `gk init` / `gk new`

**Files:**
- Modify: `src/cli/commands/kit.ts`
- Modify: `package.json` (`files`: add `"kits/"`)
- Test: `tests/integration/init-targets.test.ts`

**Interfaces:**
- Consumes: `getTarget`, `isValidTarget`, `listTargets` from `src/targets/registry.js`
- Produces: `installKit(targetDir, fresh, target)` unchanged signature, now accepting all five targets; `kitSourceDir(target)` resolves `kits/<kitDirName>`.

- [ ] **Step 1: Move kit dirs (git mv preserves history)**

```bash
mkdir kits && git mv claude kits/claude && git mv cursor kits/cursor
```

Update every reference to the old paths: grep repo for `join(ROOT, "claude"` / `"cursor"` style usages in `tests/` and `scripts/` and change to `kits/claude` / `kits/cursor`. Known affected: `tests/unit/kit-skill-parity.test.ts` (`ROOT` joins), `tests/unit/cursor-kit.test.ts`, `tests/unit/package-pack.test.ts`, `scripts/build-viewer.sh` if it references kit dirs. Run `grep -rn '"claude/\|"cursor/' src scripts tests package.json` and fix each hit.

- [ ] **Step 2: Write the failing integration test**

```ts
// tests/integration/init-targets.test.ts
import { describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const TMP = join(import.meta.dir, "..", "..", ".tmp-init-test");

function initTmp(target: string): string {
  rmSync(TMP, { recursive: true, force: true });
  execSync(`bun run dist/index.js init --target ${target}`, { cwd: process.cwd(), env: { ...process.env, GK_KIT_DIR: join(process.cwd(), "kits", target) } });
  return TMP;
}

describe("init per target", () => {
  test("opencode tree", () => {
    initTmp("opencode");
    expect(existsSync(join(TMP, ".opencode", "agent"))).toBe(true);
    expect(existsSync(join(TMP, ".opencode", "skill"))).toBe(true);
    expect(existsSync(join(TMP, ".opencode", "plugin", "gk.ts"))).toBe(true);
    expect(existsSync(join(TMP, ".opencode", "command"))).toBe(true);
  });

  test("codex tree — agents toml + skills land in .agents/skills", () => {
    initTmp("codex");
    expect(existsSync(join(TMP, ".codex", "agents"))).toBe(true);
    expect(existsSync(join(TMP, ".agents", "skills"))).toBe(true);
  });

  test("pi tree", () => {
    initTmp("pi");
    expect(existsSync(join(TMP, ".pi", "extensions", "gk-subagent.ts"))).toBe(true);
    expect(existsSync(join(TMP, ".pi", "skills"))).toBe(true);
    expect(existsSync(join(TMP, ".pi", "agents"))).toBe(true);
    expect(existsSync(join(TMP, ".pi", "prompts", "gk.md"))).toBe(true);
  });

  test("invalid target exits 1 with BAD_TARGET", () => {
    let code = 0;
    try {
      execSync(`bun run dist/index.js init --target vscode`, { encoding: "utf8", stdio: "pipe" });
    } catch (e: any) {
      code = e.status;
      expect(String(e.stdout)).toContain("BAD_TARGET");
      expect(String(e.stdout)).toContain("opencode"); // lists valid targets
    }
    expect(code).toBe(1);
  });

  // cleanup after all tests
  test("cleanup", () => {
    rmSync(TMP, { recursive: true, force: true });
    expect(true).toBe(true);
  });
});
```

Note: this test requires Tasks 4–6 kit content to exist to fully pass. Write it now, but mark it as expected-fail until those tasks land; alternatively land this test together with Task 6. Recommended: implement Steps 3–4 now but only assert the two things available immediately (BAD_TARGET behavior + claude/cursor regression via existing suites), then extend assertions when kit trees exist. Simplest correct sequencing: write the file as above but keep the three tree assertions behind `test.skip.if(!existsSync(...))` guards — remove guards in Task 6.

- [ ] **Step 3: Rewrite kit.ts around descriptors**

Key changes to `src/cli/commands/kit.ts`:

1. Replace `KitTarget` type and hardcoded checks with registry:

```ts
import { getTarget, isValidTarget, listTargets } from "../../targets/registry.js";

function kitSourceDir(targetId = "claude"): string {
  const t = getTarget(targetId);
  const kitName = t.kitDirName;
  // candidate list identical to current implementation, just uses kitName
  // ... (keep all 7 candidates verbatim, substituting kitName)
}

export function installKit(targetDir: string, fresh = false, target = "claude"): { installed: string[] } {
  const t = getTarget(target);
  const source = kitSourceDir(target);
  const destDir = join(targetDir, t.installDir);

  if (fresh && existsSync(destDir)) rmSync(destDir, { recursive: true, force: true });
  mkdirSync(destDir, { recursive: true });
  cpSync(source, destDir, { recursive: true, force: true, filter: (s) => basename(s) !== ".gk.json" });

  // codex special case: skills also install into sibling .agents/skills/
  if (t.id === "codex") {
    const skillsSrc = join(source, "skills");
    if (existsSync(skillsSrc)) {
      cpSync(skillsSrc, join(targetDir, ".agents", "skills"), { recursive: true, force: true });
    }
  }

  // settings.json overwrite stays claude-only (descriptor hooksKind === "settings-json")
  if (t.hooksKind === "settings-json") {
    const settingsSrc = join(source, "settings.json");
    if (existsSync(settingsSrc)) cpSync(settingsSrc, join(destDir, "settings.json"), { force: true });
  }

  const gkConfig = join(destDir, ".gk.json");
  if (!existsSync(gkConfig)) {
    writeFileSync(gkConfig, JSON.stringify({ codingLevel: 0, statusline: "full" }, null, 2));
  }
  return { installed: readdirSync(destDir) };
}
```

2. In `registerKitCommands`, replace both `["claude","cursor"].includes(...)` guards:

```ts
if (!isValidTarget(opts.target)) {
  const valid = listTargets().map((t) => t.id).join(", ");
  console.log(JSON.stringify(fail("BAD_TARGET", `Invalid target: ${opts.target}. Must be one of: ${valid}`)));
  process.exit(1);
}
```

Also update both `--target` option descriptions to "Kit target: claude, cursor, opencode, codex, or pi".

3. Update `templatesDir()` — it already delegates to `kitSourceDir(target)`, no signature change needed.

- [ ] **Step 4: Update package.json files array**

Replace `"claude/", "cursor/"` with `"kits/"`.

- [ ] **Step 5: Run full suite — claude/cursor regressions must pass**

Run: `bun test tests/unit/cursor-kit.test.ts tests/unit/kit-skill-parity.test.ts tests/unit/package-pack.test.ts`
Expected: PASS (paths updated in Step 1).

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "refactor(kit): descriptor-driven gk init/new; kit dirs move under kits/"
```

---

### Task 4: OpenCode kit content

**Files:**
- Create: `kits/opencode/agent/{8 agents}.md`
- Create: `kits/opencode/skill/<13 skills>/SKILL.md`
- Create: `kits/opencode/command/gk-{visualize,init-graph,template,brainstorm,validate,eval,recall,evidence,status,execute}.md`
- Create: `kits/opencode/plugin/gk.ts`
- Create: `kits/opencode/metadata.json`
- Test: extend `tests/integration/init-targets.test.ts` (remove skip guards for opencode)

**Interfaces:**
- Consumes: nothing from src — static content.
- Produces: agent names identical to `kits/claude/agents/*.md` basenames so `/gk:execute` skill text works unmodified.

- [ ] **Step 1: Agents — copy from claude with frontmatter adaptation**

For each of the 8 files in `kits/claude/agents/` (agents-orchestrator, code-reviewer, data-engineer, document-generator, memory-curator, qa-engineer, software-architect, ui-ux-researcher):

1. Copy body verbatim.
2. Replace frontmatter with OpenCode shape. Example for software-architect:

```markdown
---
description: System design and architecture review agent. Use for topology planning, objective decomposition, synthesis of multi-agent findings.
mode: subagent
model: anthropic/claude-opus-4.5
---
```

Mapping rules: claude frontmatter `name` → drop (OpenCode derives from filename); `description` → keep verbatim; `tools:`/read-only constraints from claude body → `mode: subagent` plus `tools:` line only where claude declared a restricted toolset; `model: opus|sonnet|haiku` → the opencode default ids from `TARGET_MODEL_DEFAULTS.opencode`.

- [ ] **Step 2: Skills — copy 13 skills from kits/claude/skills minus gk-compile and gk-run**

Same exclusion rule Cursor uses (`CLAUDE_ONLY = ["gk-compile", "gk-run"]`). For each copied skill:

1. Change frontmatter `name: gk:<x>` → `name: gk-x` (dash form — same rule as cursor, enforced by parity test).
2. Inside bodies, rewrite Claude-specific references: "Agent tool" → "Task tool"; `.claude/` paths → `.opencode/`; `/gk:x` invocations stay (they map to the command files).
3. `gk-execute/SKILL.md`: dispatch instructions become "dispatch each node via the **Task tool** with `subagent_type` set to the node's agent name; wave barrier = wait for all background tasks in the wave before proceeding". Keep waves JSON flow (`gk graph waves graph.yaml --json`) verbatim.

- [ ] **Step 3: Command files — thin wrappers**

One markdown command per skill, e.g. `kits/opencode/command/gk-execute.md`:

```markdown
---
description: Execute a graph.yaml by dispatching subagents wave by wave.
agent: general
---
Read and follow the full instructions in .opencode/skill/gk-execute/SKILL.md. Arguments: $ARGUMENTS
```

Repeat for the 10 skills listed above (skip eval-only helpers if claude kit does the same — mirror exactly which claude skills are user-invocable via `user-invocable: true`).

- [ ] **Step 4: Plugin porting the 4 hooks**

Create `kits/opencode/plugin/gk.ts` implementing OpenCode's plugin hook API. Port semantics from `kits/claude/hooks/*.cjs`:

- `evidence-persist` → on tool result matching evidence write path, persist to `.graphkit/evidence/`
- `graph-state-guard` → block writes to `.graphkit/state/*` outside the executing session
- `lease-enforce` → enforce worktree/ownership lease file check before Edit/Write in leased paths
- `memory-persist` → append memory writes to `.graphkit/memory/` journal

Implementation note: read each `.cjs` hook first; keep the exact file paths and state formats identical so cross-run data stays compatible. If the opencode plugin API lacks a needed event (check docs at https://opencode.ai/docs/plugins), degrade that hook to a documented instruction appended to `AGENTS.md` instead — do not fake enforcement.

- [ ] **Step 5: metadata.json**

```json
{ "name": "graphkit", "version": "0.2.0", "apiVersion": "graphkit.dev/v2", "deletions": [], "target": "opencode" }
```

(Version synced with `claude/metadata.json` at release time.)

- [ ] **Step 6: Extend parity test coverage**

Add to `tests/unit/kit-skill-parity.test.ts` a parameterized loop treating opencode like cursor (same CLAUDE_ONLY exclusion, dash-form names). Extend the init integration test assertions from Task 3 (remove opencode skip guard).

- [ ] **Step 7: Run tests**

Run: `bun test tests/unit/kit-skill-parity.test.ts tests/integration/init-targets.test.ts && bun run lint && bun run typecheck`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add kits/opencode tests && git commit -m "feat(opencode): kit template — agents, skills, commands, hooks plugin"
```

---

### Task 5: Codex kit content

**Files:**
- Create: `kits/codex/agents/{8 agents}.toml`
- Create: `kits/codex/skills/<11 skills>/SKILL.md`
- Create: `kits/codex/rules-section.md` (appended to project AGENTS.md by init — see Step 4)
- Test: `tests/unit/codex-kit.test.ts`

**Interfaces:**
- Consumes: `resolveModel("codex", tier)` from Task 2 for emitted `model` fields.
- Produces: TOML agent names matching claude agent basenames (underscored: `software_architect`), referenced by the execute skill's spawn protocol.

- [ ] **Step 1: Agents — TOML conversion**

For each claude agent md, emit a TOML file. Example (`kits/codex/agents/software-architect.toml`):

```toml
name = "software_architect"
description = "<verbatim description line from claude frontmatter>"
model = "gpt-5.4"
model_reasoning_effort = "high"
sandbox_mode = "workspace-write"

developer_instructions = """
<full body of the claude agent md, verbatim>
"""
```

Rules: read-only agents (code-reviewer, ui-ux-researcher, agents-orchestrator, memory-curator) get `sandbox_mode = "read-only"`; writers (data-engineer, qa-engineer, software-architect when planning, document-generator) get `"workspace-write"`. `model` values come from `TARGET_MODEL_DEFAULTS.codex` (opus→gpt-5.4/high, sonnet/haiku→gpt-5.3-codex-spark/medium). Filename matches `name` with hyphens (Codex matches on `name` field; hyphen filename is fine).

- [ ] **Step 2: Skills — copy with spawn-protocol rewrite**

Copy the same 11 non-Claude-only skills into `kits/codex/skills/`. Dash-form names. In `gk-execute/SKILL.md` replace the dispatch section with the spawn protocol:

```markdown
## Dispatching a wave (Codex)

For each node in the current wave, instruct Codex to spawn its custom agent by name,
in parallel, then WAIT for all results before continuing to the next wave. Example prompt:

"Spawn one <agent_name> agent per item below. Give each the objective and inputs listed.
Wait for ALL agents to finish before summarizing results back to me."

Wave barrier rule: never start wave N+1 until every agent of wave N has returned its summary.
If an agent fails, stop the graph and report which node failed — do not skip ahead.
```

Keep `gk graph waves --json` step identical.

- [ ] **Step 3: Rules content**

Create `kits/codex/rules-section.md` containing the three rules from `kits/claude/rules/` (agent-binding.md, graph-authority.md, topology-routing.md) concatenated under a `## GraphKit` heading, plus hook-degradation notes: lease/state-guard behaviors stated as explicit instructions ("Never edit files under `.graphkit/state/` directly…").

- [ ] **Step 4: Init appends AGENTS.md section**

In `installKit` (kit.ts), add codex branch: if project `AGENTS.md` exists and lacks `<!-- graphkit:start -->`, append the marked section:

```ts
if (t.rulesStrategy === "agents-md-sections") {
  const agentsMd = join(targetDir, "AGENTS.md");
  const marker = "<!-- graphkit:start -->";
  const section = readFileSync(join(source, "rules-section.md"), "utf8");
  if (!existsSync(agentsMd)) {
    writeFileSync(agentsMd, `${section}\n`);
  } else if (!readFileSync(agentsMd, "utf8").includes(marker)) {
    writeFileSync(agentsMd, `${readFileSync(agentsMd, "utf8")}\n${section}\n`);
  }
}
```

Marked section wraps content: `<!-- graphkit:start -->\n...\n<!-- graphkit:end -->`. Idempotent on re-init.

- [ ] **Step 5: Write failing test then verify**

```ts
// tests/unit/codex-kit.test.ts
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");

describe("codex kit", () => {
  const agentsDir = join(ROOT, "kits", "codex", "agents");

  test("8 agents ship as parseable TOML with required fields", () => {
    const files = readdirSync(agentsDir).filter((f) => f.endsWith(".toml"));
    expect(files.length).toBe(8);
    for (const f of files) {
      const raw = readFileSync(join(agentsDir, f), "utf8");
      expect(raw.match(/^name\s*=\s*"(.+)"/m), `${f} name`).toBeTruthy();
      expect(raw.match(/^description\s*=\s*"/m), `${f} description`).toBeTruthy();
      expect(raw.includes("developer_instructions"), `${f} instructions`).toBe(true);
    }
  });

  test("skills match cursor set (no compile/run)", () => {
    const codex = readdirSync(join(ROOT, "kits", "codex", "skills")).sort();
    const cursor = readdirSync(join(ROOT, "kits", "cursor", "skills")).sort();
    expect(codex).toEqual(cursor);
  });

  test("rules section carries all three rule headings", () => {
    const raw = readFileSync(join(ROOT, "kits", "codex", "rules-section.md"), "utf8");
    expect(raw).toContain("agent-binding");
    expect(raw).toContain("graph-authority");
    expect(raw).toContain("topology-routing");
  });
});
```

Run: `bun test tests/unit/codex-kit.test.ts` → PASS.

- [ ] **Step 6: Commit**

```bash
git add kits/codex src/cli/commands/kit.ts tests && git commit -m "feat(codex): kit template — TOML agents, spawn-protocol skills, AGENTS.md rules"
```

---

### Task 6: Pi kit + gk_dispatch_agent extension

**Files:**
- Create: `kits/pi/extensions/gk-subagent.ts`
- Create: `kits/pi/agents/{8 agents}.md` (prompt fragments)
- Create: `kits/pi/skills/<11 skills>/SKILL.md`
- Create: `kits/pi/prompts/gk.md`
- Create: `kits/pi/instructions.md`
- Test: `tests/unit/pi-kit.test.ts` + `tests/unit/pi-extension.test.ts`

**Interfaces:**
- Produces: extension registers tool `gk_dispatch_agent` with schema `{ agent: string, objective: string, context?: string, constraints?: { no_write?: boolean, tools_allowlist?: string[] }, timeout_ms?: number }` returning `{ ok: boolean, output: string, exit_code: number }`.

- [ ] **Step 1: Extension — headless pi dispatch tool**

`kits/pi/extensions/gk-subagent.ts` core logic (adapt registration boilerplate to the pi extension API documented at https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md — check the actual `registerTool`/tool-definition signature against the installed pi version and adapt; the dispatch logic below is version-independent):

```ts
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

interface DispatchArgs {
  agent: string;
  objective: string;
  context?: string;
  constraints?: { no_write?: boolean; tools_allowlist?: string[] };
  timeout_ms?: number;
}

function loadAgentPrompt(agent: string): string | null {
  // .pi/agents/<agent>.md relative to cwd
  for (const base of [join(process.cwd(), ".pi", "agents")]) {
    const p = join(base, `${agent}.md`);
    if (existsSync(p)) return readFileSync(p, "utf8");
  }
  return null;
}

export function buildPiArgs(args: DispatchArgs): string[] {
  const argv = ["-p"]; // headless print mode
  if (args.constraints?.tools_allowlist?.length) argv.push("--tools", args.constraints.tools_allowlist.join(","));
  if (args.constraints?.no_write) argv.push("-t", "read,bash");
  return argv;
}

export async function dispatch(args: DispatchArgs): Promise<{ ok: boolean; output: string; exit_code: number }> {
  const fragment = loadAgentPrompt(args.agent);
  if (!fragment) return { ok: false, output: `Unknown agent: ${args.agent}`, exit_code: 1 };
  const prompt = [fragment, `## Objective\n${args.objective}`, args.context ? `## Context\n${args.context}` : ""].filter(Boolean).join("\n\n");
  const timeout = args.timeout_ms ?? 600_000;
  return new Promise((resolve) => {
    execFile("pi", [...buildPiArgs(args), prompt], { timeout, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        resolve({ ok: false, output: `${stdout}\n${String(err.message ?? "")}`.trim(), exit_code: err.killed ? 124 : (typeof err.code === "number" ? err.code : 1) });
      } else {
        resolve({ ok: true, output: stdout.trim(), exit_code: 0 });
      }
    });
  });
}
```

Register `dispatch` as a pi tool named `gk_dispatch_agent` with a JSON schema for `DispatchArgs` using whatever tool-registration primitive the loaded pi version exposes. Budget enforcement: honor `timeout_ms`; on timeout kill child and return `ok:false, exit_code:124` so the execute skill stops before the next wave.

- [ ] **Step 2: Agent fragments**

Each `kits/pi/agents/<name>.md` = claude agent body + one-line role header:

```markdown
You are <name>, acting as an isolated subagent. Complete the objective given in the dispatch message and output your findings as structured markdown.
<rest of claude agent body verbatim>
```

- [ ] **Step 3: Skills**

Copy the 11 shared skills into `kits/pi/skills/` with dash-form names. `gk-execute/SKILL.md` dispatch section replaced with:

```markdown
## Dispatching a wave (pi)

Use the `gk_dispatch_agent` tool (provided by the gk-subagent extension) once per node in
the current wave — issue all calls for the wave, collect every result, then proceed.
Wave barrier: do NOT start wave N+1 until every node of wave N returned ok:true.
A failed node (ok:false) stops the graph: report node name, objective, and error output.
Pass node constraints: no_write → constraints.no_write=true; tools → constraints.tools_allowlist.
```

- [ ] **Step 4: Prompt template + instructions**

`kits/pi/prompts/gk.md`:

```markdown
Load and follow .pi/skills/gk-status/SKILL.md first to report run state, then handle: $ARGUMENTS
```

`kits/pi/instructions.md`: concatenated GraphKit rules (same three rules as codex section) for users who want them in pi's context-file discovery.

- [ ] **Step 5: Tests**

```ts
// tests/unit/pi-extension.test.ts
import { describe, expect, test } from "bun:test";
import { buildPiArgs } from "../../kits/pi/extensions/gk-subagent";

describe("gk_dispatch_agent arg building", () => {
  test("headless flag always present", () => {
    expect(buildPiArgs({ agent: "x", objective: "y" })).toEqual(["-p"]);
  });

  test("allowlist passes through --tools", () => {
    expect(buildPiArgs({ agent: "x", objective: "y", constraints: { tools_allowlist: ["read", "grep"] } })).toEqual(["-p", "--tools", "read,grep"]);
  });

  test("no_write restricts tools", () => {
    expect(buildPiArgs({ agent: "x", objective: "y", constraints: { no_write: true } })).toEqual(["-p", "-t", "read,bash"]);
  });
});
```

```ts
// tests/unit/pi-kit.test.ts — structure assertions mirroring codex-kit.test.ts:
// 8 agent fragments, 11 skills, prompts/gk.md exists, instructions.md mentions graph-authority.
```

Import caveat: the extension imports `node:child_process` at top level, which bun test can import fine even though pi isn't installed — `execFile` is lazy-executed. Keep pure functions (`buildPiArgs`) exported separately from the registration side so tests import without triggering any pi runtime call.

Run: `bun test tests/unit/pi-extension.test.ts tests/unit/pi-kit.test.ts` → PASS.

- [ ] **Step 6: Remove remaining skip guards in init-targets.test.ts, run everything**

Run: `bun test && bun run lint && bun run typecheck`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add kits/pi tests && git commit -m "feat(pi): kit template — gk_dispatch_agent extension, fragments, skills"
```

---

### Task 7: README + inventory + final gate

**Files:**
- Modify: `README.md` (install table gains opencode/codex/pi rows; new "Host support" matrix replacing/augmenting "Cursor IDE support" section)
- Modify: `src/cli/commands/inventory.ts` (report via descriptor: agents/skills/hooks/commands per active target)

**Interfaces:**
- Consumes: `getTarget`, `listTargets`.

- [ ] **Step 1: Inventory reads descriptor**

In `inventory.ts`, replace any claude/cursor hardcoding with `getTarget(activeTarget)` fields: list files present under each descriptor dir (agents/skills/hooks/commands), names only.

- [ ] **Step 2: README update**

Add comparison-table rows for the three hosts mirroring the existing claude/cursor table (Rules / Agents / Skills / Hooks / Execution columns), using values from the spec §2 tables. Note the codex limitation ("wave barrier is instruction-enforced, not tool-enforced") and the pi requirement ("requires pi on PATH").

- [ ] **Step 3: Full CI gate locally**

Run: `bun run ci:local`
Expected: typecheck, lint, build, viewer build, all tests, cbm:parity — PASS.

- [ ] **Step 4: Commit**

```bash
git add README.md src/cli/commands/inventory.ts && git commit -m "docs+feat(inventory): five-host support matrix, descriptor-driven inventory"
```
