---
name: gk:init-graph
description: Generate a graph.yaml file from a graph topology template. Use when the user wants to create a new graph engineering workflow, start a graph-based task, or initialize graph-kit for a project.
when_to_use: User wants to create a graph, set up a graph workflow, initialize graphkit, or start a new graph engineering task. Trigger: "create a graph", "new graph", "init graph", "set up workflow".
user-invocable: true
disable-model-invocation: false
---

# gk init-graph

## Purpose
Generate a valid `graph.yaml` in the project root from one of the 7 canonical topology templates.

## Process

1. **Pick a topology.** If the user specified one (e.g. `--template diamond`), use it. Otherwise, pick based on the task description:
   - "audit", "review", "research", "migrate" → **diamond**
   - "triage", "route", "categorize" → **classify-and-act**
   - "verify", "fact-check", "security" → **adversarial-verification**
   - "discover", "sweep", "find all" → **loop-until-done**
   - "brainstorm", "ideas", "naming" → **generate-and-filter**
   - "rank", "compare", "best of" → **tournament**
   - "long-running", "remember", "cross-run" → **memory-augmented**

2. **Scaffold a valid graph.yaml** by running the CLI — it emits a schema-correct template:

   ```bash
   gk graph new diamond > graph.yaml
   ```

   Replace `diamond` with the chosen topology. The CLI guarantees the YAML is valid against the schema — do NOT hand-write graph.yaml, always start from the CLI scaffold.

3. **Customize the scaffold.** Edit graph.yaml to fit the task:
   - Change `metadata.name` and `description`
   - Replace each node's `objective` with the task-specific prompt
   - Change `agent` values to match files in `.claude/agents/` (use kebab-case: `software-architect`, `code-reviewer`, `qa-engineer`, `data-engineer`, `ui-ux-researcher`, `agents-orchestrator`, `document-generator`, `memory-curator`)
   - Add `refs`, `loop`, `constraints`, or more nodes as needed

4. **Validate** to confirm the customization is correct:

   ```bash
   gk validate graph.yaml --json
   ```

   Fix any findings, then suggest `/gk:visualize` to see it.

## Output
Writes `graph.yaml` to project root. Does not overwrite existing files — if graph.yaml already exists, read it first and ask the user if they want to regenerate.

## Available topologies
Run `gk graph list` to see all 7. Run `gk graph inspect <topology>` to see its config keys.
