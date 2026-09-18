---
name: gk-validate
description: Gate-check a graph.yaml before execution. Runs strict schema conformance (unknown or unsupported fields are parse errors) plus semantic checks: topology, agent binding, refs, acyclic deps, evidence keys, loop exits/spans, fan_out references, memory/eval config. Use when the user wants to validate a graph.yaml file before compiling or running it. Trigger: "validate graph", "check graph", "gk validate".
disable-model-invocation: false
---

# gk validate

## Purpose
Gate-check a graph.yaml before execution. Fails fast on first error.

## Process

Run the `gk` CLI to validate — it performs all checks internally:

```bash
gk validate graph.yaml --json
```

The schema pass is strict: unrecognized keys (e.g. `limits.max_workers`, `loop.exit_condition`), out-of-range values (e.g. `retry.max_attempts < 1`), and bad cross-references (`fan_out.briefs_from` naming a node that isn't an upstream `depend_on` ancestor) are rejected at parse time. The CLI then runs the semantic checks: topology name, agent binding (files in `.opencode/agent/`), refs exist on disk, acyclic depend_on, evidence key coverage, loop spans/exits, constraint types, memory/eval config.

If the command is not found, the kit is not installed. Tell the user to install `gk` from the GitHub release tarball (see the README's Install section) and then run `gk init`.

## Output

- **PASS** (`status: "ok"`): "Graph validated successfully. Ready for execute."
- **FAIL** (`status: "fail"`): Parse the `error.details.findings` array. Each finding has `check`, `path`, `message`. Report each to the user with a fix suggestion.

## What to do on failure

Read the findings, explain each in plain language, and suggest the fix. For example:
- `agent-binding`: "Agent 'X' not found. Change to a name matching a file in .opencode/agent/ (e.g. software-architect)."
- `refs-exist`: "Ref path 'docs/foo.md' doesn't exist. Create it or remove the ref."
- `cycle`: "depend_on has a cycle: a→b→a. Break the loop."
- `loop-exit`: "Loop enabled but no stop_when. Add a stop_when (or a loop-level gate_evidence)."
