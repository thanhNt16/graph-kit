---
description: Execute a graph.yaml by dispatching subagents wave by wave via the Task tool.
agent: general
---
Read and follow the full instructions in .opencode/skill/gk-execute/SKILL.md. Arguments: $ARGUMENTS

## Evidence gate

Before reporting completion, write one non-whitespace file per declared evidence key:
`<graph.outputs.evidence_dir>/<key>.md`

After all producer waves finish, run:

```bash
gk gate graph.yaml
```

The gate maps each required key `k` to `<evidence_dir>/<k>.md`. Missing or whitespace-only files produce `BLOCK` and exit 1; repair or redispatch only the producer for each missing/empty key, then rerun the gate. Only `MERGE` with exit 0 permits completion. The compiled workflow does not invoke the gate automatically.
