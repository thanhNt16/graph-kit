---
name: gk run
description: Execute a compiled graph workflow using Claude Code's Workflow tool. Use after gk:compile has produced a .workflow.js. Trigger: "run the graph", "execute workflow", "start the graph run".
when_to_use: A compiled .workflow.js exists and the user wants to execute the graph.
user-invocable: true
disable-model-invocation: false
---

# gk run

## Process

1. Read `graph.yaml` to get `metadata.name`.
2. Check for compiled workflow at `.claude/workflows/{name}.workflow.js`.
   - If missing: STOP. Tell the user to run `/gk:compile` first. Do not compile implicitly.
3. Write `.graphkit/runs/current.json` with the resolved node constraints (so the lease-enforce hook can inject them):
   ```json
   { "name": "<graph name>", "started_at": "<ISO>", "constraints": { "<nodeId>": { "assigned_only": true } } }
   ```
   Create `.graphkit/runs/.active` marker file (touched, empty).
4. Invoke Claude Code's Workflow tool with the script path: `Workflow({ scriptPath: ".claude/workflows/{name}.workflow.js" })`.
   - The workflow script is self-contained: it defines `meta` + a default export that takes the runtime `context` (which provides `agent()`, `parallel()`, `pipeline()`, and `inputs`).
5. When the Workflow tool returns, remove `.graphkit/runs/.active`.
6. Write the final result to `.graphkit/runs/{name}-result.json`.
7. Report to the user: verdict (passed/failed/partial), which nodes ran, and suggest `/gk:evidence`.

## Boundary

This skill drives the Workflow tool; it does not itself implement the graph topology. If the workflow fails, surface the failure — do not retry outside the graph's declared loop config.
