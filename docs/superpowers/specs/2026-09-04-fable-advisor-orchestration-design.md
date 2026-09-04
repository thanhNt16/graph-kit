# Advisor Mode & Fable-Orchestration — Design

Date: 2026-09-04
Status: approved design (brainstorm complete), pending implementation plan
Approach: B — ledger-integrated graph primitive (compiler-surface + run-ledger audit + memory pattern)

## Problem

Two orchestration gaps:

1. **Advisor mode.** A cheap node (sonnet) loops on work via `loop`, fails repeatedly, and burns all `max_rounds` with no way to get help. The run ends failed even though one consultation with a frontier tier (fable/opus) could unblock it.
2. **Fable-orchestration.** No way for a frontier planner to decompose work at runtime into N briefs executed by cheap workers. gk forbids runtime topology mutation (graph-authority rule), so classic orchestrator-workers fan-out has no expression.

Research (2026-09-04, scout briefs): neither term is canonical. Nearest named patterns — Anthropic orchestrator-workers/routing/evaluator-optimizer; FrugalGPT/RouteLLM/AutoMix cascades (cheap-first, escalate on failure/confidence); aider architect/editor. No surveyed framework ships automatic stuck→advisor escalation. We define both as graph primitives.

## Non-goals

- Tier-swap escalation (re-dispatching a node at the advisor's model).
- Escalation budgets/cooldowns beyond `advisor.max_calls` + `loop.max_rounds`.
- Per-host model policy engine (`gk models`).
- Runtime edge/topology mutation. Briefs are data, not edges.
- New model tiers. `fable` already exists in the tier enum.

## Decisions (user-approved)

| Fork | Decision |
|---|---|
| Surface | Graph primitive (node-level graph.yaml config), not topology preset or docs-only |
| Stuck trigger | Mechanical failure-streak derived from existing loop round counting |
| Post-advice control | Advice appended to objective; SAME node re-dispatched at original tier; advisor is read-only |
| Fable-orchestration shape | Advisor primitive + dynamic fan-out: planner writes briefs, worker fans out host subagents in-node |
| Fan-out execution | Parallel subagents inside the worker node (existing wave-barrier machinery) |

## §1 Schema (`src/schemas/graph.schema.ts`)

Node gains two optional objects.

```yaml
nodes:
  plan:
    model: fable
  implement:
    model: sonnet
    loop: {enabled: true, max_rounds: 6}
    advisor:
      model: fable            # tier enum; default fable
      after_failed_rounds: 2  # fire when a round fails and streak >= this; default 1
      max_calls: 1            # per run; default 1
  execute:
    model: sonnet
    fan_out:
      briefs_from: plan       # upstream node id (must be a reachable predecessor)
      template: "Implement {brief.title}: {brief.body}"  # optional; default "{brief.body}"
```

**Briefs contract.** The planner node writes `briefs.json` — a JSON array of `{id, title, body}` — into its evidence directory. The worker's dispatch reads it. Array may be empty (worker reports "no briefs" as its output; not an error).

**Composition.** `advisor` and `fan_out` on the same node: allowed, orthogonal.

## §2 Validation

Same file + existing command surface. Errors follow existing cross-node error format.

- `advisor.model` ∈ tier enum (`opus|sonnet|haiku|fable`).
- `advisor.after_failed_rounds ≥ 1`, `advisor.max_calls ≥ 1`.
- `advisor` requires `loop.enabled: true` on the same node — the streak is defined over failed rounds; without a loop there is no streak. Error otherwise.
- `fan_out.briefs_from` must name an existing node that is a reachable predecessor (upstream in topological order).
- `fan_out.template`, if present, must be non-empty string; `{brief.title}` / `{brief.body}` placeholders optional.

## §3 Waves payload

Compiler passes `advisor` / `fan_out` through verbatim on the node object in the waves payload. No new payload shape. Host skills read the same node object they already consume.

## §4 Execute-skill mechanics (5 kit mirrors)

Enforcement is asymmetric today and stays asymmetric: prompt-advisory on claude/codex/cursor/opencode; mechanical on pi where node config already maps to `constraints` (advisor subagent gets `no_write: true`).

**Advisor loop.**

1. A round fails (unmet `stop_when`, non-zero exit, or failure evidence) → streak +1.
2. streak ≥ `after_failed_rounds` AND advisor calls < `max_calls` → execute-skill dispatches an advisor subagent:
   - read-only (`no_write` on pi; "do not edit" in prompt elsewhere),
   - `model: fable` (or configured tier),
   - input = node objective + last round's output + failure evidence,
   - same host-dispatch mechanism as node agents. The gk CLI never invokes a model.
3. Advice is appended to the node's objective as an `## Advisor guidance` section. Node re-dispatches at its original tier.
4. `max_calls` reached or `max_rounds` reached → existing failure path. No new states.

**Fan-out.**

1. Worker node reads `briefs.json` from the planner's evidence.
2. Dispatches one parallel host subagent per brief (wave-barrier machinery /gk:execute already uses). Brief text = `fan_out.template` rendered per brief, default `{brief.body}`.
3. Worker consolidates subagent outputs/summaries into its own evidence and output. Subagent failure marks the round failed (normal loop semantics apply; advisor may then fire).

## §5 Ledger + memory

**Run ledger.**

- `gk run node --advisor-fired <round>` appends `{type:"advisor", node, round, tier, streak}` to `trace.jsonl`. Called by the execute-skill at dispatch time.
- `gk run status` counts advisor events and prints an escalation summary.

**Memory (`src/memory`, consolidate command).**

- New pattern type `advisor-repeat`: node consumed advisor calls in ≥2 consecutive runs.
- Suggestion text: "raise `{node}` model tier or loosen its stop_when" (existing suggestion machinery).

## §6 Tests + docs

**Unit** (extend existing suites):
- schema: accepts valid `advisor`/`fan_out`; rejects bad tier, zero thresholds, advisor-without-loop, dangling/non-upstream `briefs_from`.
- compiler: payload passthrough verbatim.
- ledger: `--advisor-fired` event shape; status count.
- memory: consolidate produces `advisor-repeat` pattern + suggestion.

**E2E smoke** (temp dir, never inside graph-kit): graph with planner→fan-out worker with advisor; assert briefs fan-out evidence, advisor trace events, status summary.

**Docs**: README §Execution contracts (advisor + fan_out paragraphs), CLI reference (`--advisor-fired`), CHANGELOG entry.

## Risks

- **Advisory-only enforcement off-pi.** Same asymmetry as `stop_when`; ledger events at least make non-compliance visible post-hoc (missing advisor events on failed streaks).
- **Advisor advice quality.** Bounded by `max_calls`; a bad hint costs one round. Evidence-first advisor input (objective + output + failure evidence) is the mitigation.
- **Brief format drift.** Planner writes malformed `briefs.json` → worker round fails with parse error → loop/advisor machinery catches it like any failure. No special casing.
