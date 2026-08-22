---
name: gk-validate
description: Gate-check a graph.yaml before compilation. Runs 9 validation checks: syntax, schema, topology, agent binding, refs, acyclic deps, evidence keys, loop exits, constraints. Trigger: "validate graph", "check graph", "gk validate".
when_to_use: User wants to validate a graph.yaml file before compiling or running it.
user-invocable: true
disable-model-invocation: false
---

# gk validate

## Purpose
Gate-check a graph.yaml before compilation. Fails fast on first error.

## Process

Run the `gk` CLI to validate — it performs all checks internally:

```bash
gk validate graph.yaml --json
```

The CLI runs 9 checks: YAML syntax, schema conformance (zod), topology name, agent binding (files in `.opencode/agent/`), refs exist on disk, acyclic depend_on, evidence key coverage, loop exit conditions, constraint types.

If the command is not found, the kit is not installed. Tell the user to install `gk` from the GitHub release tarball (see the README's Install section) and then run `gk init`.

## Output

- **PASS** (`status: "ok"`): "Graph validated successfully. Ready for compile."
- **FAIL** (`status: "fail"`): Parse the `error.details.findings` array. Each finding has `check`, `path`, `message`. Report each to the user with a fix suggestion.

## What to do on failure

Read the findings, explain each in plain language, and suggest the fix. For example:
- `agent-binding`: "Agent 'X' not found. Change to a name matching a file in .opencode/agent/ (e.g. software-architect)."
- `refs-exist`: "Ref path 'docs/foo.md' doesn't exist. Create it or remove the ref."
- `cycle`: "depend_on has a cycle: a→b→a. Break the loop."
- `loop-exit`: "Loop enabled but no stop_when or exit_condition. Add one."
