# Multi-Host Targets: OpenCode, Codex, Pi

**Date:** 2026-08-22
**Status:** Approved design (pending implementation)
**Goal:** Full GraphKit compatibility — kit templates AND native `/gk:execute` execution — for OpenCode, Codex CLI, and pi coding agent, alongside existing Claude Code and Cursor targets.

## Background

GraphKit currently ships two kit templates: `claude/` and `cursor/`. The Cursor port established the pattern: same compiler, host-native kit formats, `/gk:execute` as the portable execution path. Three more hosts are in scope:

- **OpenCode** — agents in `.opencode/agent/*.md` (frontmatter), skills `.opencode/skill/`, slash commands `.opencode/command/*.md`, TypeScript plugins, Task-tool subagent dispatch.
- **Codex CLI** — subagents GA: custom agents as TOML files in `.codex/agents/` (`name`, `description`, `developer_instructions`, optional `model`, `model_reasoning_effort`, `sandbox_mode`). Skills read from `.agents/skills/`. Instructions from `AGENTS.md`. Spawning is prompt/skill-driven; no hook system.
- **pi coding agent** — minimal harness by design: skills (Agent Skills standard) in `.pi/skills/`, prompt templates `.pi/prompts/`, TS extensions for everything else. **No built-in subagents or hooks** — both are built via extensions.

## Chosen approach

**Per-host kit dirs + target descriptor registry** (mirrors the `cursor/` precedent). Rejected alternatives: canonical-source codegen adapters (over-engineered — TOML vs frontmatter vs extension code diverge too much), universal skills-only install (loses agents, hooks, execution).

## 1. Target registry (`src/targets/`)

New module replaces ad-hoc target handling. Single interface:

```ts
interface TargetDescriptor {
  id: "claude" | "cursor" | "opencode" | "codex" | "pi";
  kitDir: string;        // template dir shipped in package ("kits/<id>")
  installDir: string;    // ".claude", ".cursor", ".opencode", ".codex", ".pi"
  agents: { dir: string; format: "md-frontmatter" | "mdc" | "toml" | "prompt-fragment" };
  skills: { dir: string; format: "skill-md" };
  rules: { strategy: "rules-dir" | "agents-md-sections" | "instructions-md" };
  hooks: { kind: "settings-json" | "hooks-json" | "plugin-ts" | "extension-ts" | "instructions" };
  commands: { kind: "slash-skill" | "command-md" | "prompts-dir" | "prompt-template" };
  execution: {
    workflowTool: boolean;
    subagentDispatch: "task-tool" | "spawn-prompt" | "extension" | "none";
  };
  modelTiers: Record<Tier, string>;
}
```

- `src/models/cursor-map.ts` folds into the registry; each target declares `modelTiers`.
- `gk init --target <id>` reads the descriptor and copies `kits/<id>/`.
- Claude and Cursor descriptors reproduce current layouts byte-for-byte (regression guard).
- Kit dirs move to `kits/{claude,cursor,opencode,codex,pi}/`; old top-level `claude/` and `cursor/` paths keep re-export shims for one release.

## 2. Per-host kits

### kits/opencode/

| Piece | Location | Notes |
|---|---|---|
| Agents | `.opencode/agent/*.md` | 8 agents, frontmatter (`description`, `mode`, `model`, `tools`) |
| Skills | `.opencode/skill/*/SKILL.md` | Same 13 gk skills, adjusted paths |
| Commands | `.opencode/command/gk-*.md` | Slash commands wrapping skills |
| Plugin | `.opencode/plugin/gk.ts` | Ports the 4 hooks: evidence-persist, graph-state-guard, lease-enforce, memory-persist |
| Rules | `AGENTS.md` sections appended by init | graph-authority, agent-binding, topology-routing |

**Execution:** `/gk:execute` reads `gk graph waves --json`, dispatches each wave's nodes via the Task tool with kit agents as subagents, wave barrier between waves.

### kits/codex/

| Piece | Location | Notes |
|---|---|---|
| Agents | `.codex/agents/*.toml` | `name`, `description`, `developer_instructions` (agent md body), tier-mapped `model`, `sandbox_mode: "read-only"` for read-only agents |
| Rules | `AGENTS.md` section | Rules plus spawn protocol ("spawn N agents named X… wait for all results before continuing") |
| Skills | `.agents/skills/*/SKILL.md` | Codex reads this natively |
| Hooks | none | Guard behaviors folded into AGENTS.md instructions + skill checklists |

**Execution:** `/gk:execute` skill drives waves by instructing Codex to spawn named custom agents per node; wave barrier = explicit wait-for-all instruction. Weaker guarantee than task-tool hosts — documented limitation in README and skill text.

### kits/pi/

| Piece | Location | Notes |
|---|---|---|
| Extension | `.pi/extensions/gk-subagent.ts` | Registers `gk_dispatch_agent` tool: spawns headless `pi -p` child processes with tool restrictions derived from node constraints, captures output, enforces budgets. This is the subagent runtime. |
| Agents | `.pi/agents/*.md` | Prompt fragments loaded by the extension at dispatch time |
| Skills | `.pi/skills/*/SKILL.md` | Agent Skills standard |
| Hooks | extension event handlers | `tool_call` pre-hook guards ported |
| Entry | `.pi/prompts/gk.md` | `/gk` prompt template |

**Execution:** `/skill:gk-execute` drives waves through `gk_dispatch_agent`.

All hosts: viewer, memory, and CBM commands work identically — they are pure CLI.

## 3. Model tiers

Abstract tiers stay canonical in graph.yaml (`opus`, `sonnet`, `haiku`, `fable`). Per-target mapping via descriptor defaults; per-project overrides in `.gk.json`:

```json
{
  "targets": {
    "codex": { "models": { "opus": "gpt-5.4", "sonnet": "gpt-5.3-codex-spark" } }
  }
}
```

Resolution order: `.gk.json` override → descriptor default → `"Auto"` / host default (same pattern as existing Cursor overrides).

Default mappings:

| Tier | opencode | codex | pi |
|---|---|---|---|
| opus | `anthropic/claude-opus-4.5` | `gpt-5.4` (+ high effort) | provider config (`models.json`) |
| sonnet | `anthropic/claude-sonnet-4.5` | `gpt-5.3-codex-spark` | provider config |
| haiku / fable | host Auto/default | host default | provider config |

## 4. CLI surface

- `gk init --target opencode|codex|pi` added; default remains `claude`; claude/cursor behavior unchanged.
- `gk new --dir X --target <id>` likewise.
- `gk inventory` reports per-target installed agents/skills/hooks/commands via descriptor.
- Validation unchanged — graph.yaml schema is identical across targets; only emission differs. Compiler emits waves JSON target-agnostic; the `/gk:execute` skill text is the only target-specific artifact.

## 5. Error handling

- Unknown `--target`: exit 1, list valid targets.
- Missing kit dir at init: fail loudly (existing behavior preserved).
- Pi dispatch failure (pi binary not on PATH): `gk_dispatch_agent` returns structured error to the parent turn; execute skill surfaces it and stops before next wave.

## 6. Testing

- Unit: descriptor registry — paths, formats, tier resolution including `.gk.json` overrides.
- Init integration per new target: temp dir → `init --target X` → assert file tree; parse frontmatter/TOML; assert skill discovery paths.
- Emitter tests: agent markdown → Codex TOML conversion; model tier mapping.
- Pi extension: typecheck + unit tests of dispatch argument-building and budget logic (no live pi run in CI).
- Existing 364 tests stay green; `ci:local` unchanged structurally.

## Out of scope

- `/gk:run` Workflow-tool path beyond Claude Code (no equivalent in the three hosts).
- Publishing a pi package to npm (kit installs project-locally via `gk init`).
- Changes to graph.yaml schema, topologies, viewer, memory, CBM bridge.
