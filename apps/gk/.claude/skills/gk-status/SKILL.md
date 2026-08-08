---
name: gk status
description: Show the current state of a graph run. Use when the user wants a quick check on what's running or completed. Trigger: "graph status", "what's running", "graph state".
when_to_use: User wants to know the state of the current or most recent graph run.
user-invocable: true
disable-model-invocation: true
---

# gk status

## Process

1. If `.graphkit/runs/.active` exists: report "RUNNING" + the `current.json` name + which nodes have evidence files (completed) vs which don't (pending). Read `.graphkit/evidence/.index` if present.
2. If not running but `.graphkit/runs/{name}-result.json` exists: report the last run's verdict + timestamp.
3. If neither: report "No graph run found. Create one with /gk:init-graph."
4. Output is terminal-friendly: one line per node with ✓ completed / ○ pending / ✗ failed.

## Output

Stdout only. No files written. No agents invoked.
