---
name: gk-status
description: "Show the current state of a graph run. Use when the user wants a quick check on what's running or completed. Trigger: \"graph status\", \"what's running\", \"graph state\"."
disable-model-invocation: true
---
# gk status

## Process

1. Run `gk status` (add `--json` to parse it). It reads the ledger — not agent-authored sidecars — and reports: active run id, graph, round, node/evidence progress, advisor events, verdict chain, and evidence-gate coverage for the run's graph. For a specific (ended or interrupted) run: `gk status <run-id>`.
2. No active run? `gk run list` shows every run — ended, running, interrupted — newest first; report the most recent and whether it can be resumed (`gk run resume <id> --dry-run` previews).
3. Only if the CLI is unavailable: fall back to reading `.graphkit/runs/` directly (`.active` pointer, `meta.json`, `trace.jsonl`), and say `source: fallback-scan`.
4. Output is terminal-friendly: one line per node with ✓ completed / ○ pending / ✗ failed.

## Output

Stdout only. No files written. No agents invoked. Runs are created by `gk run start` (the `/gk:execute` skill drives it) — not by `/gk:init-graph`, which authors graphs.
