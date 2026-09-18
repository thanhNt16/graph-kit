# GraphKit Memory Ledger, Pattern Compiler, and Dream Graph — Design

Date: 2026-09-03
Status: Approved (all sections, user sign-off 2026-09-03)
Scope decision: Option C — full loop (ledger + pattern compiler + dream graph)

## Problem

GraphKit ships cross-run memory (`.graphkit/memory/` OKF files, `gk memory recall|touch|trace`,
ACT-R decay, `memory-augmented` topology) but:

- No run ledger. `gk execute` is a `NOT_IMPLEMENTED` stub; README admits "last-run shows `-`
  until the runs ledger ships". Nothing remembers that a workflow ran, with what outcome.
- `HookRef` (`on_node_complete` / `on_fanout_dispatch` / `on_graph_complete`,
  `src/schemas/graph.schema.ts:65-69`) is schema-only — zero runtime consumer.
- The only memory-creation path is `kits/*/hooks/memory-persist.cjs` distilling evidence writes.
  Curation is intra-run only (curator `INJECTION:` line, never persisted).
- No pattern consolidation, no link graph, no suggestion engine. `recommendations:` in
  templates is hand-authored advisory metadata, never learned from runs.

## Principle

**The filesystem is truth; runs are the ledger; patterns are derived; dreams only propose.**

`gk` remains a pure compiler — no model invocation, no agent spawn, no API key (README identity).
Every new capability is either deterministic code over files (ledger, pattern compiler, suggest)
or a bundled graph an agent executes (dream). Raw episodic volume stays out of the recall corpus.

Source inspiration, mapped: GBrain (compiled-truth/timeline page layout, deterministic
entity-link extraction, dream cycle), Graphiti (supersede-not-overwrite — already in OKF schema),
Claude Code memory (hard-capped generated index), Letta (review-before-apply dreaming),
Sylph/Gorgias (propose-diff, human applies), Mem0 (small operation surface).

## 1. Data model

### Run ledger — `.graphkit/runs/` (episodic, raw)

- `index.jsonl` — append-only, one line per completed run:
  `{id, graph, graph_sha256, started_at, ended_at, status, node_count, failures, evidence_keys[]}`.
  The file `gk suggest` scans.
- `<run-id>/run.md` — human summary, GBrain style: compiled truth above (status/digest),
  append-only per-node timeline below.
- `<run-id>/trace.jsonl` — one line per node:
  `{at, node, wave, agent, model, status, evidence[], duration_ms, notes}`.
- `run-id = YYYYMMDD-HHMMSS-<graphname>`.
- `.active` — written by `gk run start`, removed by `gk run end`; activates the existing
  orphaned `graph-state-guard.cjs` PreToolUse hook. One live run at a time.

### Curated memory — `.graphkit/memory/` (semantic)

- Existing flat fact files: unchanged (distillations from `memory-persist.cjs`).
- `patterns/*.md` — `type: pattern`, `kind: node-sequence | evidence-cooccurrence |
  failure-recurrence | graph-reuse`, `runs: [...]`, `count`, `salience` (count × ACT-R decay),
  `signature` (sha1 of kind+payload, idempotency key).
- `suggestions/*.md` — `type: suggestion`, `action: materialize-template | capture-skill |
  review-failure`, `rationale`, `based_on: [pattern ids]`, `status: proposed|accepted|dismissed`.
- `.links.json` — derived, disposable: authored `[[wikilink]]` backlinks + entity-mention
  extraction (shared paths, evidence keys, graph names, node ids). Always rebuildable.
- `index.md` — generated map (currently reserved-unused): per-type counts, top patterns,
  recall pointer.

## 2. Run ledger + tracing — `gk run`

New subcommand family (`src/cli/commands/run.ts`, registered alongside memory commands):

- `gk run start --graph <path>` — allocate run dir, write `run.md` header + empty
  `trace.jsonl`, write `.active`. Print run dir. Error if `.active` exists.
- `gk run node <node-id> --status ok|fail [--wave N] [--agent X] [--model Y]
  [--evidence k1,k2] [--duration-ms N] [--notes ...]` — append trace line. Refuses
  (exit 1) without `.active`: orphan traces corrupt pattern statistics.
- `gk run end --status merged|blocked|failed` — digest from trace (node count, failures,
  evidence keys), append `index.jsonl`, finalize `run.md` timeline, remove `.active`.
  Print the index line.

All deterministic, all filesystem. `--json` variants for machine consumption.

## 3. HookRef wiring + gk-execute contract

- `gk graph waves` (`src/cli/commands/graph.ts`, waves subcommand) emits hook commands into
  the JSON payload: per-node `on_node_complete[]` after that node's dispatch resolves;
  `on_graph_complete[]` after the last wave. `on_fanout_dispatch` stays declared-but-unused
  (documented) — no consumer, YAGNI.
- `gk-execute` skill (all 5 kits) contract: `gk run start` before wave 1; per node:
  dispatch → `gk run node` → declared `on_node_complete` commands; after final wave:
  `gk run end` → `on_graph_complete` commands. Node `ok:false` records `--status fail`
  before stopping (AGENTS.md graph-authority stop rule).
- Host PostToolUse hooks (`evidence-persist.cjs`, `memory-persist.cjs`) unchanged.
- Backward compat: no `hooks:`, or skill skips `gk run` → behavior identical to today;
  consolidate reports zero runs.

## 4. Pattern compiler, links, suggest

### `gk memory consolidate`

Input: `runs/index.jsonl` + traces. Deterministic pass:

- `node-sequence` — node-id n-grams (length 2-4) across ≥3 runs
- `evidence-cooccurrence` — evidence-key pairs co-produced in ≥3 runs
- `failure-recurrence` — node+objective-signature with ≥2 `fail` traces
- `graph-reuse` — same `graph_sha256` run ≥3 times

Each pattern = idempotent `patterns/<sig8>.md` (rewrite in place, supersede by signature).
`salience = count × exp(-ageDays/14)` — reuses the ACT-R constant in `src/eval/forgetting.ts`.

Also: rebuild `.links.json`; regenerate `index.md`; prune suggestions whose `based_on`
patterns disappeared; emit new suggestions (`graph-reuse` → `materialize-template`;
high-count `node-sequence` → `capture-skill`; `failure-recurrence` → `review-failure`).

### `gk suggest`

Prints ranked suggestions + top patterns (salience desc); `--json`. Dismissal:
`gk suggest --dismiss <id>` — frontmatter flip to `dismissed`, file retained (audit trail).

### Recall expansion

`readMemories`/`recallTopK` (`src/eval/memory-recall.ts`): walk one subdir deeper; join
`.links.json` neighbors into the candidate set with a salience penalty (linked-but-not-
keyword-matched ranks below direct hits). `scripts/memory-recall-eval.ts` fixtures stay green.

## 5. Dream graph

`templates/gallery/dream.yaml` — GraphTemplate v1, params `focus`, `since`:

- `harvest` (agents-orchestrator, `constraints: [{no_write: true}]`): read `runs/`,
  `patterns/`, `suggestions/`; candidate list as evidence.
- `dream` (memory-curator): semantic consolidations — merge near-duplicate facts, extract
  decisions, propose connections — written ONLY as a unified diff plus `proposal.md` under
  `.graphkit/inbox/<ts>-dream/`. The prohibition on editing `.graphkit/memory/` directly is
  a prompt-level contract in the node objective and the memory-curator fragment, not a
  sandbox — same honest label as `no_write` elsewhere in the kit (mechanically enforced
  only on the pi target via `--tools` filtering).
- `challenge` (qa-engineer, `constraints: [{no_write: true}]` apart from its evidence key):
  adversarial review of the diff against freshness/supersede rules; verdict evidence.

Apply is manual: human reads `proposal.md`, runs `git apply changes.patch`. Git = audit trail.
No code path applies a dream patch automatically.

## 6. Skills/docs surface

- `gk-brainstorm` + `gk-init-graph` skills read `gk suggest --json` as authoring input
  ("based on 6 past runs, start from audit-pr").
- `gk-recall` skill documents `patterns/` subfolder + links expansion.
- README (Memory + Execution sections), CHANGELOG entry.
- memory-curator agent fragment (`.omp/agents/memory-curator.md`) gains dream role.

## 7. Schema changes

- `MemoryFileSchema.type` gains `pattern | suggestion`. No other frontmatter changes
  (owner/review_after deferred — no consumer).
- `NodeDefSchema`/`HookRef`: no change (already sufficient).
- `GraphTemplateSchema`: no change — dream is a plain template.

## 8. Error handling

- `gk run node` without active run → exit 1, pointer to `gk run start`.
- `gk run start` with `.active` present → error naming the live run.
- `consolidate` with zero runs → clean no-op.
- Corrupt `.links.json` → silent rebuild (disposable by contract).
- Trace append failures fail loud (CLI direct, not hook fail-open).

## 9. Testing

- Unit (bun:test): n-gram/signature/salience math; links builder over fixture traces.
- CLI acceptance: `run start → node×3 → end → consolidate → suggest` over a temp dir;
  assert ledger + pattern files + suggestion output.
- Existing gates stay green: `memory-recall-eval`, `check-cli-parity`.

## Implementation phases

1. Ledger + tracing: `gk run` + HookRef wiring + gk-execute skill updates (5 kits).
2. Pattern compiler + links + `gk suggest` + recall expansion + `MemoryFileSchema` types.
3. Dream template + memory-curator fragment dream role.
4. Surface: gk-brainstorm / gk-init-graph / gk-recall skill docs, README, CHANGELOG.

Each phase independently green (build + tests) before the next.
