---
name: gk validate
description: Gate-check a graph.yaml before compilation. Runs 9 validation checks: syntax, schema, topology, agent binding, refs, acyclic deps, evidence keys, loop exits, constraints. Trigger: "validate graph", "check graph", "gk validate".
when_to_use: User wants to validate a graph.yaml file before compiling or running it.
user-invocable: true
disable-model-invocation: false
---

# gk validate

## Purpose
Gate-check a graph.yaml before compilation. Fails fast on first error.

## Checks (in order)

1. **Syntax**: YAML parses without error
2. **Schema**: Conforms to graph.schema.ts (zod validation)
3. **Topology**: Topology name is one of 6 canonical names
4. **Agent binding**: Every node's `agent` matches a file in `claude/agents/`
5. **Refs exist**: Every file in `refs[].path` exists on disk
6. **Acyclic deps**: `depend_on` forms a DAG (no cycles)
7. **Evidence keys**: Terminal nodes produce all `evidence.required_keys`
8. **Loop exits**: Nodes with `loop.enabled: true` have `stop_when` or `exit_condition`
9. **Constraints**: Constraint keys are known types

## Process

1. Read `graph.yaml` from project root.
2. Parse YAML (check 1: syntax).
3. Validate against `GraphSchema` from `src/schemas/graph.schema.ts` (checks 2-3, 6: schema, topology, acyclic deps are enforced by zod superRefine).
4. Run structural checks from `src/compiler/validate.ts` (checks 4-5, 7-9: agent binding, refs, evidence, loops).
5. Report results.

## Output

- **PASS**: "Graph validated successfully. Ready for compile."
- **FAIL**: List each finding with check name, path, and fix suggestion.
