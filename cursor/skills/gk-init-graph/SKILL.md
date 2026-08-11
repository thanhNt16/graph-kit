---
name: gk-init-graph
description: Generate a graph.yaml file from a graph topology template or a packaged GraphTemplate. Use when the user wants to create a new graph engineering workflow, start a graph-based task, or initialize graph-kit for a project. Trigger: "create a graph", "new graph", "init graph", "set up workflow".
when_to_use: User wants to create a graph, set up a graph workflow, initialize graphkit, or start a new graph engineering task.
user-invocable: true
disable-model-invocation: false
---

# gk init-graph

## Purpose
Generate a valid `graph.yaml` in the project root, either from a **packaged GraphTemplate** (`--template <name>`) with user-approved capability suggestions, or from one of the canonical topology templates / flow presets. The CLI stays deterministic; this skill owns interpretation and recommendation.

Invocation:
```text
/gk:init-graph [--template <name>] [--task "<description>"]
```

## Guardrails
- **Recommend only installed capabilities.** Suggest bindings only for agents/skills/tools/MCP servers discovered by `gk inventory`. Absent recommended capabilities are marked `install required` and are never bound.
- **Model changes always require approval.** Never silently change a node model.
- **Never overwrite an existing graph.yaml without explicit approval.**
- **Graph authority preserved.** Templates materialize a graph; topology is never modified at runtime.

## Process

1. **Resolve the source.**
   - `--template <name>` names a packaged template: resolve project-local before global:
     ```bash
     gk template list
     gk template show <name>
     ```
   - `--template <name>` names a canonical topology or flow preset: retain existing `gk graph new <name>` behavior.
   - Without `--template`: compare the task to packaged template descriptions and the topology routing rules, then offer the best two candidates when ambiguous.

2. **Inventory installed capabilities** for the active target:
   ```bash
   gk inventory --target cursor --json
   ```
   Note the discovered agents, skills, tools, MCP servers, and their model tiers.

3. **Collect parameters.**
   - Infer values from `--task` where confidence is high.
   - Ask one focused question for each unresolved required parameter.
   - Show defaults and permit edits.

4. **Analyze graph gaps.** Compare each node's objective, role, and template recommendations against installed agents, skills, tools, MCP servers, and model tiers:
   - Suggest only concrete bindings supported by inventory.
   - Mark absent recommended capabilities as `install required`; do not bind them.
   - For model suggestions, consider the existing node model, agent frontmatter default, objective complexity and risk, fan-out cost, and whether the node performs final synthesis or adversarial verification. Show every model change for approval; never recommend an unavailable model enum (`opus`, `sonnet`, `haiku`, `fable`).

5. **Review changes.** Show proposed substitutions and capability/model changes per node. Let the user accept, edit, or reject changes.

6. **Materialize.** Substitute parameters and apply accepted changes to produce a standard graph document:
   ```bash
   gk graph new <topology> > graph.yaml   # canonical topology / flow preset
   ```
   Refuse an existing `graph.yaml` unless the user explicitly approves replacement.

7. **Verify.** Run:
   ```bash
   gk validate graph.yaml --json
   ```
   Fix only approved configuration errors, then suggest `/gk:visualize`.

## Output
Writes `graph.yaml` to project root. Refuses to overwrite an existing file without explicit approval. On validation success, suggests `/gk:visualize`.

## Topology routing (no packaged template)
- "audit", "review", "research", "migrate" → **diamond**
- "triage", "route", "categorize" → **classify-and-act**
- "verify", "fact-check", "security" → **adversarial-verification**
- "discover", "sweep", "find all" → **loop-until-done**
- "brainstorm", "ideas", "naming" → **generate-and-filter**
- "rank", "compare", "best of" → **tournament**
- "long-running", "remember", "cross-run" → **memory-augmented**
- "brainstorm", "plan", "execute", "test loop" → **sdd** or **superpowers** (flow presets)
- "research", "compare", "build" → **research-and-build** (flow preset)
- "custom", "freeform", "my own flow" → **custom**

## Available topologies
Run `gk graph list` to see all topologies (7 canonical + custom + 3 flow presets). Run `gk graph inspect <topology>` to see its config keys.

### Custom topology
Use `topology: custom` to define any graph shape. The `depend_on` field controls execution order — nodes with no pending deps run in parallel. Node-level loops are supported via `loop: { enabled: true }`.

### Flow presets
Pre-built DAGs using custom topology:
- **sdd** — Spec → Design → Develop → Review cycle
- **superpowers** — Brainstorm → Plan → Execute → Verify loop
- **research-and-build** — Research → Compare → Build pipeline
