# `gk visualize` → Archify Workflow IR Bridge — Design

**Date:** 2026-08-29
**Status:** Approved (chat design), pending implementation
**Approach:** B — pure IR emitter + optional `--render` passthrough

## Goal

Fill the existing `gk visualize` NOT_IMPLEMENTED stub: convert a `graph.yaml`
into [archify](https://github.com/tt-a1i/archify) typed workflow IR
(`schema_version: 1`, `diagram_type: "workflow"`), deterministically, with
zero new npm dependencies. Rendering stays archify's job (its CLI or the
vendored skill); `gk visualize` optionally shells out when archify is on PATH.

## Command surface

```
gk visualize [file] --out <dir> [--render] [--json]
```

- `file` resolution: explicit path → newest `.graphkit/graphs/*.yaml` →
  `./graph.yaml` (same order as `gk graph` subcommands).
- Default action: write `<dir>/<name>.workflow.json` (dir defaults `.`),
  print `{ok: true, ir: <path>}`.
- `--render`: after writing IR, locate archify CLI: `GK_ARCHIFY_PATH` env →
  `archify/bin/archify.mjs` (cwd) → `~/.claude/skills/archify/bin/archify.mjs` →
  `~/.agents/skills/archify/bin/archify.mjs`. If found, exec
  `node <path> render <ir> --out <dir>` producing `.html`.
  Not found → `ARCHIFY_NOT_FOUND` fail with install hint
  (`npx skills add tt-a1i/archify -g`), exit 1.
- archify render exits non-zero → pass stderr through verbatim, exit with its code.

## IR mapping (deterministic)

| graph.yaml | archify workflow IR |
|---|---|
| `metadata.name` | `meta.title` |
| Kahn wave index (local ~15-line fn; curator interleave irrelevant for visuals — intentionally NOT the one in `graph.ts` `waves`) | node `col` |
| distinct `agent` values | `lanes[]` (id = kebab agent, label = agent) |
| node | `{id, lane, col, label: node id, sublabel: role, tag: model}` |
| `depend_on` pair | `{id: "<dep>--<id>", from, to, variant: "default"}` |
| longest dependency chain | `mainPath` |
| `loops[]` group | `views[]`: `{id: loop id, label: "Loop: <id>", focus: loop nodes, note: stop_when}` — loops are execution semantics; no invented retry edges |
| `topology`, wave count | one card: "N nodes · M waves · topology" |

Fixed fields: `meta.quality_profile: "standard"`, `schema_version: 1`,
`diagram_type: "workflow"`. No geometry hints (`fromSide`/`labelAt`/…) —
renderer-owned layout stays deterministic.

## Error handling

- Invalid YAML / schema violations → `INVALID_GRAPH` with zod issue paths
  (reuse `GraphSchema.parse`, consistent with `gk validate`).
- Dependency cycle → `CYCLE_DETECTED` listing unresolved nodes.
- archify render failure → passthrough, exit code preserved.

## Testing

- Unit: golden fixtures — `diamond` fixture; `custom` fixture with loops +
  multi-agent lanes. Assert lanes, cols = waves, edges = deps, mainPath, loop views.
- Cycle detection: a→b→a → `CYCLE_DETECTED`.
- `--render`: single integration test, skipped when `archify.mjs` absent
  (mirrors CBM-parity skip convention).
- `command-registry.ts` description drops "(not yet implemented)".

## Docs

- CHANGELOG under `[Unreleased]`.
- `docs/templates-and-viewer.md` + pages report: short section.

## Non-goals

- No vendoring of archify into kits.
- No new npm dependencies.
- No geometry authoring — renderer owns layout.
- `graph.yaml` untouched (read-only consumer).
