# GraphKit

GraphKit is an orchestration-graph CLI and Agent Skills system. The `gk` CLI owns workflow state, transitions, leases, checkpoints, and evidence. It does not invoke a model, spawn an agent, or read an API key.

## Install and build

```bash
cd apps/gk
bun install
bun run build
```

Run the CLI from source with `bun run src/index.ts ...`, or use the built `dist/index.js`/`gk` binary.

## Install templates

Install a bundled template into the current project:

```bash
gk template install apps/gk/templates/task-execute-verify
gk template install apps/gk/templates/orchestrator-worker
```

Install globally:

```bash
gk template install apps/gk/templates/task-execute-verify --global
```

Validate before use:

```bash
gk template validate apps/gk/templates/task-execute-verify --json
```

Project installs use `.graphkit/` and `.claude/skills/` in the project. Global installs use the equivalent paths under `$HOME`.

## Run a workflow

Start with one JSON input object:

```bash
gk workflow start apps/gk/templates/task-execute-verify run-1 \
  --inputs '{"task":"ship","objective":"verify"}' --json
```

Ask GraphKit for the next contract:

```bash
gk workflow next apps/gk/templates/task-execute-verify run-1 --json
```

The returned contract is harness-actionable. An agent submits structured output through the returned `submit_argv`:

```bash
gk workflow submit apps/gk/templates/task-execute-verify run-1 \
  '{"summary":"implemented","evidence":[{"key":"tests","value":"pass"}]}' --json
```

GraphKit-owned deterministic nodes use `execute`:

```bash
gk workflow execute apps/gk/templates/task-execute-verify run-1 --json
gk workflow status run-1 --json
gk workflow trace run-1 --json
gk evidence report apps/gk/templates/task-execute-verify run-1 --json
gk workflow graph apps/gk/templates/task-execute-verify run-1 --format mermaid
```

Use `next`, then submit each returned agent or human contract. A human pause resumes with a declared action such as `approve` or `reject`.

## Parallel leases

The `orchestrator-worker` template returns a dispatch contract with one distinct lease per work item and a concurrency ceiling. Submit each item with both identifiers:

```bash
gk workflow submit apps/gk/templates/orchestrator-worker run-2 \
  '{"summary":"done","evidence":[{"key":"tests","value":"pass"}]}' \
  --lease LEASE_ID --work-item ITEM_ID --json
```

Leases are single-use, expiry-bound, and merged only under the template's declared state policy. Duplicate, stale, or mismatched leases fail with a structured error and leave a rejection event.

## Resume and evidence

Runs persist checkpoints and append-only provenance under `.graphkit/runs/<run_id>/`. `workflow status`, `workflow trace`, and `evidence report` reconstruct the run after interruption. Evidence reports retain failed branches, settled work items, deterministic command receipts, and human actions while excluding raw output payloads.

## Explicit boundary

GraphKit is the workflow authority, not an agent runtime or model provider. It never invokes a model, spawns an agent, or reads an API key. An external coding-agent harness performs the returned action; `gk` validates its result, applies the graph transition, and persists the evidence.
