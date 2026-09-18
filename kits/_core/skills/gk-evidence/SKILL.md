---
name: gk-evidence
description: Produce a markdown evidence report from a completed graph run. Use after gk:execute finishes. Trigger: "show evidence", "graph results", "what did the graph produce", "evidence report".
disable-model-invocation: false
---

# gk evidence

## Process

1. Read `graph.yaml` → `metadata.name`, `evidence.required_keys`, `nodes` (each node's declared `evidence` keys).
2. Run `gk evidence report --json` — the enumeration and provenance source (the `.index` written by evidence-persist.cjs feeds it; do not scan evidence files by hand). Each view carries: `id`, `description` (from `criteria/<id>.md`), `kind`, `status` (`present`/`missing`), `freshness` (`fresh`/`stale`/`unknown`), `artifact`, `provenance` (run, node, fingerprint head, ts).
3. For each view: report the criterion id, its description, status badge, artifact path, and provenance line. Surface `stale`/`unknown` freshness explicitly — stale means the repo changed after the artifact was recorded.
4. Check coverage: are all `evidence.required_keys` present? Flag gaps explicitly.
5. Compose a single markdown report:
   - Header: graph name, topology, run timestamp (from .graphkit/runs/current.json)
   - Per-criterion section with evidence (description, badge, artifact, provenance)
   - Coverage table: required key × producing node × status × freshness
   - Verdict line (passed if all required keys present, else partial/failed)
6. Write to `.graphkit/reports/{name}.md` (path from graph.yaml `outputs.report`, `{name}` substituted).

## Output

One markdown file. Does not invoke agents — pure aggregation and formatting.
