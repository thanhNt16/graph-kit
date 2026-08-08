---
name: gk init-graph
description: Generate a graph.yaml file from a graph topology template. Use when the user wants to create a new graph engineering workflow, start a graph-based task, or initialize graph-kit for a project.
when_to_use: User wants to create a graph, set up a graph workflow, initialize graphkit, or start a new graph engineering task. Trigger: "create a graph", "new graph", "init graph", "set up workflow".
user-invocable: true
disable-model-invocation: false
---

# gk init-graph

## Purpose
Generate a graph.yaml file in the project root from one of the 6 canonical topology templates.

## Process

1. If `--template` argument provided, use that topology.
2. If no template, read the user's description and suggest a topology using the rules in `claude/rules/topology-routing.md`.
3. Ask for **inputs** — what data does the graph operate on? (repo path, code scope, documents, etc.)
4. Generate `graph.yaml` with:
   - Selected topology
   - Declared inputs with types and defaults
   - Default node bindings (based on topology: scouter → Software Architect, worker → Code Reviewer, etc.)
   - Reasonable defaults for limits and evidence
   - Empty `topology_config` with comments showing available keys
5. Tell the user the file was created and suggest `/gk:visualize` to see it.

## Template Defaults

| Topology | Default Nodes |
|----------|-------------|
| diamond | scouter, worker, verifier, synthesizer |
| classify-and-act | classifier, handler-1, handler-2, handler-3, fallback |
| adversarial-verification | producer, refuter-1, refuter-2, adjudicator |
| loop-until-done | scouter, worker-batch |
| generate-and-filter | generator-1, generator-2, generator-3 |
| tournament | candidate-1, candidate-2, candidate-3, judge |

## Output
Writes `graph.yaml` to project root. Does not overwrite existing files — fail if graph.yaml already exists with content.
