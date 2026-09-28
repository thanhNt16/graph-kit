# E2E Audit Fixes — Implementation Plan

> Spec: `docs/superpowers/specs/2026-09-28-e2e-audit-fixes-design.md`. Slices are file-disjoint; each agent edits code + tests, skips all gates/formatters.

## Task table

| Slice | Files | Content |
|---|---|---|
| A cli-hardening | `src/index.ts`, `tests/unit/cli-trust.test.ts` | try/catch around `cli.parse()` → help + stderr message, exit 1; "Unknown command" line for bogus argv. Tests: unknown flag on 2 commands → no stack on stdout, exit 1; `gk bogus` → "Unknown command". |
| B ledger-integrity | `src/cli/commands/run.ts`, `src/memory/ledger.ts`, `src/run/resume.ts` (+ adjacent run modules), `tests/unit/` (new `run-ledger-guards.test.ts` or matching convention) | UNKNOWN_NODE validation for node/land/dispatch via active run's recorded graph; run start graph resolution `--graph`→`graph.yaml`→active session graph; take liveness (EPERM=alive, pid>0); land latest-status + `^[0-9a-f]{4,40}$` commit; foreign_evidence in take payload; ENOENT→GRAPH_FILE_NOT_FOUND on resume; fix "passed with evidence on disk" wording for no-evidence ok traces. |
| C evidence-resolution | `src/cli/commands/evidence.ts`, `src/evidence/report.ts`, `tests/unit/` | `--graph` flag on evidence add/report/invalidate; resolution `--graph`→active run graph→cwd/graph.yaml; superseded markers render `status:"superseded"` in report views. Tests for both. |
| D graph-schema-payload | `src/schemas/graph.schema.ts`, `src/cli/commands/graph.ts`, `src/cli/node-agents.ts`, `tests/unit/`, `docs/graphkit.html` (constraints-claims line only if trivially locatable) | waves: role/eval verbatim + warnings on ok payload; validate detects `kind:GraphTemplate`→GraphTemplateSchema path; metadata/inputs→loose; node-id charset `^[A-Za-z0-9._-]+$`; constraints.tools_allowlist string/array honored in nodeTools + validate warning on bogus constraint values; duplicate evidence producers + dup required_keys → warnings; `run start --input k=v` + MISSING_INPUTS. |
| E memory-suggestions | `src/eval/memory-recall.ts` (toDoc), `src/cli/commands/memory.ts` (touch resolution), `src/eval/explain-recall.ts`, `tests/unit/` | suggestion statuses map into doc space; touch finds suggestion files; explain zero-overlap excludes seen; recall envelope field `top_k`→`returned` (keep `recall_topk` cap as-is). Regression test: generated suggestion readable by recall/touch. |
| F kit-init | `src/cli/commands/kit.ts`, `tests/unit/` | `--force` preserves `.gk.json` user keys (merge before wipe / exclude file); kitVersion warning compares semver → "predates"/"is newer than". Tests both. |
| G viewer-residue | `kits/_core/viewer/` (delete), `kits/claude/viewer/`, `kits/cursor/viewer/` (delete), `scripts/gen-kits.ts`, `kits/_core/skills/gk-visualize/SKILL.md`, `kits/claude/metadata.json`/`kits/cursor/metadata.json` viewer deletions entries (drop), any `*.omp`/`docs` mentions found by grep | remove viewer copies/clauses; gen:kits:check stays green after `bun run gen:kits`. |

## Order
All 7 parallel — disjoint files. Then: `bun run ci:local` once (orchestrator), fix-ups on red, CHANGELOG entry, commit, push → release.
