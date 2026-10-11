# Holdout scenarios (sealed criteria)

A **holdout** is a validation criterion the builder agents never see — a rubric,
hidden test list, or grading script stored outside the builders' reach and read
only by `role: eval-gate` nodes.

## Why

In-repo validation gets gamed. If the worker that writes the code can also read
the rubric that grades it, "return true passes the test" is the cheapest passing
answer. Factories that learned this the hard way (StrongDM's, Dark Factory) moved
their grading criteria *out of the builder's context*: evaluators check work
against holdout scenarios the builders never saw.

GraphKit implements this as a compile-time seal:

- **Declaration** — two equivalent forms:
  - Filename convention: `criteria/<id>.holdout.md` instead of
    `criteria/<id>.md`. `evidence.criteria: [<id>]` resolves to the sealed twin
    when no public `criteria/<id>.md` exists.
  - Per-ref flag: `refs: [{ path: <any file>, holdout: true, purpose: ... }]`
    seals an arbitrary path (hidden test scripts, golden fixtures).
- **Compiler enforcement** — `gk validate` fails with `HOLDOUT_LEAK` when a node
  that is not `role: eval-gate` declares a `refs` entry pointing at a sealed
  path (`criteria/*.holdout.md`, or any ref flagged `holdout: true`). A node
  with `role` unset — or any other value — is a builder. Eval-gate nodes may
  reference holdouts freely.
- **Payload exclusion** — `planGraph` (the `gk graph waves` payload every
  dispatcher consumes) strips sealed refs from non-eval-gate node payloads, so
  materialized builder agents never enumerate the rubric even if the YAML
  author slips a ref through unchecked.
- **Dead-seal advisory** — a graph that declares holdouts but has zero
  `role: eval-gate` nodes gets a `holdout-dead-seal` warning: the sealed rubric
  is never evaluated.

## Example — adversarial verification with a sealed rubric

```yaml
apiVersion: graphkit.dev/v2
kind: Graph
metadata:
  name: sealed-diamond
topology: custom
inputs:
  task: { type: string, required: true }
nodes:
  builder:
    agent: implementer
    model: sonnet
    objective: Implement the task. Record what you built and why.
    depend_on: []
    evidence: [implementation, report]
    refs:
      - path: docs/brief.md          # public context — fine
        purpose: task brief
      # NOT allowed here: criteria/rubric.holdout.md → HOLDOUT_LEAK
  evaluator:
    agent: qa-engineer
    model: opus
    role: eval-gate
    objective: |
      Grade the implementation strictly against the sealed rubric.
      Score each rubric line PASS or FAIL with file:line evidence.
    eval:
      mode: work_product
      rubric: strict
    depend_on: [builder]
    evidence: [verdict]
    refs:
      - path: criteria/rubric.holdout.md   # sealed — eval-gate only
        purpose: grading rubric
evidence:
  required_keys: [verdict]
  criteria: [verdict]
```

`criteria/rubric.holdout.md` is an ordinary criterion file (same frontmatter:
`kind`, optional `id`; body = description) — its name alone seals it. The
builder's waves payload lists only `docs/brief.md`; the evaluator's payload
carries the rubric path.

## Operational notes

- The seal is authoring-time, not a sandbox: a sufficiently motivated builder
  agent could still `cat criteria/rubric.holdout.md` if it guesses the path.
  The seal guarantees the path is never *handed* to it — combine with
  `constraints: { no_exec: true }`-style tool narrowing on builders for a
  stronger boundary.
- The evidence report (`gk evidence report`) still renders holdout criteria
  descriptions for the human operator.
- `gk run resume` replays satisfied-node evidence as refs under
  `.graphkit/evidence/` — never criteria paths — so resume cannot
  accidentally unseal a rubric into a builder payload.
