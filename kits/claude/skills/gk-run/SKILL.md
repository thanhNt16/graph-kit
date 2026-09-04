---
name: gk:run
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
   Start the run ledger instead of a bare marker: `gk run start --json` — it creates the
   `.active` pointer AND the run directory the ledger owns. Keep writing `current.json`
   as before (the lease-enforce hook reads it).
4. Invoke Claude Code's Workflow tool with the script path: `Workflow({ scriptPath: ".claude/workflows/{name}.workflow.js" })`.
   - The workflow script is self-contained: it defines `meta` + a default export that takes the runtime `context` (which provides `agent()`, `parallel()`, `pipeline()`, and `inputs`).
5. When the Workflow tool returns: `gk run end --status merged|failed` (removes `.active`,
   appends to `index.jsonl`), then `gk memory consolidate --json`.
6. Write the final result to `.graphkit/runs/{name}-result.json`.
7. Report to the user: verdict (passed/failed/partial), which nodes ran, and suggest `/gk:evidence`.

## gk run resume

Resume a failed or interrupted run:

```bash
gk run resume <run-id>              # derive pending-only graph + start child run
gk run resume <run-id> --dry-run    # preview reconciliation, write nothing
gk run resume <run-id> --from-node <id>  # redo one node + its dependents
gk run resume <run-id> --force      # override the graph-drift guard
```

A node is **satisfied** only if its last trace line is `ok` and every recorded evidence key maps to a non-empty `<evidence_dir>/<key>.md`. Satisfied upstreams are skipped; their evidence is attached to pending nodes as `refs`. The derived graph is saved as `<date>-<name>-resume.yaml` and activated; the new run records `resumes: <parent>` (visible in `gk run status` as `resumes_chain`). Graph edits since the run started are refused with `RESUME_GRAPH_DRIFT` — commit the graph change and start a fresh run instead, or pass `--force` consciously.

## Boundary

This skill drives the Workflow tool; it does not itself implement the graph topology. If the workflow fails, surface the failure — do not retry outside the graph's declared loop config.
