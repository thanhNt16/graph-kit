# Scored gates

`gk gate` is binary by default: every `required_keys` entry must exist, be non-empty, and (under `freshness: strict`) be fresh, or the verdict is BLOCK. Binary is right for hard contracts — a missing test report should never merge.

Scored gates add a weighted rubric on top, for subjective quality bars where "all or nothing" gets gamed: some criteria matter more than others, and a strong result on the heavy criteria should carry a borderline one.

```yaml
evidence:
  required_keys: [design-doc]       # hard floor — still all-or-nothing
  verdict: scored
  threshold: 0.70                   # 0-1, required under scored
  freshness: strict                 # same semantics as binary
  criteria:
    - { id: design-doc, weight: 3 } # the design matters most
    - { id: test-report, weight: 2 }
    - { id: perf-note, weight: 1 }
    - changelog-entry               # bare id = weight 1
```

Each criterion is evaluated with the same rules as a required key — the evidence file `.graphkit/evidence/<id>.md` must exist and be non-empty (a superseded marker counts as missing), and under `freshness: strict` it must be `fresh`. A failing criterion contributes 0 to the numerator but keeps its weight in the denominator:

```
score = Σ(weight_i × passed_i) / Σ(weight_i)
verdict = score ≥ threshold AND every required_key passes
```

`gk gate` output adds `score`, `threshold`, `per_criterion` (id, weight, status, pass, contribution), and a `summary` line, e.g. `SCORE 0.75 >= 0.70 → MERGE`. Exit codes are unchanged: 0 merges, 1 blocks. `gk evidence report` and `--html` print the same score table.

Validation: `verdict: scored` requires `threshold` and at least one criterion; weights must be positive; a `threshold` (or weights) set under the binary default surfaces an advisory warning, not an error.

## When scored beats binary

- **Subjective rubrics** — "design quality" and "originality" weighted above "craft"; the heavy axes decide, the light ones grade.
- **Graceful degradation** — a nice-to-have artifact missing shouldn't block when the core deliverables pass.
- **Hard + soft mix** — keep the must-haves in `required_keys` (they stay binary) and put the weighted quality bar in `criteria`.

Keep binary when the contract is genuinely all-or-nothing — a scored gate with one criterion is just a noisier binary gate.
