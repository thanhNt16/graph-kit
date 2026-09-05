# Evidence Layer Port — Design Spec


## Decisions (user-selected)

1. **Scope**: Port ideas into GK — artifact evidence store, freshness/fingerprints, criterion model. No execution environments.
2. **Criteria live in a separate registry** (`criteria/<id>.md` at repo root — `.graphkit/` is gitignored so it cannot host tracked sources), referenced by id from graph.yaml; compiler-validated; backward-compatible with bare `required_keys` strings. *(Revised 2026-09-05: switched from in-graph.yaml objects — user decision.)*
3. **Freshness**: report-only by default; graphs opt into `evidence.freshness: strict` where stale required-key evidence BLOCKs the gate.
4. **Artifact submission**: new `gk evidence add` CLI; content-addressed store + provenance markers. No file-convention path for binaries.
5. **Review surface**: criterion-first markdown report + `gk evidence report --html` self-contained page.

## 0. Interface boundary

`gk evidence` becomes a CLI command group: `gk evidence add` (§3) and `gk evidence report [--html]` (§4–5). The `/gk:evidence` kit skill is updated to shell out to `gk evidence report` instead of re-implementing aggregation.

## 1. Criteria schema

```yaml
evidence:
  required_keys: [report, api-response]   # unchanged; bare strings still valid
  criteria: [api-response]                # optional, new — ids resolved from the registry
  freshness: strict                       # optional; "report" (default) | "strict"
```

Registry file `criteria/<id>.md` (one per criterion, id = filename):

```markdown
---
kind: json                                # report (default) | screenshot | json | metrics | text
---
GET /users returns 200, schema-valid body
```

Rules:

- `evidence.criteria` is a list of **ids**; each id MUST appear in `evidence.required_keys` or in some node's `evidence` array — new `gk validate` check `criteria-keys` rejects orphans and duplicate ids.
- Each listed id MUST have a registry file `criteria/<id>.md` — new check `criteria-file` rejects missing files. The file's frontmatter `id` (if present) MUST match its filename.
- `kind` drives rendering only — never gating. Registry body text is the criterion description.
- Bare keys without a criteria entry behave exactly as today (presence-gated `<key>.md`).
- No revision DAG: git history of `criteria/` already records criterion revisions.

Zod (`src/schemas/graph.schema.ts`): `EvidenceSchema` gains optional `criteria: z.array(z.string())` and `freshness: z.enum(["report","strict"]).default("report")`. Registry loading is a new module `src/evidence/criteria.ts`: `loadCriteria(cwd, ids) -> Map<string, { description: string; kind: "report"|"screenshot"|"json"|"metrics"|"text" }>` (missing file → validation finding at `gk validate`; loader itself never throws).

## 2. Fingerprint and freshness

fingerprint(cwd):

- `head`: `git rev-parse HEAD` (null when not a repo or no commits).
- `tree`: sha256 over the sorted list of (path, content-sha256) for dirty tracked files (`git ls-files -m`) plus untracked non-ignored files (`git ls-files -o --exclude-standard`). Cap: files > 1MB contribute path + size + mtime instead of content hash (cheap, avoids big-binary stalls).
- Non-git dir → `{ head: null, tree: null }`.

Recording:

- `gk run start` stamps the run-level fingerprint into the ledger entry.
- `gk evidence add` stamps per-item fingerprint into the marker frontmatter.

Freshness per evidence key: `fresh` (item fingerprint == current `fingerprint(cwd)`), `stale` (both computable, differ), `unknown` (either side null/absent — never fabricated as fresh). Stale ≠ missing ≠ failed.

Gate behavior:

- Default (`report`): freshness displayed in scorecard/status/report; verdict logic unchanged.
- `strict`: any stale **required** key ⇒ verdict `BLOCK`, reason `stale-evidence`. `unknown` NEVER blocks.

## 3. `gk evidence add`

```
gk evidence add <file> --key <k> [--node <n>] [--note <text>] [--json]
```

Behavior:

1. Validate key: declared in `evidence.required_keys` OR produced by some node (`nodes.<id>.evidence`). Else `EVIDENCE_KEY_NOT_DECLARED` (exit 1).
2. Validate file exists and is readable (`EVIDENCE_FILE_MISSING`); size ≤ 10MB default (`EVIDENCE_TOO_LARGE`). Limit configurable via `.gk.json` `evidence_max_bytes` — user-set, not agent-set.
3. Copy artifact to `.graphkit/evidence/<key>/<sha256>.<ext>` — content-addressed; existing hash ⇒ no-op reuse.
4. Write/refresh marker `.graphkit/evidence/<key>.md` with YAML frontmatter — this preserves the existing gate/eval/resume contract (presence of `<key>.md` non-whitespace):
   ```yaml
   ---
   key: api-response
   run_id: <active run or null>
   node: <n or null>
   fingerprint_head: <sha|null>
   fingerprint_tree: <sha|null>
   artifact: api-response/<sha256>.json
   artifact_sha256: <sha256>
   bytes: 8123
   ts: 2026-09-05T09:00:00.000Z
   note: <optional text>
   ---
   <marker body: one-line description>
   ```
5. Append index entry to `.graphkit/evidence/.index` (existing index format, extended fields).

Markers from the legacy convention (no frontmatter) remain valid: freshness `unknown`.

## 4. Gate / status / report integration

- `gateGraph(required_keys, evidenceDir)` (src/cli/commands/gate.ts path) extends per-key scorecard entries to `{ status: present|missing, freshness: fresh|stale|unknown }`. `scoreWorkProduct` consumes the extended map; verdict unchanged except strict rule in §2.
- `gk status`: human output adds freshness column; `--json` adds `freshness` per coverage row.
- `gk evidence` report (kit skill + aggregation): criterion-first sections — description, kind, badge `● present / ○ missing / ◐ stale / ? unknown`, artifact path, provenance line (run, node, fingerprint head, timestamp). Bare keys render as today. Verdict line unchanged (plus stale reason when strict BLOCKs).

## 5. `gk evidence report --html`

- Writes self-contained `.graphkit/reports/{name}-evidence.html`.
- Criterion cards with badges, artifact previews, provenance footers.
- Security rules (renderer hardening, judge-informed):
  - `screenshot` kind: base64 `<img>` embed; **SVG refused** (script-capable) — renders as download link.
  - `json` / `text` / `metrics` / `report`: HTML-escaped `<pre>` only. JSON pretty-printed after `JSON.parse` round-trip (structural safety).
  - Unknown/other kinds: relative download link (`file://` sibling path), never inlined.
  - Zero JavaScript in the page. All content inserted as escaped text or `<img>` data URIs.

## 6. Errors and edge cases

| Code | Trigger | Behavior |
|---|---|---|
| `EVIDENCE_KEY_NOT_DECLARED` | key not required nor node-produced | exit 1, nothing written |
| `EVIDENCE_FILE_MISSING` | path absent/unreadable | exit 1 |
| `EVIDENCE_TOO_LARGE` | artifact > limit | exit 1 |
| fingerprint failure | no git / odd tree | degrade to `unknown`; never fail a run |

- Resume interplay: child-run evidence re-stamped by fresh `gk evidence add` calls ⇒ replays fresh by construction. Satisfied keys replayed as refs keep their original markers — freshness computed against them as-is.
- Concurrent `evidence add` for same key: content-addressing makes artifact writes idempotent; marker write is last-writer-wins (single-agent CLI usage; acceptable).

## 7. Tests (behavior contracts)

1. Fingerprint stability: identical tree → identical fingerprint; touching a tracked file → `stale`; non-git dir → `unknown`.
2. Strict gate: stale required key BLOCKs; `unknown` never blocks; default mode reports but MERGEs.
3. Marker round-trip: legacy marker (no frontmatter) still passes old gate; new marker passes old gate (body non-whitespace).
4. `EVIDENCE_KEY_NOT_DECLARED` / `_MISSING` / `_TOO_LARGE` exit 1 with codes, no partial writes.
5. `criteria-keys` + `criteria-file` validation: orphan id, duplicate id, missing registry file rejected; valid id-with-file passes. `loadCriteria` round-trip: kind default, body → description.
6. HTML escaping: artifact containing `<script>alert(1)</script>` renders escaped; SVG screenshot refused inline.
7. Content-addressing: same file added twice → one artifact blob, marker updated.

## Non-goals

No retention/expiry/pinning, no criteria-revision DAG, no secrets masking, no Docker/execution environments, no MCP surface, no ticket-tracker sync, no background service.

## References

- Judge outputs: `agent://JudgeProduct`, `agent://JudgeArch`, `agent://JudgeSecurity`, `agent://JudgeAgentDX`
- PRD under review: `.graphkit/runport-prd.md`
- Existing contracts: `src/schemas/graph.schema.ts` (EvidenceSchema), `src/cli/commands/gate.ts` (gateGraph), `src/memory/resume.ts` (required_keys filtering), kits `gk-evidence`/`gk-eval` skills.
