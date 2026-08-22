---
name: gk-evidence
description: Produce a markdown evidence report from a completed graph run. Use after gk:run finishes. Trigger: "show evidence", "graph results", "what did the graph produce", "evidence report".
when_to_use: A graph run has completed (or partially completed) and the user wants the collected evidence.
user-invocable: true
disable-model-invocation: false
---

# gk evidence

## Process

1. Read `graph.yaml` → `metadata.name`, `evidence.required_keys`, `nodes` (each node's declared `evidence` keys).
2. Read `.graphkit/evidence/.index` (written by .opencode/plugin/gk.ts) to enumerate which evidence files landed. Fall back to scanning `.graphkit/evidence/**/*.md` if no index.
3. For each node declared in graph.yaml, find its evidence files and extract:
   - The node id, agent name, model tier
   - Each declared evidence key and its value (summary first line + full content)
   - Whether the node completed (evidence file exists) or is pending/missing
4. Check coverage: are all `evidence.required_keys` present? Flag gaps explicitly.
5. Compose a single markdown report:
   - Header: graph name, topology, run timestamp (from .graphkit/runs/current.json)
   - Per-node section with evidence
   - Coverage table: required key × producing node × status
   - Verdict line (passed if all required keys present, else partial/failed)
6. Write to `.graphkit/reports/{name}.md` (path from graph.yaml `outputs.report`, `{name}` substituted).

## Output

One markdown file. Does not invoke agents — pure aggregation and formatting.
