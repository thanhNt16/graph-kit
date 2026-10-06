# Audit: gk-recall + gk-eval skills, memory recall CLI, eval rubrics/gate

Scope: `kits/_core/skills/gk-recall/SKILL.md`, `kits/_core/skills/gk-eval/SKILL.md`, `src/cli/commands/memory.ts`, `src/memory/recall-expanded.ts`, `src/memory/explain-recall.ts`, `src/eval/*`, exercised end-to-end in `/tmp/skill-recall-eval-scratch` (3 fake runs → consolidate → all recall variants → gate mid-run/post-hoc, strict + default). Installed CLI: gk/0.3.34 (not 0.3.33); repo package.json `0.3.0`.

## Findings

1. **HIGH — eval-gate "memory"/"both" modes are documented but have no execution path.**
   Evidence: `kits/_core/skills/gk-eval/SKILL.md:23-28` instructs "Apply `scoreMemory(state, {abstention_weighted})`" and "run `bun run eval:memory`". But `scoreMemory` (`src/eval/rubrics.ts:42`) is called only by `src/eval/replay.ts:28` — the golden-fixture replay (`bun run eval` → `src/eval/replay-cli.ts`, reads `eval/golden/*.yaml` in the graph-kit repo). `bun run eval:memory` = `scripts/memory-recall-eval.ts`, which reads `eval/cbm/memory-fixtures` — repo-internal paths that do not exist in a user project. Registry confirms no eval command: `src/cli/command-registry.ts:35-88` has `gate` only (registered in `src/cli/commands/gate.ts:112`), which is hard-wired work_product (`gate.ts:69` calls `scoreWorkProduct` only; `EvalConfig.mode` from `src/schemas/eval.schema.ts:13` is never read by the gate).
   Why it hurts: the flagship claim of gk-eval — evidence-based gating including memory hygiene — is not runnable where the skill runs. An agent following the doc hits step 6 and can only improvise. `both` mode (SKILL.md:27) is entirely vapor.

2. **HIGH — the eval gate refuses to run on any unrelated graph validation finding.**
   Evidence: `src/cli/commands/gate.ts:120-124` — `validateGraph` blocking findings → `VALIDATION_FAILED`, gate never scores. Reproduced: `gk gate` with `memory.curator_node: curator` but no curator node → `VALIDATION_FAILED` (memory-curator-node finding), even though the gate only needs `evidence.required_keys` + `outputs.evidence_dir`.
   Why it hurts: mid-run, the gate node's one job is scoring, but it inherits whole-graph health as a precondition. A typo elsewhere in graph.yaml turns "evidence incomplete: BLOCK + reasons" into an opaque validation dump. This is avoidable coupling at the exact moment the user wants a verdict.

3. **HIGH — strict freshness is unpassable in non-git projects, with a misleading remediation hint.**
   Evidence: `src/evidence/fingerprint.ts:25-27` — non-git → `{head:null, tree:null}`; `src/evidence/marker.ts:71` — `freshnessOf` returns `"unknown"` whenever either side lacks a fingerprint. Reproduced: in a non-git scratch, correctly stamped evidence (`gk evidence add` wrote `run_id`, `ts`, artifact fields into the marker — verified on disk) → `freshness: unknown` → strict BLOCK with warning "unstamped evidence (no fingerprint marker) … write evidence via `gk evidence add`" (`gate.ts:78-81`) — which the user just did.
   Why it hurts: strict mode is a lie outside git; the gate gaslights the agent into re-running a command that cannot fix it.

4. **MEDIUM — post-hoc gate silently passes foreign evidence.**
   Evidence: `gate.ts:46-48` — lineage scope exists only `if activeRun(cwd)`; comment admits "with no active run the check is skipped so the gate stays usable on fresh checkouts". Reproduced: evidence stamped by ended run 20261006-144204 → post-run `gk gate` (no active run) → `MERGE`, `freshness: unknown`, zero warnings; same evidence mid-run → `foreign` warning (and BLOCK under strict).
   Why it hurts: the same artifact gets MERGE post-hoc and BLOCK mid-run. Verdicts are phase-dependent without the doc saying so; "standalone" gating (a gk-eval when_to_use case) is the weakest path.

5. **MEDIUM — nothing can write content memories; consolidate needs ≥3 runs before any entry exists.**
   Evidence: memory subcommands are only `index trace touch recall consolidate` (`command-registry.ts:53-59`). No add/write. `src/memory/patterns.ts:26-32` — every pattern kind needs ≥2–3 occurrences (SEQ_MIN_RUNS=3, COOCCUR_MIN_RUNS=3, REUSE_MIN_RUNS=3, FAILURE_MIN=2, ADVISOR_MIN=2). Reproduced: 1 full merged run → `consolidate` → `{runs:1, patterns:0, suggestions:0, links:0}` and an empty store; 3 identical runs → 2 patterns + 1 suggestion. `gk-recall`'s when_to_use promises recall of "constraints, past decisions, diagnosed errors" — the only way those enter the store is hand-authoring frontmatter files matching `MemoryFileSchema` (`src/schemas/memory.schema.ts:5-22`).
   Why it hurts: goal→running-graph path: after the first real run, recall returns empty, and nothing in the CLI or docs tells the user why (thresholds are private constants).

6. **MEDIUM — gk-recall SKILL.md omits the flags that make recall debuggable.**
   Evidence: SKILL.md:19 says run `gk memory recall --json "<query>"`. The `--explain`, `--html`, `--origin` flags (`memory.ts:228-230`) are absent from the skill. Verified working: `--explain` prints per-doc matched_terms/raw/final scores + rejected reasons (superseded / expired / not_yet_valid / below_cutoff / zero_overlap) and PPR link expansion (`linked_via`, `ppr_mass`); `--explain --html` writes `.graphkit/diagrams/recall-<q>-<ts>.html`; `--html` without `--explain` → `INVALID_OPTION`; `--origin agent:test` lands in `.recall-log.jsonl`. Verified `--explain` is side-effect free (use_count unchanged, no log rows) — the read-only claim at `memory.ts:283-284` holds.
   Why it hurts: when recall returns nothing or wrong things, the agent's only documented move is re-querying blind. The explain lens is the single best UX in the memory stack and the skill that routes agents to recall never mentions it.

7. **MEDIUM — shipped skill references repo-internal paths that don't exist in user projects.**
   Evidence: gk-recall SKILL.md:14 (`scripts/memory-recall-eval.ts`), :38 and :42 (`src/eval/memory-recall.ts`). gk-eval SKILL.md:24 (`bun run eval:memory`). These are graph-kit-repo paths; kits are the deployed surface (user projects have neither `scripts/` nor `src/`).
   Why it hurts: degradation instructions ("apply the same filters manually — see src/eval/memory-recall.ts") point at files the agent cannot read. Also the fallback scan says `.graphkit/memory/*.md` — missing that the CLI searches `patterns/` and `suggestions/` subfolders too (SKILL.md:32 documents subfolders for the CLI path but not the fallback).

8. **LOW — recall mutates its own ranking input on first touch.**
   Evidence: `src/eval/memory-recall.ts:124` tokenizes `head + body` = raw frontmatter text; `touchMemory` (`memory.ts:189-219`) rewrites frontmatter adding `use_count`/`last_used_at`. Reproduced: identical query scored 3.9117 → 3.7921 → 3.8121 over three consecutive recalls (frontmatter grows once, then length stabilizes). BM25 doc length changes ⇒ scores drift after first reinforcement.
   Why it hurts: non-reproducible rankings on fresh stores; two agents recalling the same query minutes apart can disagree — and the memory-recall eval's hit_rate≥0.8 guarantee doesn't transfer to live stores.

9. **LOW — recall is not read-only and reports `injected: true` unconditionally.**
   Evidence: `memory.ts:335-347` — every non-explain recall appends `.recall-log.jsonl` AND `mkdirSync(memDir, {recursive:true})`. Reproduced: recall in an empty project created `.graphkit/memory/.recall-log.jsonl` with `{"top":[],"injected":true,"scanned":0}` — a 0-hit query logged as injected.
   Why it hurts: a query side effect materializes store infrastructure; downstream replay tooling trusting `injected` gets false positives.

10. **LOW — gk-eval step 2/9 artifacts don't exist as described.**
    Evidence: SKILL.md:16 "Read `.graphkit/evidence/.index`" — the gate never reads it; `.index` is an append-only log written by `gk evidence add` (`src/evidence/store.ts:82-86`). SKILL.md:30 "Write `.graphkit/reports/{run-id}-eval.md`" — no writer exists; the only reports writer is `gk evidence report --html` → `{name}-evidence.html` (`src/cli/commands/evidence.ts:72-75`); `outputs.report` (`graph.schema.ts:162`) is dead schema.

11. **LOW — score-vocabulary drift across the two recall surfaces.**
    Evidence: plain recall returns `salience` (= explain's `final_score`, `recall-expanded.ts:23-28`); explain additionally returns `raw_salience`. Linked hits are appended after direct hits by admission order, not score order — reproduced: linked hit with salience 2.2249 listed after direct hit 2.0003 (`recall-expanded.ts` docstring says "linked neighbors rank below direct hits"; they rank below by position, above by score).
    Why it hurts: an agent switching between explain and plain mode, or sorting by salience, gets surprises.

12. **INFO — gate-as-node friction for the native dispatch flow**: the eval-gate agent must know (a) `gk gate` validates the whole graph first, (b) evidence keys map to `<evidenceDir>/<k>.md` by basename only (ADR-002, `gate.ts:18-23`), (c) `freshness: strict` semantics, (d) `require_landed` compares trace `evidence` lists. None of this is in gk-eval SKILL.md — the skill describes an idealized pseudo-code pipeline instead of the command that exists.

## Friction-log

What a user/agent must do to go from "graph ran" → "memory recalled + gate scored" (all steps executed for real in scratch):

1. Author graph.yaml; if `topology_config.memory.curator_node` is set, a node with that id MUST exist or every `gk gate` (and likely run start) fails validation (hit this).
2. `gk run start --graph graph.yaml --json` → per node `gk run node … --status ok [--evidence k]` → `gk run land <node> --commit <sha>` (prints `fatal: not a git repository` to stderr even when it succeeds — noise on every land/end in non-git dirs) → `gk run end --status merged --json`.
3. `gk memory consolidate` — silent no-op store after 1 run; needs 3 identical runs for the first pattern; no output hint about thresholds.
4. To have anything content-like to recall: hand-write frontmatter markdown under `.graphkit/memory/` matching MemoryFileSchema (no CLI).
5. `gk memory recall "<query>"` — must know to add `--json` (machine) and that this call mutates store (touch) + appends log; to debug: `--explain` (undocumented in skill); `--html` requires `--explain`; `--origin` tags provenance.
6. Gate mid-run: `gk run start` must be active for lineage checks; stage evidence INSIDE the run via `gk evidence add <file> --key k` (else `foreign`); land nodes with `--evidence k` if `require_landed`; then `gk gate graph.yaml --json` — which first re-validates the entire graph.
7. Gate post-hoc: just `gk gate graph.yaml --json`; lineage checks silently skipped; strict freshness impossible outside git.
8. Memory-mode scoring: no path. Options are: clone the graph-kit repo and run `bun run eval` golden replay (irrelevant to live run), or hand-implement the 2×2 from prose.

Count of distinct commands for the happy path: 6+ (start, node×N, land×N, end, consolidate, recall, evidence add, gate) plus graph authoring — and only 2 of them (recall, gate) are the actual goals.

## SOLID-lens

- **S**: `registerMemoryCommands` action is a ~150-line if-chain mixing dispatch, config resolution, and two complete feature flows (recall + explain+html) (`memory.ts:221-372`) — consistent with sibling groups but the recall/explain pair earns its own module. `gateGraph` (`gate.ts:35-110`) merges four concerns: evidence scoring, lineage/foreign check, fingerprint freshness, landed-trace check + manifest building.
- **O**: `EvalConfig.mode` is an open enum (`work_product|memory|both`) with exactly one consumer branch (`gk gate` → work_product). Adding memory mode means touching gate.ts, rubrics wiring, and CLI — no gate-mode registry/strategy. Closed-for-extension in practice.
- **L**: `expandedRecall` as a pure projection of `explainRecall` is clean substitutability (`recall-expanded.ts` is 30 lines) — good. The CLI explain/plain pair is not substitutable: different output vocabularies (`salience` vs `raw_salience`/`final_score`).
- **I**: interfaces are small and honest (`RecallEntry`, `ScoredDoc`, `ExpandedHit`). Violation of spirit: the skill-facing contract is the CLI JSON, and its shape (`{results:[{id,file,salience,linked}], linked, recall_topk}`) doesn't expose validity windows or sources — the agent must re-read files to get `as_of`, which the skill then has to document as a manual step (SKILL.md:27-28).
- **D**: the retriever is properly shared (CLI, explain lens, eval all call `src/eval/memory-recall.ts` — the one dependency pointing the right way). Inversion: `recall-expanded.ts` header says "the explain lens owns the BM25 scoring, the filters, and the PPR link join" — the debug/inspection tool is the engine and the primary path is its projection. Works, but the layering story is upside-down; a rename (`scoring.ts`) would fix the narrative.
- **Layering observation**: kit skills (deployed to user projects) depend on repo-internal `scripts/`+`src/` knowledge — a dependency from the distribution artifact back into the monorepo, which is exactly what breaks at step 6/7 of gk-eval.

## Kill-or-keep

**Keep**
- Single-call recall with rank+filter+supersede+reinforce semantics. The invariant "explain is bit-identical scoring, side-effect free" is verified and valuable — keep the read-only guarantee as a hard contract.
- PPR link expansion (`explain-recall.ts:56-79`): deterministic, small, and the `rejected_top_n` reasons (superseded/expired/not_yet_valid/zero_overlap) are exactly what an agent needs to fix its query or its store.
- `MemoryFileSchema` fail-loud schema guards in consolidate (consolidate.ts:188-193, 234-239).
- `gk gate` basename evidence-key contract (ADR-002) — zero-parser, deterministic.

**Cut**
- gk-eval memory-mode + both-mode + LLM-as-judge doc sections until any of it is executable; today they're the skill's majority and 0% runnable. Shrink the skill to what `gk gate` does.
- `.index` and `{run-id}-eval.md` references (no reader/writer).
- Repo-internal path references in both skills.
- `both` as an enum value (unused branch).

**Merge**
- `recall` + `--explain`: make `--json` recall include per-hit `matched_terms` and rejected-with-reason summary (the explain payload), so agents get debuggability in the documented command instead of needing a second flag they don't know about.
- `gk gate` + a `--mode memory` (or `gk memory score`) that shells the rubric math over the live store — scoreMemory's hygiene axis (count expired/superseded/dupes) is fully derivable from disk today; adherence/generalization genuinely need the agent.

**Fix in re-architecture**
- Seed path: add `gk memory add` (or let node land write memory entries) — the "constraints/decisions/errors" promise of gk-recall is unreachable through the CLI today.
- Lower/document consolidate thresholds; print "0 patterns (needs N runs of ≥2 nodes)" instead of a bare zero-count JSON.
- Gate should score its evidence keys even when unrelated graph findings exist (scope validation to `evidence`+`outputs`), or at least distinguish "gate precondition failed" from "gate verdict: BLOCK".
- Freshness in non-git: either drop `strict` to a no-op with an explicit warning, or make markers self-contained (hash evidence bytes, not repo state).
- Stop letting touch mutate BM25 input (exclude frontmatter from tokenization; body-only scoring) — makes live-store rankings reproducible and kills finding 8 for free.
