# Archify IR Authoring Reference

How to turn a graph.yaml into an archify JSON IR. Edit the worked example below — never compose from a blank file.

## Mapping rules

| graph.yaml | archify IR |
|---|---|
| wave index from `gk graph waves` | `col` (do not recompute) |
| model tier (`opus`/`sonnet`/`haiku`/`fable`) | `lane` (one lane per tier present) |
| node id | node `label` |
| `agent` | `sublabel` |
| model tier | `tag` |
| `depend_on` entries | edges (`variant: "default"`) |
| `evidence` keys | dashed edges into the producing node (`variant: "dashed"`) |
| `loop:` node | `lifecycle` diagram type: failure state + transition back to active |
| subgraph / composed template | `groups[]` boundary (`variant: "dashed"`) |
| memory-augmented topology | `architecture` diagram type: curator + store as components |

## Type router

| Signal | diagram_type |
|---|---|
| any node has `loop:` | `lifecycle` |
| topology `memory-augmented` or subgraphs present | `architecture` |
| otherwise | `workflow` |

## Tier palette

Reuse `graph-palette.md`: opus purple `#6e40c9`, sonnet blue `#58a6ff`, haiku green `#3fb950`, fable amber `#d97706`. Archify lanes carry their own styling; set lane labels to the tier name and keep tier order stable: opus, sonnet, haiku, fable.

## Meta defaults

- Set `meta.quality_profile: "showcase"`.
- Omit `visual_preset`, `subtitle`, `legend`, `engineering_profile` (defaults win).
- `meta.views`: at most 5, only when the graph has real sub-stories (e.g. the verification path, the fan-in). Plain diamonds get zero views.
- `meta.animation`: `"trace"` only when the user asks for a guided walkthrough.

## Component types

`frontend, backend, database, cloud, security, messagebus, external`. Agent nodes are `backend`; external tools/services are `external`; approval/verification gates are `security`; memory/store nodes are `database`.

## Worked example

Source: `tests/fixtures/diamond-with-verification.yaml` (topology `diamond`, nodes scouter→worker→synthesizer with an adversarial-verification subgraph). `gk graph waves` yields wave 0 = `scouter`, wave 1 = `worker`, wave 2 = `synthesizer`.

```json
{
  "schema_version": 1,
  "diagram_type": "workflow",
  "meta": {
    "title": "audited-review",
    "quality_profile": "showcase",
    "output": ".graphkit/diagrams/audited-review.html"
  },
  "lanes": [
    { "id": "opus", "label": "opus" },
    { "id": "sonnet", "label": "sonnet" }
  ],
  "phases": [
    { "id": "scout", "label": "Scout", "fromCol": 0, "toCol": 0 },
    { "id": "review", "label": "Review", "fromCol": 1, "toCol": 1 },
    { "id": "synthesize", "label": "Synthesize", "fromCol": 2, "toCol": 2 }
  ],
  "groups": [
    { "id": "verify", "label": "adversarial-verification", "lane": "sonnet", "fromCol": 1, "toCol": 2, "variant": "dashed" }
  ],
  "mainPath": ["scouter", "worker", "synthesizer"],
  "nodes": [
    { "id": "scouter", "lane": "opus", "col": 0, "type": "backend", "label": "scouter", "sublabel": "Software Architect", "tag": "opus" },
    { "id": "worker", "lane": "sonnet", "col": 1, "type": "backend", "label": "worker", "sublabel": "Code Reviewer", "tag": "sonnet" },
    { "id": "synthesizer", "lane": "opus", "col": 2, "type": "backend", "label": "synthesizer", "sublabel": "Software Architect", "tag": "opus" }
  ],
  "edges": [
    { "id": "scouter-worker", "from": "scouter", "to": "worker", "variant": "default" },
    { "id": "worker-synthesizer", "from": "worker", "to": "synthesizer", "variant": "default" }
  ],
  "cards": [
    {
      "dot": "cyan",
      "title": "Graph Facts",
      "items": [
        "Diamond topology — fan-out then fan-in",
        "Findings verified by adversarial refuters before acceptance",
        "Evidence keys: file_list, findings, report"
      ]
    }
  ]
}
```

Notes on the example:
- One lane per model tier present, in tier order — `worker` sits in the sonnet lane, scouter/synthesizer in opus. Column = wave index, so the diamond reads left→right even though lanes differ.
- The `verify` group marks the composed `adversarial-verification` template without inventing nodes archify cannot place.
- `cards` summarize what the diagram cannot show (evidence keys, refuters). 1–3 cards, 3–4 items each.
- Adjust `meta.viewBox` only if `deliver` reports containment problems; prefer letting validate guide you.
