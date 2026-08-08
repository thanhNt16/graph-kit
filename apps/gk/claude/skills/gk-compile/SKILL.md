---
name: gk compile
description: Parse graph.yaml, resolve topology config, and emit a self-contained .workflow.js file. Use after gk:validate passes. Trigger: "compile graph", "build workflow", "gk compile".
when_to_use: A validated graph.yaml exists and the user wants to compile it into a .workflow.js for Claude Code Workflows execution.
user-invocable: true
disable-model-invocation: false
---

# gk compile

## Purpose

Compile a validated graph.yaml into a self-contained `.workflow.js` script that Claude Code's Workflow tool can execute.

## Process

1. Read `graph.yaml` from the project root.
2. Parse YAML into the Graph schema (`GraphSchema.parse`).
3. Run `validateGraph(graph, projectRoot)` from `src/compiler/validate.ts` — if any findings, STOP and report them. Do not compile with errors.
4. Run `resolveTopologyConfig(graph.topology, graph.topology_config, templatesDir)` to resolve subgraph references.
5. Run `compileGraph(graph, templatesDir)` to emit the `.workflow.js` string.
6. Write to `.claude/workflows/{metadata.name}.workflow.js`.
7. Report success with the output path.

## Output

Writes a single self-contained `.workflow.js` file containing:
- `export const meta` — graph name and description
- Inlined topology template function definitions (root + any subgraph templates, deduped)
- `export default createXWorkflow(graphConfig)` — the entry point

Zero imports from the kit. The file is fully self-contained.
