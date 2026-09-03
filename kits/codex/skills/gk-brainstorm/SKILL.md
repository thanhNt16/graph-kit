---
name: gk-brainstorm
description: Refine an existing graph.yaml through interactive dialogue. Use when the user wants to improve their graph definition, adjust agent bindings, add loops or constraints, or explore what topology to use. Trigger: "refine graph", "improve workflow", "brainstorm graph", "adjust graph".
disable-model-invocation: false
---

# gk brainstorm

## Purpose
Interactively refine a graph.yaml file through conversation.

## Process

1. Read the existing `graph.yaml`.
   Run `gk suggest --json` and fold relevant suggestions into the proposal: recurring
   chains suggest sub-graphs, graph-reuse suggests starting from a template.
2. Run `gk validate graph.yaml --json` to check current state. If there are findings, surface them as the first thing to fix.
3. Ask focused questions, one at a time:
   - "Which agents should handle which nodes?" → suggest based on topology
   - "Should any nodes run at a different model tier?" → suggest based on task complexity
   - "Should any nodes have internal loops?" → suggest for research/discovery nodes
   - "Are there constraints needed?" → suggest based on task type
4. Update `graph.yaml` after each decision.
5. After all changes, run `gk validate graph.yaml --json` again to confirm it passes before suggesting `gk-execute`.

## Key Interactions
- Suggest model tiering: "The scouter does deep analysis — opus. The verifier just checks file:line refs — haiku. Save budget."
- Suggest loop config: "This scouter needs to research until it finds concrete evidence. Enable loop-until-done with 3 max rounds."
- Suggest constraints: "Workers should only touch their assigned files. Add `assigned_only: true`."
- Show topology config options available: run `gk graph inspect <topology>` to list valid config keys.
