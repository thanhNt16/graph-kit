# Memory subsystem audit — src/memory/ + src/cbm/ (gk 0.3.33)

Scope: 12 files in src/memory/ (2,660 LOC with src/cbm/) + wiring in src/cli/commands/{memory,suggest,run,graph}.ts, src/eval/{memory-recall,forgetting}.ts, kits/_core agents/skills. All empirical numbers from a fabricated ledger in /tmp/gkmem-bench (25/100/400 synthetic runs, 12-node recurring graph, 10 evidence keys/run, 20 hand-written memories).

## Findings

**F1 [HIGH] Consolidation compute cost is fine; consolidation output is noise-dominated.**
- Evidence: measured `gk memory consolidate` wall time: N=25 → 237ms, N=100 → 331ms, N=400 → 856ms. Linear-ish, sub-second at realistic scale. Not a perf fire.
- But the same run produced **360 pattern files from 25 runs of a 12-node graph** (1.05 MB of markdown + 150 KB `.links.json`). Kind breakdown: evidence-cooccurrence **315 (87.5%)**, node-sequence 36, graph-reuse 5, failure-recurrence 3, advisor-repeat 1.
- Why: `extractPatterns` counts all unordered evidence-key pairs per run (patterns.ts:104-110) and the ≥3-runs threshold (patterns.ts:29) is trivially crossed in any real repo because runs re-touch the same modules. The quadratic emitter is also the quadratic *output*: K keys → K(K-1)/2 candidate files.
- Why it hurts: the memory store that agents recall over is 87% pair-noise; the 9 actionable entries (failures, reuse, advisor) are 2.5% of the store. Consolidation is cheap and still produces the wrong artifact.

**F2 [HIGH] Recall post-run delivers near-zero value as shipped.**
- Evidence: `gk memory recall --json "implement-core test review fail"` over the 380-entry store: 5 hits, salience ≈ 0.00276/0.00276/0.00276 — no discrimination — and **linked=0**.
- PPR link expansion only fires when direct hits fill fewer than k slots (explain-recall.ts:140 `hits.length > 0 && hits.length < k`); with k=5 and BM25 always matching *something*, linked expansion is dead code in practice.
- The `.links.json` graph is near-complete (389 edges over 380 entries) because evidence keys are path-like and match the ENTITY regex (links.ts:15), so every entry connects to every entry — zero discriminative power, so even when PPR fires it spreads mass uniformly.
- Agent gain, honestly stated: BM25 over tokens like "src", "feat", "key" + stale salience ≈ arbitrary 5 files the agent must open and read. The actionable 2.5% requires the agent to already know the query vocabulary ("fail", node names).

**F3 [HIGH] Re-consolidation destroys reinforcement and expiry state (verified).**
- Sequence run live: `gk memory touch pattern-X` → use_count: 2, last_used_at set → `gk memory consolidate` → **use_count and last_used_at gone from the file**; `created_at` reset to consolidate-time.
- Root cause: consolidate rebuilds pattern frontmatter from scratch and full-overwrites via `writeEntry` (consolidate.ts:128-131, 168-187). Its field list has no use_count/last_used_at, and hardcodes `expired: false` (consolidate.ts:183).
- Consequences: (a) the entire ACT-R anti-decay mechanism ("what recall uses, decay keeps", kits gk-recall SKILL.md) is falsified — every consolidate wipes the evidence of use; (b) a pattern that `gk memory trace` expired is resurrected with expired:false on the next consolidate; (c) `created_at`/`valid_from`/`recorded_at` lie (reset every pass, so temporal-validity windows drift). Two writers, one file, lost-update semantics — the exact inverse of the "one writer per concern" rule suggest.ts:3 declares.
- gk-execute SKILL.md:70-72 mandates `gk memory consolidate` after every `gk run end`, so in the documented flow reinforcement never survives a run boundary.

**F4 [HIGH] src/cbm is 391 LOC + 2 seams serving a backend that cannot start.**
- Evidence: client.ts:15-18 — "the CBM package is unpublished (npm 404) and we deliberately do NOT resurrect the bridge — it can't work." Every call surfaces CBM_UNAVAILABLE.
- Dead-but-polished: route.ts (240 LOC) implements question-kind classification (callers/dataflow/deadcode/wheredef/deps), symbol extraction, Cypher anti-join for deadcode, snippet fetches — all against `@graphkit/codebase-memory-mcp`, uninstallable. Plus contract.ts (mirror types), index.ts, cli/cbm-seam.ts (test DI).
- Six CLI subcommands hard-fail on any default install: `graph index|search|ask|trace|query` + `memory index`. `gk memory index` additionally writes `.last-index`, a watermark nothing else in src reads (ponytail comment admits it: commands/memory.ts:44-47, 68-69).
- Not a duplicate of native memory (code-structure graph vs run-history store are different corpora — skill docs correctly say CBM search_graph returns 0 hits over markdown-only projects). It *is* a duplicate of the external codebase-memory-mcp server, which exists as mounted MCP tools in the harness. The bridge re-implements an integration the platform already provides.

**F5 [MED] Five hand-rolled similarity/co-occurrence mechanisms implement one idea.**
- Inventory: evidence-pair counting (patterns.ts), entity-clique linking (links.ts), jaccard token write-gate (consolidate.ts:47-71), Okapi BM25 (eval/memory-recall.ts:209-240), PPR (explain-recall.ts:52-79). Each has its own tokenizer/notion of "related".
- patterns/links/suggest are not literally one idea implemented thrice — they derive relations from different corpora (ledger vs memory files vs patterns) — but the *similarity substrate* is reinvented per module, and only the links graph is consumed (by recall's PPR, which F2 shows never fires). Suggest is a 4-branch template lookup over pattern kinds (consolidate.ts:86-126) — 40 lines that could live inside consolidate.
- The whole relations layer (links.ts 100 LOC + PPR 28 LOC + recall-expanded.ts 30 LOC) exists to serve an expansion path that measurably returns 0 hits.

**F6 [MED] The memory lifecycle is a 4-command manual choreography spread across three surfaces.**
- Writer side: agent must run `gk memory consolidate` (only caller: CLI handler; `endRun` does not chain it — verified by grep). Curator side: `.omp/agents/memory-curator.md` requires recall → read evidence dir → write OKF files → `gk memory trace` → touch survivors → emit INJECTION line. Reader side: gk-recall skill wraps `gk memory recall --json`.
- Nothing ties these: no post-run hook, no daemon, no auto-decay. The design docs describe "Stage 5 of the memory pipeline (decay)" (commands/memory.ts:71) but stages 1-4 and 5 are separate commands the agent must remember, in order.

**F7 [MED] Decay/reinforcement engine lives in the CLI layer.**
- `traceMemory` (ACT-R scoring, schema revalidation, legacy-tag YAML re-parse, connectivity heuristic, in-place expiry rewrites, audit log) and `touchMemory` are in src/cli/commands/memory.ts:76-219 — 144 lines of domain logic in the arg-parsing file. src/memory/ has no decay module; the "memory pipeline" is split between src/memory/ (derive) and src/cli/ (score/expire/reinforce).
- Also: touchMemory does a full store walk per hit; `recall` loops it over up to k survivors (memory.ts:332) → O(k × store) reads per recall, on top of explainRecall's own full load.

**F8 [MED] Two decay models over one store, one shared constant.**
- patternSalience: count × 2^(-age/14d) recomputed per consolidate (patterns.ts:36-43). ACT-R: relevance × connectivity × log-reactivation with 14d half-life (eval/forgetting.ts) applied by traceMemory. A pattern can be salience-ranked top-20 in index.md and simultaneously ACT-R-expired, or vice versa. Only coupling: `HALF_LIFE_DAYS` import. In a re-architecture: one decay function, one writer.

**F9 [LOW] Store meta-state sprawl: 6 sidecar files.**
- index.md, log.md (reserved), .links.json, .recall-log.jsonl, .graphkit/.trace-log, .graphkit/.last-index, plus `.graphkit/memory/.index` (distill watermark) written by an *external* hooks plugin — nothing in src/ reads or writes it (grep-verified), yet curator docs make it the freshness watermark. Cross-repo implicit contract.
- `.recall-log.jsonl` rows carry `injected: true` hardcoded (memory.ts:344) — nothing injects; the flag is aspirational telemetry.

## Friction-log (init → execute → memory payoff, as documented)

1. Author graph.yaml (init-graph skill) — memory config optional (`topology_config.memory.recall_topk`).
2. Run graph: `gk run start --graph X --json` → dispatch → `gk run node|dispatch|land` per node → `gk run end --status ...` (skill-mandated).
3. **Manual**: `gk memory consolidate --json` after every run end (gk-execute SKILL.md:71). Forgetting it = store frozen at last manual pass.
4. Per curator fire (separate agent): `gk memory recall "<objective>"` → read each hit file under `.graphkit/memory/` → read evidence since `.graphkit/memory/.index` watermark (external plugin's file) → hand-write OKF memory files → `gk memory trace` (decay) → decide injection → terminal `INJECTION: <reminder>|null` line contract.
5. To keep any recalled memory alive across runs: recall must happen *after* the last consolidate, else F3 wipes it.
6. `gk memory touch <id>` exists as a separate command but recall already touches; only useful for hand-reinforcement.
7. `gk suggest` (separate command file, cli/commands/suggest.ts) to read/dismiss suggestions consolidate wrote.
8. Dead ends a user/agent can wander into: `gk graph search|trace|query|ask|index`, `gk memory index` → CBM_UNAVAILABLE every time.

## SOLID-lens

- **S (violated at package level)**: src/memory/ is two subsystems. (a) Run-runtime: ledger.ts (393, run state machine + active pointer + takeover), loops.ts (142, round journals), resume.ts (369, crash reconciliation + *derived graph authoring* incl. `validateDerivedGraph`/`deriveResumeGraph` — compiler/store territory, it even calls `saveSessionGraph/setActiveGraphId` from src/store), analyze.ts (196, per-run telemetry). (b) Knowledge store: store/consolidate/patterns/links/suggest/recall*/render-recall (~1,100 LOC). Only (b) is "memory"; (a) is the run ledger that happens to live in `.graphkit/runs/`. 12 files, 3 responsibilities, 2 consumers (CLI + agents) and the decay engine living in neither.
- **O (violated)**: adding a new pattern kind = edit extractPatterns + suggestionsFor + (maybe) PatternKind union + fold behavior in consolidate. The kind→suggestion mapping is an if/else chain inside consolidate.ts:91-123, not data.
- **L (n/a-ish)**: no inheritance; nothing Liskov-relevant. Behavioral substitutability issue is the F3 write-ordering hazard instead.
- **I (violated in spirit)**: consumers of "memory" face 12 modules + 6 CLI subcommands + skill conventions. The recall path alone spans store→eval(memory-recall)→explain-recall→recall-expanded→links→cli(touch/log). recall-expanded.ts is a 30-line reshape of explainRecall whose only consumer is the CLI — an interface with one caller and no second implementation in sight.
- **D (violated)**: dependency cycles at package level, grep-verified: memory/ledger.ts ⇄ evidence/store.ts (memory imports evidence/fingerprint; evidence imports memory/ledger) and memory/{patterns,render-recall} → eval/{forgetting,memory-recall} while eval/memory-recall → memory/store. Production recall literally imports its engine from the eval harness ("Reference implementation of the filters: src/eval/memory-recall.ts" — gk-recall SKILL.md). Product depends on test-harness package; abstractions (engine) owned by the wrong side.

## Kill-or-keep (re-architecture)

**Kill**
- src/cbm/ entirely (391 LOC + cbm-seam.ts): dead backend. If code-structure Q&A is wanted, it already exists as external MCP tools; gk should not ship a spawn-and-404 client. Removes 6 always-failing subcommands.
- recall-expanded.ts + PPR link expansion + links.ts *as a recall input*: measured 0 linked hits; graph near-complete. If relations are kept at all, keep links.ts only as a curator visualization, not a retrieval stage.
- evidence-cooccurrence pattern kind (or gate it hard: ≥5 runs AND both keys still exist on disk). It is 87.5% of store volume and 0% of recall value.
- `.last-index` + `gk memory index` subcommand.

**Merge**
- traceMemory + touchMemory out of cli/commands/memory.ts into src/memory/lifecycle.ts (or into store.ts's writer); one decay model (pick ACT-R, drop patternSalience or derive salience from ACT-R).
- suggest.ts (53 LOC) into consolidate.ts; the kind→action table becomes data.
- resume.ts + analyze.ts + loops.ts + ledger.ts → a `src/runs/` (or src/ledger/) package. src/memory/ shrinks to: store, consolidate, patterns, recall (one file: load+BM25+filters — eval/memory-recall.ts moves back in), lifecycle.

**Keep**
- store.ts: clean primitives (frontmatter reader/writer, one walk, one tokenizer) — genuinely shared, zero waste.
- Deterministic no-model consolidation (hash signatures, schema-validated writes with fail-loud invariant guard) — the *approach* is right and cheap; fix the field-merge (preserve use_count/last_used_at/expired/created_at across rebuilds) and the co-occurrence flood.
- index.md as the ≤200-line human index; `.trace-log` audit trail.
- recall --explain lens + render-recall: the only honest debugging surface in the subsystem; rare example of a CLI feature that explains its own scoring.

**Top 3 if only three things change**: (1) make consolidate merge-retain lifecycle fields (F3 — correctness, one afternoon); (2) delete src/cbm + its 6 commands (dead weight, misleading surface); (3) collapse the memory pipeline to two entry points — `gk run end` chains consolidate+trace automatically, and `gk memory recall` is the only read an agent needs (auto-touch already there). That removes the bulk of the init→execute→payoff friction the re-architecture targets.
