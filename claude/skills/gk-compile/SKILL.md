---
name: gk:compile
description: Compile graph.yaml into a self-contained .workflow.js file for Claude Code Workflows. Use after gk:validate passes. Trigger: "compile graph", "build workflow", "gk compile".
when_to_use: A validated graph.yaml exists and the user wants to compile it into a .workflow.js for Claude Code Workflows execution.
user-invocable: true
disable-model-invocation: false
---

# gk compile

## Purpose

Compile a validated graph.yaml into a self-contained `.workflow.js` script that Claude Code's Workflow tool can execute.

## Process

Run the `gk` CLI to compile — it validates, resolves subgraphs, and emits the script:

```bash
gk compile graph.yaml --json
```

The CLI does all of the following internally:
1. Parses the YAML
2. Validates against the schema (if it fails, the error tells you exactly what to fix — run `/gk:validate` first)
3. Resolves subgraph template references (e.g. `topology_config.verify.template: adversarial-verification`)
4. Inlines root + subgraph topology templates
5. Writes `.claude/workflows/{metadata.name}.workflow.js`

If the command is not found, the kit is not installed. Tell the user to run `gk init` or install via npm: `npm install -g @graphkit/gk`.

## Output

- **Success** (`status: "ok"`): The `data.compiled` field has the output path. Report it to the user.
- **Failure** (`status: "fail"`): The error details contain validation findings. Fix the graph.yaml and re-run.

## Compiled file contract

The emitted `.workflow.js` is fully self-contained (zero kit imports):
- `export const meta` — graph name and description
- Inlined `createXWorkflow(config)` function definitions (root + any subgraph templates)
- `export default createXWorkflow(graphConfig)` — the entry point

It can be executed via Claude Code's Workflow tool: `Workflow({ scriptPath: ".claude/workflows/{name}.workflow.js" })`.
