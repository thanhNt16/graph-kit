# Graph Runtime Design: Session Graph Store, Loop Groups, Template Materialization

**Date:** 2026-08-26
**Status:** Approved design, pending implementation plan
**Scope:** Three interlocking features for graph-kit v0.2.x+: session-based graph storage, multi-node loop groups (hybrid stop), and template materialization with a built-in gallery.

## 1. Motivation

Today a project keeps one mutable `graph.yaml` at the repo root. Each new task overwrites it: run history is lost, reproducibility is manual, and `gk init-graph` needs an overwrite guard that interrupts flow. Loops exist only per-node (`node.loop`), so iterative work like implement → test → fix cannot express a two-node round trip without restructuring the DAG. Templates can be packed (`gk template pack`) but materializing them back into a graph is a manual copy-edit-substitute exercise.

This design:

1. Makes graphs immutable session artifacts under `.graphkit/graphs/` with an active pointer — the overwrite guard becomes unreachable by construction.
2. Adds **loop groups**: flat, DAG-preserving repeat-until-done spans over contiguous waves, with a hybrid stop condition (machine gate first, LLM judgment fallback).
3. Adds `gk template materialize` plus a shipped gallery of 4–6 built-in templates.

All three land in one release; schema changes are additive, so existing graphs stay valid.

## 2. Non-Goals

- No nested subgraphs inside nodes.
- No cycles in `depend_on`; no SCC detection or back-edges.
- No automatic migration of root `graph.yaml` — it continues to work via explicit path.
- No resume/ledger features here (`gk run --resume` remains a separate roadmap item).
- No cost estimation or linting (separate roadmap candidates).

## 3. Feature 1 — Session Graph Store

### 3.1 Layout

```
.graphkit/
  graphs/
    2026-08-26-project-research.yaml   # immutable after write
    2026-08-27-audit-pr.yaml
  active                # single line: id of current session graph
  runs/<run-id>/graph.yaml   # execution snapshot written by gk execute
```

**Session id format:** `YYYY-MM-DD-<slug>` where slug is derived from metadata name/task (kebab-case, ≤40 chars). Collision within same date appends `-2`, `-3`, …

### 3.2 Write path

Both `gk init-graph` and `gk template materialize` always create a **new** timestamped file and then flip `.graphkit/active`. Neither ever rewrites an existing session graph. The interactive overwrite guard ("refuse to replace existing graph.yaml") is retained only for explicit-path writes.

### 3.3 Read path

| Invocation | Resolution |
|---|---|
| `gk execute` (no path arg) | read `.graphkit/active` → load that graph |
| `gk execute ./any.yaml` | explicit path, unchanged behavior |
| `gk validate` (no path) | active graph |
| any command before `gk init` | error: "No .graphkit/ — run gk init" |

Dangling pointer (active names missing file): hard error listing available ids from `.graphkit/graphs/`.

### 3.4 New commands

```
gk graph list               # table: id | task line | created | last-run
gk graph switch <id>        # flip active pointer
gk graph show <id>          # print graph yaml
gk graph history <id>       # joined runs ledger view (existing runs data)
```

Root `graph.yaml`: untouched by gk going forward; reading it via explicit path still works. No migration step ships in this release.

## 4. Feature 2 — Loop Groups (Hybrid Stop)

### 4.1 Schema

```yaml
loops:
  - nodes: [implement, test]      # required; contiguous wave span
    max_rounds: 5                 # required; ≥1 hard cap
    stop_when: "all tests pass"   # LLM-judged text (required unless gate_evidence)
    gate_evidence: [test-report]  # optional machine gate; evidence keys of loop nodes
```

Top-level `loops:` array on the graph document. Per-node `node.loop` stays supported unchanged.

### 4.2 Validation rules (added to `src/compiler/validate.ts`)

1. Every `nodes[i]` exists in the graph.
2. The span is **wave-contiguous**: if computed as waves W_a..W_b, every dependency of every loop node is either inside the span or strictly upstream of W_a. A node whose dep sits below the span is invalid.
3. Loops never overlap each other's node sets.
4. `max_rounds` present and ≥ 1.
5. At least one of `stop_when` / `gate_evidence` present.
6. Every `gate_evidence` key must be declared as an evidence key on some node inside the span.

Invalid cases produce named findings like the existing validator output (`--json` compatible).

### 4.3 Execution semantics (orchestrator contract, gk-execute skill)

Waves are computed once from the DAG. The executor walks waves; when it reaches the head wave of a loop group it enters the loop:

1. Run rounds = one pass over the span's waves, dispatching normally.
2. After a round:
   - If `gate_evidence` set and all listed `<evidence_dir>/<key>.md` files exist and are non-whitespace → **stop: success**. Gate check is deterministic shell-testable.
   - Else if `stop_when` present → orchestrator judges the previous round's node outputs against the text using its own reasoning (same LLM-read pattern as curator `INJECTION:` parsing). Satisfied → stop: success.
   - Else dispatch next round; round N outputs feed round N+1 node contexts.
3. Evidence files: latest round wins (overwrite in place).
4. `max_rounds` exhausted without satisfaction → loop fails; per graph-stop rule the whole run stops, report records rounds executed + last-round outputs + which condition was being checked.
5. Loop bookkeeping lands in the run report: rounds completed, stop reason (`gate` / `judged` / `exhausted`).

### 4.4 Visualizer

Draw a brace/bracket around the span labelled `loop ×N` with live round counter when rendering mid-run reports. Static SVG/ASCII both annotate the span; no graph-theory layout change.

## 5. Feature 3 — Template Materialization & Gallery

### 5.1 Command

```bash
gk template materialize <name> [--params '{"task":"..."}'] [--use]
```

- Resolution order: project-local `.graphkit/templates/<name>.gk.yaml` → user-global `~/.graphkit/templates/<name>.gk.yaml` → bundled gallery.
- Substitutes `{{param}}` placeholders exactly per the existing parameter contract (embedded placeholders resolve to text; sole-placeholder values may take scalar type).
- Validates the substituted result (`gk validate` pipeline).
- Writes `.graphkit/graphs/<ts>-<name>.yaml`, flips active pointer when `--use` passed (default: yes, matching init-graph behavior).
- Errors before any write: unknown template, undeclared placeholder used, required param missing (error names them), type mismatch.

### 5.2 Gallery

Bundled GraphTemplate v1 files installed with the kit into the templates search path:

| Name | Topology | Purpose |
|---|---|---|
| `audit-pr` | diamond | adversarial audit of a diff/PR |
| `refactor-module` | custom | scoped refactor w/ verify loop |
| `bench-eval` | tournament | model-tier comparison sweep |
| `doc-sweep` | loop-until-done | coverage-driven docs pass |

(Exact roster may shift ±2 during implementation; each ships with parameters for task/scope inputs.)

`gk template list` gains a `source` column: `project` | `global` | `builtin`.

### 5.3 init-graph integration

`init-graph --template <name>` resolution extends through the same three-level chain. Skill doc updated to mention gallery candidates during routing.

## 6. Error Handling Summary

| Case | Behavior |
|---|---|
| Dangling active pointer | error + list available ids |
| Missing `.graphkit/` | error pointing at `gk init` |
| Loop: non-contiguous span | validation finding naming the offending dep edge |
| Loop: overlapping groups | validation finding |
| Loop: exhausted max_rounds | run stops as failure; report carries rounds + last outputs |
| Materialize: param errors | error names params; nothing written |
| Materialize: unknown template | error lists nearest matches |

## 7. Testing Plan

Unit tests alongside existing `tests/unit/` conventions:

- **Store:** create/list/switch/dangling-pointer/init-missing; id collision suffixing.
- **Loops validation:** all six rules above, incl. happy path + each named failure.
- **Loops execution:** simulated orchestrator — gate satisfied early stops before max_rounds; judged stop works; exhaustion produces failure record.
- **Materialize:** substitution types, required-param errors, resolution precedence, gallery listing.

`ci:local` extended only where command surface changed (changelog check already wired).

## 8. Release

Single release covering all three (schema additive ⇒ old graphs valid). Requires per v0.2.23 policy: CHANGELOG entry, README/docs updates (new commands + loops schema section), docs page mention. Runs of old graphs are unaffected.

## 9. Open Items Resolved During Design

- Stop-condition evaluator: **hybrid** (user decision).
- Storage entrypoint: **active-pointer file**, not symlink (user decision).
- Loop mechanism: **flat loop-group directive** over subgraph nesting/back-edge SCCs, because gk has no compile step — the orchestrator executes graph.yaml interpretively, making runtime wave-span repetition natural.
