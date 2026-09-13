# GraphKit examples

Runnable starting points that work as shipped — no CBM bridge, no MCP server,
no API keys. gk is zero-model: it validates, compiles, plans, and keeps the
ledger; the *agents* do the work.

## review-diamond.yaml

A diamond review of a change: one scouter fans out review angles, a reviewer
works them, a synthesizer merges a verdict. Validates as shipped.

```sh
gk validate examples/review-diamond.yaml   # ok (topology diamond)
gk graph ascii examples/review-diamond.yaml  # instant in-terminal preview
gk run plan --graph examples/review-diamond.yaml  # waves, tiers, worst-case dispatches
```

Then execute it from your agent session (`/gk:execute`), or drive the ledger
by hand to see the run machinery:

```sh
gk run start --graph examples/review-diamond.yaml
gk run node scouter --status ok --wave 0 --evidence work_items
gk run node reviewer --status ok --wave 1 --evidence findings
gk run node synthesizer --status ok --wave 2 --evidence report
gk run end --status merged
gk run list                # the run you just recorded
```

Note `evidence.required_keys: [report]` — a `gk gate` on this graph BLOCKs
until `.graphkit/evidence/report.md` exists (write one with
`gk evidence add <file> --key report`). That is the point: gates are the
deterministic merge decision.

## Why this is the only example

The other starting points are the bundled templates: `gk template list`
(one per topology, mostly) and `gk template materialize <name> --params
'{"task":"..."}' --use`. `gk new --dir my-project --topology diamond` writes a
starter `graph.yaml` alongside the kit.
