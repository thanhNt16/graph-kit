# Extension Layer Audit — kits/_core/extensions, src/targets, scripts/{gen-kits,sync-omp}

Scope: gk-subagent.ts, jev.ts, targets/{types,registry,model-tiers,index}.ts, gen-kits.ts, sync-omp.ts, kit.ts install path, node-agents.ts, validate.ts agent binding. Empirical probes in /tmp/gk-audit-ext/scratch-{pi,codex,cursor,opencode,claude}.

## Findings

### F1 — HIGH — `gk validate` false-fails on every codex install (empirically confirmed)
- `src/compiler/validate.ts:26-36`: agent ladder reads the first existing dir; `readdirSync(...).map(basename(f, ".md"))` never strips `.toml`. Codex agents are `.codex/agents/*.toml`.
- Evidence: fresh `gk init --target codex` + minimal graph → `VALIDATION_FAILED: Agent "implementer" not found. Available: adversarial-reviewer.toml, …`. Same graph validates clean on pi.
- `src/cli/commands/inventory.ts:138-141` already handles both extensions; validate.ts does not. Codex host is hard-blocked at the first gate of init→execute.

### F2 — MEDIUM-HIGH — opencode agent dir `agent/` (singular) contradicts current OpenCode docs (`agents/`, plural)
- `src/targets/registry.ts:30`, `src/compiler/validate.ts:30`, `scripts/gen-kits.ts:226` (prose: "must match an agent filename in `.opencode/agent/`"), plus gen-kits HOSTS.
- opencode.ai/docs/agents (read 2026-10-06) says per-project agents live in `.opencode/agents/`. If singular is no longer read, the entire opencode kit's agents are undiscoverable and only skills/rules land. Could not runtime-verify (no opencode host available). Re-arch must verify dir names against host releases, not folklore.

### F3 — MEDIUM — model-tier defaults are snapshot product names baked into generated prose; the test defends the rot
- `src/targets/model-tiers.ts:5-12`: cursor `Grok 4.5`/`Composer 2.5`, opencode `anthropic/claude-opus-4.5` (dot-spelled; Anthropic ids are dash-spelled), codex `gpt-5.4`/`gpt-5.3-codex-spark`.
- Cursor docs (models-and-pricing, read 2026-10-06) call these display names; subagent `model` wants IDs like `composer-2`. Additionally inconsistent in-house: cursor/opencode agent frontmatter carries bare tier keywords (`model: sonnet`, gen-kits.ts:872) while gk-execute dispatch prose carries the mapped names — two spellings for one host.
- `tests/unit/cursor-model-map.test.ts` pins `Grok 4.5` as a "regression guard" — the test freezes drift instead of preventing it. `gk models <target> set --map` already provides the override path; defaults should be conservative (pi's empty-string pattern) not speculative.

### F4 — MEDIUM — legacy compile surface survives in 4 carriers while all prose says "no compilation"
- `gk compile` still works (ran it; it emitted `.claude/workflows/gk-memory-improve.workflow.js`); `src/compiler/` emitter pipeline retained; claude kit ships extra skills `gk-run`/`gk-compile` (kits/claude/skills/, copied via `extraSkills`, gen-kits.ts:365) describing a Workflow tool + a `.graphkit/runs/current.json` layout that no longer exists; `TargetDescriptor.execution.workflowTool` (registry.ts:13) is consumed by nothing but its own test.
- Two execution stories ship to claude users; only one is real. Re-arch: delete or explicitly quarantine.

### F5 — gk-subagent retained-rationale VERIFIED — holds
- Native task tool has no timeout/kill (confirmed against live omp task schema) and no ledger coupling. gk-subagent uniquely provides: `timeout_ms` wall-clock kill with process-group SIGTERM→5s→SIGKILL (`gk-subagent.ts:136-159`, detached spawn + `kill(-pid)`), contractual `TIMEOUT` marker + exit 124 (`:179-187`), pre/post-spawn dispatch-intent records for `run take` reconciliation (`:107-115`), abort-signal propagation.
- Cost: 278 lines whose only surviving consumer is hard-timeout nodes; `omp -p` child path is POSIX-only (`/bin/sh -c`, env-piped prompt) and duplicates prompt assembly native dispatch does better. Keep the kill semantics; shrink the schema toward {agent, objective, timeout_ms, node, attempt}. Note: dispatch() has zero direct tests (only `buildPiArgs`, 4 cases, pi-extension.test.ts).

### F6 — jev.ts is orthogonal, live-verified, but carries dogfood-local key resolution
- Role: typed decisions (noul/choice/score) against the System One endpoint — not a chat model. Live proof: `jev_decide` is mounted in this audit session via .omp/extensions.
- `jev.ts:40-69` reads `~/.9router/db/data.sqlite` as a key fallback — a local-machine convenience inside shipped kit code. Zero tests for the extension. Keep capability; env-only key resolution in the shipped artifact.

### F7 — MEDIUM — target knowledge lives in 3+ unsynchronized tables
- `src/targets/registry.ts` (runtime), `scripts/gen-kits.ts` HOSTS (build), `src/compiler/validate.ts:26-32` (hardcoded ladder, registry-unaware), plus codex `.agents/skills` special-cases duplicated in kit.ts (`:192-229` with `skills.dir: "../.agents/skills"` as a string path in the registry). `AGENT_META` (gen-kits.ts:468-757, 290 lines) duplicates descriptions that also exist as prose in `kits/_core/agents/*.md`.
- Drift is currently zero (`gen-kits --check` and `sync-omp --check` both pass) but enforced by parallel gates over parallel tables. F1/F2 are both direct descendants of this shape.

### F8 — materialization pipeline itself is clean and verified end-to-end (pi)
- Chain: `kits/_core` → `gen-kits` (staged temp swap, refuses to destroy unknown files, --check drift gate) → `kits/<host>` (checked-in artifacts) → `gk init` cpSync (preserves `.gk.json`, honors metadata `deletions`, merges AGENTS.md section) → project install dir → `gk graph agents` materializes `gk-<node>.md` (frontmatter name/description/model/tools/autoloadSkills + constraint-derived tools + scope sections; prunes stale `gk-*`; node-agents.ts:64-127) → omp native task discovery (live-proven: this session's agent roster is the kit roster).
- pi smoke passed: init → validate → graph agents → run start (id+sha) → dispatch → node → status → end. `gk run land` correctly requires git.

### F9 — LOW — validate agent ladder: first-dir-wins, `.md`-only, one vestigial entry
- Order bias means multi-host repos (this repo: `.omp` + `.claude`) always validate against omp; cursor/opencode/codex dirs are shadowed. `claude/agents` (non-dot, :32) looks vestigial. Combined with F1: binding validation is the weakest link in an otherwise careful pipeline.

### F10 — INFO
- `KitTarget = "claude" | "cursor"` (kit.ts:46) is stale; runtime validates all 5 via registry — cosmetic type lie.
- Installed CLI is gk/0.3.34 while repo package.json says 0.3.0 (version.ts carries release version — skew is display-only).
- `fable` tier exists (types.ts:1) but `AgentMeta.tier` union omits it (gen-kits.ts:459) — 4th tier unreachable in generated agent metadata.
- All 5 kits install cleanly (scratch-verified); cursor frontmatter extras (`readonly`, `is_background`) match current Cursor subagent docs; codex TOML (`model`, `model_reasoning_effort`, `sandbox_mode`, `developer_instructions`) matches Codex custom-agents docs; codex sibling `.agents/skills` install mirrors the cross-tool skills convention.

## Friction-log
1. `gk init --target <host>` — per project; merges AGENTS.md section; `.gk.json` records kitVersion.
2. Author graph.yaml — sharp edges: `constraints` is array-of-single-key objects (hit 2 schema errors authoring a trivial node); `outputs.evidence_dir` + `evidence:` block mandatory even with no required keys.
3. `gk validate` — codex: false VALIDATION_FAILED (F1); multi-host: silently picks one host's dir (F9).
4. `gk run start --graph X --json` — returns run id + sha that must be copied into dispatch message headers by hand.
5. `gk graph agents` (pi only) — materialize/prune `gk-<node>.md`.
6. Per wave: `gk run dispatch` per node → task-spawn per node → `gk run node` per node → `gk evidence add` per file → `gk run land` per node (needs git) → `gk run end`. ~6 ledger commands per node lifecycle, all manual.
7. Recovery path adds `run take`/`run resume`, consuming dispatch.jsonl intent states (only the extension path writes pid states).
- Extension-layer contribution to init→execute friction: low. The kit/ledger scaffolding is not what's slow; the per-node manual bookkeeping (6) and the validate gate (3) are.

## SOLID-lens
- **S**: gen-kits.ts (1138 ln) = transform table + emission + diff + CLI in one; AGENT_META is data-in-code. kit.ts mixes install + AGENTS.md merge + gallery/templates resolution.
- **O**: adding host #6 touches ≥8 sites: HOSTS, emitAgent if-chain, VISUALIZE_INVOCATION, GK_EXECUTE_OVERRIDES, PURPOSE_LINE_BY_HOST, CURATOR_ITEM_BY_HOST, TOOLS_BY_TARGET, TARGET_MODEL_DEFAULTS. Closed-for-modification in name only; acceptable at N=5, wrong at N≥6.
- **I**: TargetDescriptor is fat; consumers use slices (kit.ts: install/rules/hooks; models.ts: tiers; validate: agent dirs). Packaging vs execution deserve separate descriptors.
- **D**: validate.ts depends on a hardcoded filesystem ladder instead of the registry that owns the knowledge (root cause of F1/F9). gen-kits importing TARGET_MODEL_DEFAULTS from src is the good pattern — single-sourced data.
- **Layering** is otherwise sound: _core (source) → generator (build, gated) → checked-in kit artifacts → installer → runtime binding (node-agents). Boring, inspectable, diffable.

## Kill-or-keep
- **KEEP**: gen-kits generator + staged swap + both --check gates; node-agents materializer (clean, prunes); gk-subagent kill/timeout/intent semantics (shrink schema); sync-omp dogfood mirror; installKit care (config preservation, deletions ladder).
- **KILL**: `gk compile` + compiler emitter pipeline + claude `gk-run`/`gk-compile` extras + `workflowTool` flag (one dead surface, four carriers); `claude/agents` ladder entry; cursor-model-map pinning test.
- **MERGE**: registry/gen-kits-HOSTS/validate-ladder → one target table; AGENT_META descriptions → derived from _core prose (or frontmatter in _core); move per-host gk-execute overrides into _core with placeholders if the table grows again.
- **FIX**: codex `.toml` binding (F1); opencode dir verification against docs (F2); model defaults → conservative + `models set --map` (F3).
