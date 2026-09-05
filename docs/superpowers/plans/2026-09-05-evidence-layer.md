# Evidence Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port RunPort's evidence model into GK — criteria registry (`criteria/<id>.md`) referenced from graph.yaml, git fingerprints with freshness states, `gk evidence add` content-addressed artifact store, strict-mode gate, criterion-first report + self-contained HTML page.

**Architecture:** Marker-file compatibility trick — `gk evidence add` stores artifacts content-addressed under `.graphkit/evidence/<key>/<sha256>.<ext>` but the gate/eval/resume contract stays "presence of non-whitespace `<key>.md`" (ADR-002), so every existing consumer is untouched. New `src/evidence/` module owns fingerprint/marker/store/report; CLI command group `gk evidence` (add, report) wires it. Gate gains a per-key freshness map; `evidence.freshness: strict` turns stale required keys into BLOCK.

**Tech Stack:** TypeScript (Bun runtime, tsc strict), Zod schemas, `yaml` package, `cac` CLI, `bun:test`. No new dependencies.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-09-05-evidence-layer-design.md` — authoritative for behavior.
- Zero-runtime rule: gk never spawns models, never reads API keys. Only new subprocess use is `git` (read-only queries) in `src/evidence/fingerprint.ts`.
- Evidence key → file contract (ADR-002, `src/cli/commands/gate.ts` header comment): required key `k` maps to `<evidenceDir>/<k>.md`; satisfied iff file exists and is non-whitespace. MUST NOT change.
- `freshness: unknown` NEVER blocks a gate verdict. Only `strict` + stale + required key blocks.
- Errors exit 1 with JSON envelope via `fail(code, message, details)` from `src/cli/output.ts`. New codes: `EVIDENCE_KEY_NOT_DECLARED`, `EVIDENCE_FILE_MISSING`, `EVIDENCE_TOO_LARGE`, `UNKNOWN_EVIDENCE_SUBCOMMAND`.
- CLI surface: every new leaf must be added to `CLI_COMMANDS` in `src/cli/command-registry.ts`, `cli-manifest.json` at repo root (hand-maintained, no generator), registered in `src/index.ts`, and `scripts/check-cli-parity.ts` `UNKNOWN_CODES` must gain `UNKNOWN_EVIDENCE_SUBCOMMAND`.
- Do not edit `.omp/` or `src/eval/**` beyond imports already used (rubrics unchanged).
- Commit convention: conventional commits (`feat:`, `fix:`, `docs:`). Run `bun run ci:local` before the final commit of each task if cheap; MUST run it in Task 8.
- Tests: `bun:test`, tmp dirs under `os.tmpdir()`, cleanup in `afterEach`. Follow `tests/unit/gate.test.ts` patterns (`runCli` helper with `cac` + captured `console.log` + stubbed `process.exit`).

---

### Task 1: Criteria registry schema + loader + validation

**Files:**
- Modify: `src/schemas/graph.schema.ts` (EvidenceSchema, ~line 82)
- Create: `src/evidence/criteria.ts` (registry loader)
- Modify: `src/compiler/validate.ts` (new checks after evidence coverage, ~line 113)
- Test: `tests/unit/evidence-criteria.test.ts` (create)

**Interfaces:**
- Produces (schema): `graph.evidence.criteria?: string[]` (registry ids) and `graph.evidence.freshness: "report"|"strict"` (default `"report"`) on the parsed `Graph`.
- Produces (loader, `src/evidence/criteria.ts`):
```ts
export type CriterionKind = "report" | "screenshot" | "json" | "metrics" | "text";
export interface Criterion { id: string; description: string; kind: CriterionKind }
export function loadCriteria(cwd: string, ids: string[]): Map<string, Criterion>
```
  Reads `criteria/<id>.md` (frontmatter `kind`, optional frontmatter `id`, body = description). Never throws — an unreadable/missing file maps to `{ id, description: "", kind: "report" }`; `gk validate` is the layer that reports it (check `criteria-file`).
- Registry file contract: `criteria/<id>.md` at repo root (git-tracked; `.graphkit/` is gitignored so it cannot host sources). Later tasks (report) consume `loadCriteria` with exactly this signature.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/evidence-criteria.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { loadCriteria } from "../../src/evidence/criteria.js";
import { GraphSchema } from "../../src/schemas/graph.schema.js";
import { validateGraph } from "../../src/compiler/validate.js";

let cwd: string;
beforeEach(() => {
  cwd = join(tmpdir(), `gk-crit-${process.pid}-${Date.now()}`);
  mkdirSync(join(cwd, "criteria"), { recursive: true });
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

function graphObj(ev: unknown) {
  return {
    apiVersion: "graphkit.dev/v2", kind: "Graph", metadata: { name: "t" }, topology: "diamond",
    nodes: { probe: { agent: "a", objective: "o", depend_on: [], evidence: ["api-response"] } },
    evidence: ev,
  };
}
function parseGraph(ev: unknown) {
  return GraphSchema.parse(graphObj(ev));
}

describe("criteria schema + validation", () => {
  test("criteria is an id list; freshness defaults to report", () => {
    const g = parseGraph({ required_keys: ["api-response"], criteria: ["api-response"], freshness: "strict" });
    expect(g.evidence.criteria).toEqual(["api-response"]);
    expect(g.evidence.freshness).toBe("strict");
    expect(parseGraph({ required_keys: ["api-response"] }).evidence.freshness).toBe("report");
  });

  test("rejects object entries and bad freshness", () => {
    expect(GraphSchema.safeParse(graphObj({ required_keys: ["api-response"], criteria: [{ id: "api-response" }] })).success).toBe(false);
    expect(GraphSchema.safeParse(graphObj({ required_keys: ["api-response"], freshness: "always" })).success).toBe(false);
  });

  test("criteria-keys rejects orphans and duplicates", () => {
    const orphan = parseGraph({ required_keys: ["api-response"], criteria: ["nope"] });
    expect(validateGraph(orphan, cwd).some((f) => f.check === "criteria-keys" && f.message.includes("nope"))).toBe(true);
    const dup = parseGraph({ required_keys: ["api-response"], criteria: ["api-response", "api-response"] });
    expect(validateGraph(dup, cwd).some((f) => f.check === "criteria-keys" && f.message.includes("Duplicate"))).toBe(true);
  });

  test("criteria-file rejects missing registry file and id mismatch", () => {
    writeFileSync(join(cwd, "criteria", "api-response.md"), "---\nkind: json\n---\nGET /users returns 200\n");
    const okGraph = parseGraph({ required_keys: ["api-response"], criteria: ["api-response"] });
    expect(validateGraph(okGraph, cwd).filter((f) => f.check === "criteria-file" || f.check === "criteria-keys")).toEqual([]);

    const missing = parseGraph({ required_keys: ["api-response"], criteria: ["api-response"] });
    rmSync(join(cwd, "criteria", "api-response.md"));
    expect(validateGraph(missing, cwd).some((f) => f.check === "criteria-file" && f.message.includes("api-response"))).toBe(true);

    writeFileSync(join(cwd, "criteria", "api-response.md"), "---\nid: other\nkind: json\n---\nbody\n");
    expect(validateGraph(missing, cwd).some((f) => f.check === "criteria-file" && f.message.includes("id"))).toBe(true);
  });

  test("loadCriteria: kind default, body is description, never throws", () => {
    writeFileSync(join(cwd, "criteria", "a.md"), "---\nkind: screenshot\n---\nshot of the thing\n");
    writeFileSync(join(cwd, "criteria", "b.md"), "just a body\n");
    const m = loadCriteria(cwd, ["a", "b", "missing"]);
    expect(m.get("a")).toEqual({ id: "a", description: "shot of the thing", kind: "screenshot" });
    expect(m.get("b")).toEqual({ id: "b", description: "just a body", kind: "report" });
    expect(m.get("missing")).toEqual({ id: "missing", description: "", kind: "report" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/evidence-criteria.test.ts`
Expected: FAIL — object-form `criteria` rejected by schema, loader and checks do not exist.

- [ ] **Step 3: Implement**

In `src/schemas/graph.schema.ts`, replace the `EvidenceSchema` block (lines 82-85) with:

```ts
const EvidenceSchema = z.object({
  required_keys: z.array(z.string()),
  format: z.enum(["markdown", "json"]).default("markdown"),
  criteria: z.array(z.string()).optional(),
  freshness: z.enum(["report", "strict"]).default("report"),
});
```

Create `src/evidence/criteria.ts`:

```ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";

export type CriterionKind = "report" | "screenshot" | "json" | "metrics" | "text";
export interface Criterion { id: string; description: string; kind: CriterionKind }
const KINDS: CriterionKind[] = ["report", "screenshot", "json", "metrics", "text"];

/** Load criterion registry entries by id. Never throws - validation reports missing files. */
export function loadCriteria(cwd: string, ids: string[]): Map<string, Criterion> {
  const out = new Map<string, Criterion>();
  for (const id of ids) {
    const p = join(cwd, "criteria", `${id}.md`);
    if (!existsSync(p)) {
      out.set(id, { id, description: "", kind: "report" });
      continue;
    }
    let fm: Record<string, unknown> = {};
    let body = readFileSync(p, "utf-8");
    const m = body.match(/^---\n([\s\S]*?)\n---\n?/);
    if (m) {
      try { fm = (YAML.parse(m[1]) ?? {}) as Record<string, unknown>; } catch { fm = {}; }
      body = body.slice(m[0].length);
    }
    const kind = KINDS.includes(fm.kind as CriterionKind) ? (fm.kind as CriterionKind) : "report";
    out.set(id, { id, description: body.trim(), kind });
  }
  return out;
}
```

In `src/compiler/validate.ts`, immediately after the evidence-coverage loop (after line 113, before check 6), insert:

```ts
  // 5b. criteria: ids must be declared keys, unique, and backed by registry files
  const criteriaIds = graph.evidence.criteria ?? [];
  const seenCriteria = new Set<string>();
  for (const id of criteriaIds) {
    if (!produced.has(id) && !graph.evidence.required_keys.includes(id)) {
      findings.push({
        check: "criteria-keys",
        path: "evidence.criteria",
        message: `Criterion "${id}" is not a required key nor produced by any node`,
      });
    }
    if (seenCriteria.has(id)) {
      findings.push({
        check: "criteria-keys",
        path: "evidence.criteria",
        message: `Duplicate criterion id "${id}"`,
      });
    }
    seenCriteria.add(id);
    const file = join(cwd, "criteria", `${id}.md`);
    if (!existsSync(file)) {
      findings.push({
        check: "criteria-file",
        path: "evidence.criteria",
        message: `Criterion "${id}" has no registry file at criteria/${id}.md`,
      });
    } else {
      const head = readFileSync(file, "utf-8").match(/^---\n([\s\S]*?)\n---/);
      const fmId = head ? (YAML.parse(head[1]) ?? {}).id : undefined;
      if (fmId !== undefined && fmId !== id) {
        findings.push({
          check: "criteria-file",
          path: `criteria/${id}.md`,
          message: `Registry file frontmatter id "${fmId}" does not match filename "${id}"`,
        });
      }
    }
  }
```

Import `existsSync`/`readFileSync` from `node:fs`, `join` from `node:path`, and `YAML` in `validate.ts` if not already imported (`produced` is the `Set` from check 5; use the same directory argument `validateGraph` already receives for path resolution).

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/evidence-criteria.test.ts tests/unit/compiler.test.ts`
Expected: PASS (new file 5 tests; compiler suite unchanged - optional `criteria` and defaulted `freshness` are additive).

- [ ] **Step 5: Commit**

```bash
git add src/schemas/graph.schema.ts src/evidence/criteria.ts src/compiler/validate.ts tests/unit/evidence-criteria.test.ts
git commit -m "feat(criteria): criteria/ registry - id list in graph.yaml, loader, criteria-keys/file validation"
```

### Task 2: Fingerprint module

**Files:**
- Create: `src/evidence/fingerprint.ts`
- Test: `tests/unit/fingerprint.test.ts`

**Interfaces:**
- Produces:
```ts
export interface Fingerprint { head: string | null; tree: string | null }
export function fingerprint(cwd: string): Fingerprint
```
  Semantics: `head` = `git rev-parse HEAD` (null: not a repo / no commits / git missing). `tree` = sha256 over sorted `"<relpath>:<contenthash>"` lines for dirty tracked (`git ls-files -m`) + untracked non-ignored (`git ls-files -o --exclude-standard`) files; files > 1 MiB contribute `size:<bytes>:mtime:<floor ms>` instead of content hash. Non-git → `{ head: null, tree: null }`. Never throws.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/fingerprint.test.ts
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fingerprint } from "../../src/evidence/fingerprint.js";

const dirs: string[] = [];
function mk(): string {
  const d = join(tmpdir(), `gk-fp-${process.pid}-${Date.now()}-${dirs.length}`);
  mkdirSync(d, { recursive: true });
  dirs.push(d);
  return d;
}
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

describe("fingerprint", () => {
  test("non-git dir → nulls", () => {
    expect(fingerprint(mk())).toEqual({ head: null, tree: null });
  });

  test("stable across calls; commit moves head; edit moves tree", () => {
    const d = mk();
    const git = (cmd: string) => execSync(cmd, { cwd: d, stdio: "ignore" });
    git('git init -q && git config user.email t@t && git config user.name t');
    writeFileSync(join(d, "a.txt"), "one\n");
    git("git add -A && git commit -qm one");

    const f1 = fingerprint(d);
    const f2 = fingerprint(d);
    expect(f1.head).toMatch(/^[0-9a-f]{40}$/);
    expect(f2).toEqual(f1); // clean tree → same fingerprint twice

    git("git commit -q --allow-empty -m two");
    expect(fingerprint(d).head).not.toBe(f1.head); // head moved

    appendFileSync(join(d, "a.txt"), "two\n");
    const dirty = fingerprint(d);
    expect(dirty.head).toBe(fingerprint(d).head);
    expect(dirty.tree).not.toBeNull(); // dirty file hashed into tree
    expect(fingerprint(d)).toEqual(dirty); // deterministic
  });

  test("untracked file enters tree", () => {
    const d = mk();
    const git = (cmd: string) => execSync(cmd, { cwd: d, stdio: "ignore" });
    git('git init -q && git config user.email t@t && git config user.name t && git commit -q --allow-empty -m e');
    const before = fingerprint(d);
    writeFileSync(join(d, "u.txt"), "u\n");
    const after = fingerprint(d);
    expect(after.tree).not.toBe(before.tree);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/fingerprint.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/evidence/fingerprint.ts
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface Fingerprint {
  head: string | null;
  tree: string | null;
}

function git(args: string[], cwd: string): string | null {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0 || !r.stdout) return null;
  return r.stdout.trim();
}

/** Files > 1 MiB contribute size+mtime, not content — cheap on big binaries. */
const HASH_CAP_BYTES = 1024 * 1024;

export function fingerprint(cwd: string): Fingerprint {
  const head = git(["rev-parse", "HEAD"], cwd);
  if (head === null) return { head: null, tree: null };
  const changed = git(["ls-files", "-m"], cwd)?.split("\n").filter(Boolean) ?? [];
  const untracked = git(["ls-files", "-o", "--exclude-standard"], cwd)?.split("\n").filter(Boolean) ?? [];
  const lines: string[] = [];
  for (const rel of [...new Set([...changed, ...untracked])].sort()) {
    const p = join(cwd, rel);
    try {
      const st = statSync(p);
      const h =
        st.size > HASH_CAP_BYTES
          ? `size:${st.size}:mtime:${Math.floor(st.mtimeMs)}`
          : createHash("sha256").update(readFileSync(p)).digest("hex");
      lines.push(`${rel}:${h}`);
    } catch {
      continue; // file vanished between listing and hashing — skip, never throw
    }
  }
  return { head, tree: createHash("sha256").update(lines.join("\n")).digest("hex") };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/fingerprint.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/evidence/fingerprint.ts tests/unit/fingerprint.test.ts
git commit -m "feat(evidence): git fingerprint (HEAD + dirty/untracked content manifest)"
```

---

### Task 3: Marker parsing + freshness state

**Files:**
- Create: `src/evidence/marker.ts`
- Test: `tests/unit/marker.test.ts`

**Interfaces:**
- Consumes: `Fingerprint` from Task 2.
- Produces:
```ts
export type Freshness = "fresh" | "stale" | "unknown";
export interface MarkerMeta {
  key: string; run_id: string | null; node: string | null;
  fingerprint_head: string | null; fingerprint_tree: string | null;
  artifact: string | null; artifact_sha256: string | null;
  bytes: number | null; ts: string | null; note: string | null;
}
export function parseMarker(content: string): MarkerMeta | null   // null = no frontmatter (legacy marker)
export function freshnessOf(item: { fingerprint_head: string | null; fingerprint_tree: string | null } | null, cur: Fingerprint): Freshness
export function renderMarker(meta: MarkerMeta, body: string): string  // inverse of parseMarker
```

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/marker.test.ts
import { describe, expect, test } from "bun:test";
import { freshnessOf, parseMarker, renderMarker, type MarkerMeta } from "../../src/evidence/marker.js";

const meta: MarkerMeta = {
  key: "api-response", run_id: "20260905-090000-g", node: "probe",
  fingerprint_head: "a".repeat(40), fingerprint_tree: "b".repeat(64),
  artifact: "api-response/abc.json", artifact_sha256: "c".repeat(64),
  bytes: 8123, ts: "2026-09-05T09:00:00.000Z", note: "n",
};

describe("marker", () => {
  test("round-trips frontmatter", () => {
    const md = renderMarker(meta, "Evidence artifact \"api-response\" recorded.");
    expect(parseMarker(md)).toEqual(meta);
  });

  test("legacy marker (no frontmatter) parses to null", () => {
    expect(parseMarker("# Just markdown\n")).toBeNull();
  });

  test("freshness: fresh / stale / unknown", () => {
    const cur = { head: "a".repeat(40), tree: "b".repeat(64) };
    expect(freshnessOf(meta, cur)).toBe("fresh");
    expect(freshnessOf({ ...meta, fingerprint_tree: null }, cur)).toBe("unknown"); // missing tree field
    expect(freshnessOf(meta, { head: "z".repeat(40), tree: "b".repeat(64) })).toBe("stale");
    expect(freshnessOf(meta, { head: null, tree: null })).toBe("unknown"); // non-git cwd
    expect(freshnessOf(null, cur)).toBe("unknown"); // legacy marker
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/marker.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/evidence/marker.ts
import YAML from "yaml";
import type { Fingerprint } from "./fingerprint.js";

export type Freshness = "fresh" | "stale" | "unknown";

export interface MarkerMeta {
  key: string;
  run_id: string | null;
  node: string | null;
  fingerprint_head: string | null;
  fingerprint_tree: string | null;
  artifact: string | null;
  artifact_sha256: string | null;
  bytes: number | null;
  ts: string | null;
  note: string | null;
}

const KEYS = ["key", "run_id", "node", "fingerprint_head", "fingerprint_tree", "artifact", "artifact_sha256", "bytes", "ts", "note"] as const;

export function renderMarker(meta: MarkerMeta, body: string): string {
  const fm = KEYS.filter((k) => meta[k] !== null && meta[k] !== undefined)
    .map((k) => `${k}: ${typeof meta[k] === "number" || typeof meta[k] === "string" ? String(meta[k]) : JSON.stringify(meta[k])}`)
    .join("\n");
  return `---\n${fm}\n---\n\n${body}\n`;
}

export function parseMarker(content: string): MarkerMeta | null {
  const m = content.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  let raw: Record<string, unknown>;
  try {
    raw = (YAML.parse(m[1]) ?? {}) as Record<string, unknown>;
  } catch {
    return null;
  }
  const s = (v: unknown) => (v === undefined || v === null ? null : String(v));
  return {
    key: s(raw.key) ?? "",
    run_id: s(raw.run_id), node: s(raw.node),
    fingerprint_head: s(raw.fingerprint_head), fingerprint_tree: s(raw.fingerprint_tree),
    artifact: s(raw.artifact), artifact_sha256: s(raw.artifact_sha256),
    bytes: typeof raw.bytes === "number" ? raw.bytes : s(raw.bytes) === null ? null : Number(raw.bytes),
    ts: s(raw.ts), note: s(raw.note),
  };
}

export function freshnessOf(
  item: { fingerprint_head: string | null; fingerprint_tree: string | null } | null,
  cur: Fingerprint,
): Freshness {
  if (!item?.fingerprint_head || !item.fingerprint_tree || !cur.head || !cur.tree) return "unknown";
  return item.fingerprint_head === cur.head && item.fingerprint_tree === cur.tree ? "fresh" : "stale";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/marker.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/evidence/marker.ts tests/unit/marker.test.ts
git commit -m "feat(evidence): marker frontmatter parse/render + freshness states"
```

---

### Task 4: Content-addressed evidence store (`addEvidence`)

**Files:**
- Create: `src/evidence/store.ts`
- Test: `tests/unit/evidence-store.test.ts`

**Interfaces:**
- Consumes: `fingerprint` (Task 2), `MarkerMeta`/`renderMarker` (Task 3), `GraphSchema`/`Graph` from `src/schemas/graph.schema.js`, `activeRun` from `src/memory/ledger.js`, `GraphKitError` from `src/errors.js`.
- Produces:
```ts
export const DEFAULT_MAX_BYTES: number // 10 * 1024 * 1024
export function maxBytesFromConfig(cwd: string): number  // reads .gk.json evidence_max_bytes (number > 0), else DEFAULT_MAX_BYTES
export function addEvidence(cwd: string, graph: Graph, opts: {
  file: string; key: string; node?: string; note?: string; maxBytes?: number;
}): { key: string; artifact: string; sha256: string; bytes: number }
```
  Behavior: throws `GraphKitError` with codes `EVIDENCE_KEY_NOT_DECLARED` (key ∉ required_keys ∪ node-produced), `EVIDENCE_FILE_MISSING`, `EVIDENCE_TOO_LARGE`. Writes `<evidenceDir>/<key>/<sha256><ext>` (no overwrite if hash exists), marker `<key>.md` (frontmatter from Task 3 + body `Evidence artifact "<key>" recorded <ts>.`), appends one JSONL line to `<evidenceDir>/.index`: `{"file":"<abs marker path>","at":"<ts>","key":...,"node":...|null,"artifact":...,"sha256":...}` — same line shape the kit hooks write (`kits/*/hooks/evidence-persist.cjs`), extended with provenance fields. `evidenceDir = join(cwd, graph.outputs.evidence_dir)`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/evidence-store.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import YAML from "yaml";
import { addEvidence, DEFAULT_MAX_BYTES, maxBytesFromConfig } from "../../src/evidence/store.js";
import { GraphSchema } from "../../src/schemas/graph.schema.js";

let cwd: string;
const graphYaml = `apiVersion: graphkit.dev/v2
kind: Graph
metadata:
  name: t
topology: diamond
nodes:
  probe:
    agent: a
    objective: o
    depend_on: []
    evidence: [api-response]
evidence:
  required_keys: [api-response]
`;

beforeEach(() => {
  cwd = join(tmpdir(), `gk-store-${process.pid}-${Date.now()}`);
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(cwd, "graph.yaml"), graphYaml);
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

function graph() {
  return GraphSchema.parse(YAML.parse(readFileSync(join(cwd, "graph.yaml"), "utf-8")));
}

describe("addEvidence", () => {
  test("stores content-addressed artifact + marker + index row", () => {
    writeFileSync(join(cwd, "resp.json"), '{"ok":true}');
    const out = addEvidence(cwd, graph(), { file: join(cwd, "resp.json"), key: "api-response", node: "probe", note: "n" });
    const sha = createHash("sha256").update('{"ok":true}').digest("hex");
    expect(out.sha256).toBe(sha);
    const artifact = join(cwd, ".graphkit", "evidence", "api-response", `${sha}.json`);
    expect(readFileSync(artifact, "utf-8")).toBe('{"ok":true}');

    const marker = readFileSync(join(cwd, ".graphkit", "evidence", "api-response.md"), "utf-8");
    expect(marker.startsWith("---\n")).toBe(true);
    expect(marker).toContain(`artifact: api-response/${sha}.json`);
    expect(marker).toContain(`artifact_sha256: ${sha}`);
    expect(marker.trimEnd().split("---").pop()!.trim().length).toBeGreaterThan(0); // ADR-002: non-whitespace body

    const index = readFileSync(join(cwd, ".graphkit", "evidence", ".index"), "utf-8");
    const line = index.trim().split("\n").at(-1)!;
    const entry = JSON.parse(line);
    expect(entry.key).toBe("api-response");
    expect(entry.node).toBe("probe");
    expect(entry.artifact).toBe(`api-response/${sha}.json`);
    expect(entry.sha256).toBe(sha);
    expect(entry.file).toContain("api-response.md");
    expect(entry.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("same content twice reuses blob and rewrites marker", () => {
    writeFileSync(join(cwd, "resp.json"), '{"ok":true}');
    const a = addEvidence(cwd, graph(), { file: join(cwd, "resp.json"), key: "api-response" });
    const b = addEvidence(cwd, graph(), { file: join(cwd, "resp.json"), key: "api-response", note: "second" });
    expect(b.sha256).toBe(a.sha256);
    expect(readFileSync(join(cwd, ".graphkit", "evidence", "api-response.md"), "utf-8")).toContain("note: second");
  });

  test("key not declared → EVIDENCE_KEY_NOT_DECLARED", () => {
    writeFileSync(join(cwd, "x"), "x");
    expect(() => addEvidence(cwd, graph(), { file: join(cwd, "x"), key: "bogus" })).toThrow(/EVIDENCE_KEY_NOT_DECLARED/);
  });

  test("missing file → EVIDENCE_FILE_MISSING; oversize → EVIDENCE_TOO_LARGE", () => {
    expect(() => addEvidence(cwd, graph(), { file: join(cwd, "nope"), key: "api-response" })).toThrow(/EVIDENCE_FILE_MISSING/);
    writeFileSync(join(cwd, "big"), "x".repeat(11 * 1024 * 1024));
    expect(() => addEvidence(cwd, graph(), { file: join(cwd, "big"), key: "api-response" })).toThrow(/EVIDENCE_TOO_LARGE/);
    expect(() => addEvidence(cwd, graph(), { file: join(cwd, "big"), key: "api-response", maxBytes: 12 * 1024 * 1024 })).not.toThrow();
  });

  test(".gk.json evidence_max_bytes overrides default", () => {
    expect(DEFAULT_MAX_BYTES).toBe(10 * 1024 * 1024);
    expect(maxBytesFromConfig(cwd)).toBe(DEFAULT_MAX_BYTES);
    writeFileSync(join(cwd, ".gk.json"), JSON.stringify({ evidence_max_bytes: 5 }));
    expect(maxBytesFromConfig(cwd)).toBe(5);
    writeFileSync(join(cwd, ".gk.json"), JSON.stringify({ evidence_max_bytes: "bad" }));
    expect(maxBytesFromConfig(cwd)).toBe(DEFAULT_MAX_BYTES);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/evidence-store.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/evidence/store.ts
import { createHash } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { GraphKitError } from "../errors.js";
import { activeRun } from "../memory/ledger.js";
import type { Graph } from "../schemas/graph.schema.js";
import { fingerprint } from "./fingerprint.js";
import { renderMarker, type MarkerMeta } from "./marker.js";

export const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

export function maxBytesFromConfig(cwd: string): number {
  const f = join(cwd, ".gk.json");
  if (!existsSync(f)) return DEFAULT_MAX_BYTES;
  try {
    const cfg = JSON.parse(readFileSync(f, "utf-8")) as Record<string, unknown>;
    return typeof cfg.evidence_max_bytes === "number" && cfg.evidence_max_bytes > 0
      ? cfg.evidence_max_bytes
      : DEFAULT_MAX_BYTES;
  } catch {
    return DEFAULT_MAX_BYTES;
  }
}

export function addEvidence(
  cwd: string,
  graph: Graph,
  opts: { file: string; key: string; node?: string; note?: string; maxBytes?: number },
): { key: string; artifact: string; sha256: string; bytes: number } {
  const declared = new Set<string>([
    ...graph.evidence.required_keys,
    ...Object.values(graph.nodes).flatMap((n) => n.evidence),
  ]);
  if (!declared.has(opts.key)) {
    throw new GraphKitError(
      "EVIDENCE_KEY_NOT_DECLARED",
      `Evidence key "${opts.key}" is not required by the graph nor produced by any node`,
      { hint: "Declare it in evidence.required_keys or nodes.<id>.evidence in graph.yaml" },
    );
  }
  if (!existsSync(opts.file)) throw new GraphKitError("EVIDENCE_FILE_MISSING", `File not found: ${opts.file}`);
  const maxBytes = opts.maxBytes ?? maxBytesFromConfig(cwd);
  const bytes = statSync(opts.file).size;
  if (bytes > maxBytes) {
    throw new GraphKitError("EVIDENCE_TOO_LARGE", `Artifact is ${bytes} bytes; limit is ${maxBytes}`, {
      hint: "Raise the limit in .gk.json (evidence_max_bytes) — user-set, not agent-set",
    });
  }

  const content = readFileSync(opts.file);
  const sha256 = createHash("sha256").update(content).digest("hex");
  const ext = extname(opts.file) || ".bin";
  const evidenceDir = join(cwd, graph.outputs.evidence_dir);
  const artifactRel = `${opts.key}/${sha256}${ext}`;
  const artifactAbs = join(evidenceDir, artifactRel);
  mkdirSync(join(evidenceDir, opts.key), { recursive: true });
  if (!existsSync(artifactAbs)) copyFileSync(opts.file, artifactAbs);

  const ts = new Date().toISOString();
  const fp = fingerprint(cwd);
  const meta: MarkerMeta = {
    key: opts.key,
    run_id: activeRun(cwd) ? basename(activeRun(cwd)!) : null,
    node: opts.node ?? null,
    fingerprint_head: fp.head,
    fingerprint_tree: fp.tree,
    artifact: artifactRel,
    artifact_sha256: sha256,
    bytes,
    ts,
    note: opts.note ?? null,
  };
  writeFileSync(join(evidenceDir, `${opts.key}.md`), renderMarker(meta, `Evidence artifact "${opts.key}" recorded ${ts}.`));

  // Same JSONL shape as kits/*/hooks/evidence-persist.cjs, extended with provenance.
  appendFileSync(
    join(evidenceDir, ".index"),
    `${JSON.stringify({ file: join(evidenceDir, `${opts.key}.md`), at: ts, key: opts.key, node: opts.node ?? null, artifact: artifactRel, sha256 })}\n`,
  );

  return { key: opts.key, artifact: artifactRel, sha256, bytes };
}
```

`GraphKitError` constructor is `(code: string, message: string, details?: Record<string, unknown>)` — confirmed in `src/errors.ts` — so the throw sites above compile as written; use `e instanceof GraphKitError` (gate.ts pattern) in the CLI catch.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/evidence-store.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/evidence/store.ts tests/unit/evidence-store.test.ts
git commit -m "feat(evidence): content-addressed artifact store with provenance markers"
```

---

### Task 5: `gk evidence add` CLI + registry + parity

**Files:**
- Create: `src/cli/commands/evidence.ts`
- Modify: `src/index.ts` (register)
- Modify: `src/cli/command-registry.ts` (CLI_COMMANDS entry)
- Modify: `cli-manifest.json` (hand-maintained mirror — add same entry with same options)
- Modify: `scripts/check-cli-parity.ts` (add `"UNKNOWN_EVIDENCE_SUBCOMMAND"` to `UNKNOWN_CODES`)
- Test: `tests/unit/evidence-cli.test.ts`

**Interfaces:**
- Consumes: `addEvidence`, `maxBytesFromConfig` (Task 4); `loadGraph` from `src/cli/commands/graph.js`; `ok`/`fail` from `src/cli/output.js`; `subcommandsFor` from `src/cli/command-registry.js`.
- Produces: CLI `gk evidence add <file> --key <k> [--node <n>] [--note <text>] [--json]` printing `{status:"ok", data: addEvidence(...)}`; unknown leaf → `fail("UNKNOWN_EVIDENCE_SUBCOMMAND", ...)`, exit 1. Registry path `evidence add` (options `["--key <k>", "--node <n>", "--note <text>", "--json"]`). Task 7 will add `evidence report` to the same file.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/evidence-cli.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cac } from "cac";
import { registerEvidenceCommand } from "../../src/cli/commands/evidence.js";

let cwd: string;
const graphYaml = `apiVersion: graphkit.dev/v2
kind: Graph
metadata:
  name: t
topology: diamond
nodes:
  probe:
    agent: a
    objective: o
    depend_on: []
    evidence: [api-response]
evidence:
  required_keys: [api-response]
`;

function runCli(args: string[]) {
  const origCwd = process.cwd();
  process.chdir(cwd);
  const cli = cac("gk");
  registerEvidenceCommand(cli);
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  let code = 0;
  const origExit = process.exit;
  process.exit = (c?: number) => { code = c ?? 1; };
  try { cli.parse(["node", "gk", ...args], { run: true }); }
  finally {
    console.log = origLog; process.exit = origExit; process.chdir(origCwd);
  }
  return { stdout: logs.join("\n"), code };
}

beforeEach(() => {
  cwd = join(tmpdir(), `gk-evcli-${process.pid}-${Date.now()}`);
  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(cwd, ".omp", "agents"), { recursive: true });
  writeFileSync(join(cwd, ".omp", "agents", "a.md"), "# A\n");
  writeFileSync(join(cwd, "graph.yaml"), graphYaml);
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

describe("gk evidence add", () => {
  test("adds artifact via CLI", () => {
    writeFileSync(join(cwd, "r.json"), "{}");
    const r = runCli(["evidence", "add", "r.json", "--key", "api-response", "--node", "probe", "--json"]);
    const env = JSON.parse(r.stdout);
    expect(env.status).toBe("ok");
    expect(env.data.key).toBe("api-response");
    expect(exists(join(cwd, ".graphkit", "evidence", "api-response.md"))).toBe(true);
    function exists(p: string) { return readFileSync(p, "utf-8").length > 0; }
  });

  test("undeclared key exits 1 with code", () => {
    writeFileSync(join(cwd, "r.json"), "{}");
    const r = runCli(["evidence", "add", "r.json", "--key", "bogus", "--json"]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout).error.code).toBe("EVIDENCE_KEY_NOT_DECLARED");
  });

  test("missing --key fails fast", () => {
    const r = runCli(["evidence", "add", "r.json", "--json"]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout).error.code).toBe("MISSING_ARG");
  });

  test("unknown leaf rejected", () => {
    const r = runCli(["evidence", "bogus", "--json"]);
    expect(JSON.parse(r.stdout).error.code).toBe("UNKNOWN_EVIDENCE_SUBCOMMAND");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/evidence-cli.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/cli/commands/evidence.ts
import { join } from "node:path";
import type { CAC } from "cac";
import { subcommandsFor } from "../command-registry.js";
import { fail, ok } from "../output.js";
import { loadGraph } from "./graph.js";
import { addEvidence, maxBytesFromConfig } from "../../evidence/store.js";

export function registerEvidenceCommand(cli: CAC) {
  cli
    .command("evidence [subcommand] [args...]", `Evidence commands\nSubcommands: ${subcommandsFor("evidence")}`)
    .option("--key <k>", "add: evidence key")
    .option("--node <n>", "add: producing node id")
    .option("--note <text>", "add: free-text provenance note")
    .option("--json", "JSON output")
    .action((subcommand, args, opts) => {
      const cwd = process.cwd();
      if (!subcommand) {
        console.log(
          `gk evidence — evidence commands\n\nUsage:\n  gk evidence <subcommand> [args...]\n\nSubcommands: ${subcommandsFor("evidence")}`,
        );
        return;
      }
      if (subcommand === "add") {
        const file = Array.isArray(args) ? args[0] : args;
        if (!file || !opts.key) {
          console.log(JSON.stringify(fail("MISSING_ARG", "evidence add requires <file> and --key <k>")));
          process.exit(1);
          return;
        }
        try {
          const graph = loadGraph(join(cwd, "graph.yaml"));
          const result = addEvidence(cwd, graph, {
            file: join(cwd, String(file)),
            key: String(opts.key),
            node: opts.node ? String(opts.node) : undefined,
            note: opts.note ? String(opts.note) : undefined,
            maxBytes: maxBytesFromConfig(cwd),
          });
          console.log(JSON.stringify(ok(result)));
        } catch (e) {
          console.log(
            JSON.stringify(
              e instanceof Error && e.name === "GraphKitError"
                ? fail((e as { code: string }).code, e.message, (e as { details?: unknown }).details)
                : fail("EVIDENCE_ERROR", String(e)),
            ),
          );
          process.exit(1);
        }
        return;
      }
      console.log(JSON.stringify(fail("UNKNOWN_EVIDENCE_SUBCOMMAND", `Unknown evidence subcommand "${subcommand}"`, { hint: `Subcommands: ${subcommandsFor("evidence")}` })));
      process.exit(1);
    });
}
```

Adapt the `GraphKitError` detection to the real class: import `GraphKitError` from `../../errors.js` and use `e instanceof GraphKitError` (same as gate.ts does) — that is the established pattern; prefer it over the name check shown above.

In `src/index.ts`: `import { registerEvidenceCommand } from "./cli/commands/evidence.js";` and call `registerEvidenceCommand(cli);` next to the other registrations.

In `src/cli/command-registry.ts` `CLI_COMMANDS`: add
```ts
{ path: "evidence add", description: "Record a typed artifact against an evidence key", options: ["--key <k>", "--node <n>", "--note <text>", "--json"] },
```
and add `"evidence"` to the leaf list used by `subcommandsFor` (it derives from CLI_COMMANDS paths automatically — verify by reading `subcommandsFor`).

In `cli-manifest.json`: no generator script exists — regenerate by serializing the registry: `bunx tsx -e 'import { cliManifest } from "./src/cli/command-registry.js"; await Bun.write("cli-manifest.json", JSON.stringify(cliManifest(), null, 2) + "\\n")'` then `bunx biome format cli-manifest.json` (matches the file's existing formatting). Diff to confirm only the new entry appeared.

In `scripts/check-cli-parity.ts`: append `"UNKNOWN_EVIDENCE_SUBCOMMAND",` to `UNKNOWN_CODES`.

- [ ] **Step 4: Run tests + parity**

Run: `bun test tests/unit/evidence-cli.test.ts && bun run build && bun scripts/check-cli-parity.ts`
Expected: 4 tests PASS; parity reports the new leaf reachable.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/evidence.ts src/index.ts src/cli/command-registry.ts cli-manifest.json scripts/check-cli-parity.ts tests/unit/evidence-cli.test.ts
git commit -m "feat(cli): gk evidence add — provenance-marked artifact submission"
```

---

### Task 6: Gate freshness + strict mode + status wiring

**Files:**
- Modify: `src/cli/commands/gate.ts` (`gateGraph`, action)
- Modify: `src/cli/commands/status.ts` (pass cwd)
- Test: `tests/unit/gate-freshness.test.ts`

**Interfaces:**
- Consumes: `fingerprint` (Task 2), `parseMarker`/`freshnessOf`/`Freshness` (Task 3), `graph.evidence.freshness` (Task 1).
- Produces:
```ts
export interface GateResult {
  verdict: "MERGE" | "BLOCK";
  scorecard: Record<string, "ok" | "missing" | "empty">;
  freshness: Record<string, Freshness>;   // NEW — key → state
  missing: string[];
  manifest: Record<string, { path: string; sha256: string; bytes: number }>;
}
export function gateGraph(requiredKeys: string[], evidenceDir: string, opts?: { cwd?: string; strict?: boolean }): GateResult
```
  Third arg optional → every existing two-arg caller (status.ts, eval callers if any) keeps compiling; with no `cwd`, freshness is `"unknown"` for present keys (honest — nothing verifiable). Strict rule: after `scoreWorkProduct`, if `opts.strict` and any required key has `scorecard[k] === "ok"` and `freshness[k] === "stale"`, verdict becomes `BLOCK` and the action's fail payload gains `stale: string[]`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/gate-freshness.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gateGraph } from "../../src/cli/commands/gate.js";
import { fingerprint } from "../../src/evidence/fingerprint.js";
import { renderMarker, type MarkerMeta } from "../../src/evidence/marker.js";

let repo: string;
let evDir: string;
beforeEach(() => {
  repo = join(tmpdir(), `gk-gatefp-${process.pid}-${Date.now()}`);
  mkdirSync(repo, { recursive: true });
  evDir = join(repo, ".graphkit", "evidence");
  mkdirSync(evDir, { recursive: true });
  execSync('git init -q && git config user.email t@t && git config user.name t && git commit -q --allow-empty -m e', { cwd: repo, shell: "/bin/bash" });
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

function markerFor(key: string, fp: { head: string | null; tree: string | null }): MarkerMeta {
  return { key, run_id: null, node: null, fingerprint_head: fp.head, fingerprint_tree: fp.tree, artifact: null, artifact_sha256: null, bytes: null, ts: null, note: null };
}

describe("gateGraph freshness", () => {
  test("fresh marker → MERGE even strict; freshness map populated", () => {
    writeFileSync(join(evDir, "design.md"), renderMarker(markerFor("design", fingerprint(repo)), "body"));
    const r = gateGraph(["design"], evDir, { cwd: repo, strict: true });
    expect(r.verdict).toBe("MERGE");
    expect(r.freshness.design).toBe("fresh");
  });

  test("stale marker: report-mode MERGEs, strict BLOCKs", () => {
    const fp = fingerprint(repo);
    writeFileSync(join(evDir, "design.md"), renderMarker(markerFor("design", { head: fp.head, tree: "0".repeat(64) }), "body"));
    expect(gateGraph(["design"], evDir, { cwd: repo }).verdict).toBe("MERGE");
    expect(gateGraph(["design"], evDir, { cwd: repo }).freshness.design).toBe("stale");
    const strict = gateGraph(["design"], evDir, { cwd: repo, strict: true });
    expect(strict.verdict).toBe("BLOCK");
  });

  test("legacy marker (no frontmatter) → unknown, never blocks strict", () => {
    writeFileSync(join(evDir, "design.md"), "# plain legacy\n");
    const r = gateGraph(["design"], evDir, { cwd: repo, strict: true });
    expect(r.verdict).toBe("MERGE");
    expect(r.freshness.design).toBe("unknown");
  });

  test("no cwd option → unknown freshness, verdict unchanged", () => {
    writeFileSync(join(evDir, "design.md"), "body\n");
    const r = gateGraph(["design"], evDir);
    expect(r.verdict).toBe("MERGE");
    expect(r.freshness.design).toBe("unknown");
  });

  test("stale missing key still just missing", () => {
    const r = gateGraph(["design"], evDir, { cwd: repo, strict: true });
    expect(r.verdict).toBe("BLOCK");
    expect(r.missing).toEqual(["design"]);
    expect(r.freshness.design).toBe("unknown");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/gate-freshness.test.ts`
Expected: FAIL — `freshness` property missing / third arg ignored.

- [ ] **Step 3: Implement**

In `src/cli/commands/gate.ts`:

Add imports:
```ts
import { fingerprint } from "../../evidence/fingerprint.js";
import { freshnessOf, parseMarker, type Freshness } from "../../evidence/marker.js";
```

Extend `GateResult` (add `freshness: Record<string, Freshness>;`) and rewrite `gateGraph`:

```ts
export function gateGraph(
  requiredKeys: string[],
  evidenceDir: string,
  opts?: { cwd?: string; strict?: boolean },
): GateResult {
  const evidence: Record<string, string | undefined> = {};
  const manifest: Record<string, { path: string; sha256: string; bytes: number }> = {};
  const freshness: Record<string, Freshness> = {};
  const cur = opts?.cwd ? fingerprint(opts.cwd) : null;
  for (const key of requiredKeys) {
    const p = join(evidenceDir, `${key}.md`);
    if (!existsSync(p)) {
      evidence[key] = undefined; // → "missing"
      freshness[key] = "unknown";
      continue;
    }
    const content = readFileSync(p, "utf-8");
    evidence[key] = content;
    freshness[key] = freshnessOf(parseMarker(content), cur ?? { head: null, tree: null });
    manifest[key] = {
      path: p,
      sha256: createHash("sha256").update(content).digest("hex"),
      bytes: Buffer.byteLength(content),
    };
  }
  const base = scoreWorkProduct({ required_keys: requiredKeys }, evidence, "strict");
  const stale = requiredKeys.filter((k) => freshness[k] === "stale" && base.scorecard[k] === "ok");
  const verdict = opts?.strict && stale.length > 0 ? "BLOCK" : base.verdict;
  return {
    verdict,
    scorecard: base.scorecard,
    freshness,
    missing: Object.entries(base.scorecard)
      .filter(([, s]) => s !== "ok")
      .map(([k]) => k),
    manifest,
  };
}
```

Action body: pass `{ cwd: process.cwd(), strict: graph.evidence.freshness === "strict" }` to `gateGraph`, include `freshness` in both `ok()` and `fail()` payloads, and on BLOCK include `stale` in the fail details. `loadGraph` returns the parsed graph (freshness defaulted in Task 1).

`src/cli/commands/status.ts`: change the coverage call to `gateGraph(graph.evidence.required_keys, evidenceDir, { cwd })` (report-only — status never blocks).

- [ ] **Step 4: Run tests**

Run: `bun test tests/unit/gate-freshness.test.ts tests/unit/gate.test.ts tests/unit/cli-status-commands.test.ts tests/unit/run-cli.test.ts`
Expected: all PASS (existing tests use two-arg calls → additive `freshness` field doesn't break field-level assertions; if any deep-equals the whole GateResult, update it to include `freshness` — that is a test-fixture fix, not a behavior change).

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/gate.ts src/cli/commands/status.ts tests/unit/gate-freshness.test.ts
git commit -m "feat(gate): per-key freshness + evidence.freshness strict blocking"
```

---

### Task 7: `gk evidence report` — criterion-first markdown + HTML

**Files:**
- Create: `src/evidence/report.ts`
- Modify: `src/cli/commands/evidence.ts` (report subcommand)
- Modify: `src/cli/command-registry.ts` + `cli-manifest.json` (`evidence report`)
- Test: `tests/unit/evidence-report.test.ts`

**Interfaces:**
- Consumes: `parseMarker`/`Freshness` (Task 3), `fingerprint` (Task 2), `loadCriteria` (Task 1), `GraphSchema`.
- Produces:
```ts
export interface CriterionView {
  id: string;
  description: string | null;
  kind: "report" | "screenshot" | "json" | "metrics" | "text";
  status: "present" | "missing";
  freshness: Freshness;
  artifact: string | null;     // relative path under evidence dir, from marker
  provenance: string | null;   // "run <id> · node <n> · <head[:8]> · <ts>"
}
export function buildViews(cwd: string, graph: Graph): CriterionView[]  // required_keys order; registry metadata layered on
export function renderMarkdown(name: string, views: CriterionView[]): string
export function renderHtml(name: string, views: CriterionView[], evidenceDir: string): string
```
  Markdown badge map: present `● present`, missing `○ missing`; freshness suffix ` · ◐ stale` / ` · ? unknown` (fresh gets no suffix). HTML security rules (spec §5): base64 `<img>` for `screenshot` artifacts EXCEPT `.svg` (→ download link); `json`/`text`/`metrics`/`report` kinds → escaped `<pre>` (JSON re-serialized via `JSON.parse`→`JSON.stringify(,2)` when parseable); zero `<script>` tags; escape ALL artifact-derived strings with an `escapeHtml` helper.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/evidence-report.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { buildViews, renderHtml, renderMarkdown } from "../../src/evidence/report.js";
import { GraphSchema } from "../../src/schemas/graph.schema.js";

let cwd: string;
const graphYaml = `apiVersion: graphkit.dev/v2
kind: Graph
metadata:
  name: t
topology: diamond
nodes:
  probe:
    agent: a
    objective: o
    depend_on: []
    evidence: [api-response]
evidence:
  required_keys: [api-response]
  criteria: [api-response]
`;

beforeEach(() => {
  cwd = join(tmpdir(), `gk-rep-${process.pid}-${Date.now()}`);
  mkdirSync(join(cwd, ".graphkit", "evidence"), { recursive: true });
  mkdirSync(join(cwd, "criteria"), { recursive: true });
  writeFileSync(join(cwd, "graph.yaml"), graphYaml);
  writeFileSync(join(cwd, "criteria", "api-response.md"), "---\nkind: json\n---\nGET /users 200\n");
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

function graph() {
  return GraphSchema.parse(YAML.parse(readFileSync(join(cwd, "graph.yaml"), "utf-8")));
}

describe("evidence report", () => {
  test("views carry criteria metadata + marker provenance", () => {
    const ev = join(cwd, ".graphkit", "evidence");
    writeFileSync(join(ev, "resp.json"), '{"ok":true}');
    writeFileSync(
      join(ev, "api-response.md"),
      `---\nkey: api-response\nrun_id: r1\nnode: probe\nfingerprint_head: ${"a".repeat(40)}\nfingerprint_tree: ${"b".repeat(64)}\nartifact: api-response/abc.json\nts: 2026-09-05T09:00:00.000Z\n---\n\nbody\n`,
    );
    const views = buildViews(cwd, graph());
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({ id: "api-response", description: "GET /users 200", kind: "json", status: "present", artifact: "api-response/abc.json" }); // description/kind come from criteria/api-response.md
    expect(views[0].provenance).toContain("r1");
    expect(views[0].provenance).toContain("probe");
  });

  test("missing key → missing view", () => {
    const views = buildViews(cwd, graph());
    expect(views[0].status).toBe("missing");
    expect(views[0].freshness).toBe("unknown");
  });

  test("markdown: badges + provenance lines", () => {
    writeFileSync(
      join(cwd, ".graphkit", "evidence", "api-response.md"),
      `---\nkey: api-response\nrun_id: r1\nnode: probe\n---\n\nbody\n`,
    );
    const md = renderMarkdown("t", buildViews(cwd, graph()));
    expect(md).toContain("● present");
    expect(md).toContain("? unknown");
    expect(md).toContain("run r1 · node probe");
  });

  test("html: json artifact escaped, no script execution path", () => {
    const ev = join(cwd, ".graphkit", "evidence");
    const evil = '{"payload":"<script>alert(1)</script>"}';
    writeFileSync(join(ev, "payload.json"), evil);
    const sha = "d".repeat(64);
    writeFileSync(join(ev, `payload-${sha}.json`), evil); // not referenced; only marker artifact path is read
    writeFileSync(
      join(ev, "api-response.md"),
      `---\nkey: api-response\nnode: probe\nartifact: api-response/${sha}.json\n---\n\nbody\n`,
    );
    mkdirSync(join(ev, "api-response"), { recursive: true });
    writeFileSync(join(ev, "api-response", `${sha}.json`), evil);
    const html = renderHtml("t", buildViews(cwd, graph()), ev);
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toMatch(/<script/);
  });

  test("html: svg screenshot refused inline (link only)", () => {
    const ev = join(cwd, ".graphkit", "evidence");
    mkdirSync(join(ev, "shot"), { recursive: true });
    writeFileSync(join(ev, "shot", "abc.svg"), '<svg onload="alert(1)"></svg>');
    // this case exercises the screenshot branch: switch the registry kind
    writeFileSync(join(cwd, "criteria", "api-response.md"), "---\nkind: screenshot\n---\nshot of the thing\n");
    writeFileSync(
      join(ev, "api-response.md"),
      `---\nkey: api-response\nartifact: shot/abc.svg\n---\n\nbody\n`,
    );
    const html = renderHtml("t", buildViews(cwd, graph()), ev);
    expect(html).not.toContain("data:image/svg");
    expect(html).toContain("shot/abc.svg");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/evidence-report.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/evidence/report.ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Graph } from "../schemas/graph.schema.js";
import { loadCriteria } from "./criteria.js";
import { fingerprint } from "./fingerprint.js";
import { freshnessOf, parseMarker, type Freshness } from "./marker.js";

export interface CriterionView {
  id: string;
  description: string | null;
  kind: "report" | "screenshot" | "json" | "metrics" | "text";
  status: "present" | "missing";
  freshness: Freshness;
  artifact: string | null;
  provenance: string | null;
}

const BADGE = { present: "● present", missing: "○ missing" } as const;
const FRESH_TAG: Record<Freshness, string> = { fresh: "", stale: " · ◐ stale", unknown: " · ? unknown" };

export function buildViews(cwd: string, graph: Graph): CriterionView[] {
  const criteria = loadCriteria(cwd, graph.evidence.criteria ?? []);
  const evDir = join(cwd, graph.outputs.evidence_dir);
  const cur = fingerprint(cwd);
  return graph.evidence.required_keys.map((id) => {
    const c = criteria.get(id) ?? null;
    const p = join(evDir, `${id}.md`);
    if (!existsSync(p)) {
      return { id, description: c?.description || null, kind: c?.kind ?? "report", status: "missing" as const, freshness: "unknown" as Freshness, artifact: null, provenance: null };
    }
    const content = readFileSync(p, "utf-8");
    const m = parseMarker(content);
    return {
      id,
      description: c?.description || null,
      kind: c?.kind ?? "report",
      status: content.trim().length > 0 ? ("present" as const) : ("missing" as const),
      freshness: freshnessOf(m, cur),
      artifact: m?.artifact ?? null,
      provenance: m ? [m.run_id && `run ${m.run_id}`, m.node && `node ${m.node}`, m.fingerprint_head && m.fingerprint_head.slice(0, 8), m.ts].filter(Boolean).join(" · ") || null : null,
    };
  });
}

export function renderMarkdown(name: string, views: CriterionView[]): string {
  const lines = [`# Evidence — ${name}`, ""];
  for (const v of views) {
    lines.push(`## ${v.id}`);
    if (v.description) lines.push(`> ${v.description}`);
    lines.push(`- Status: ${BADGE[v.status]}${FRESH_TAG[v.freshness]}`);
    if (v.artifact) lines.push(`- Artifact: ${v.artifact}`);
    if (v.provenance) lines.push(`- Provenance: ${v.provenance}`);
    lines.push("");
  }
  return lines.join("\n");
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function artifactAbs(evidenceDir: string, rel: string | null): string | null {
  if (!rel) return null;
  const p = join(evidenceDir, rel);
  return existsSync(p) ? p : null;
}

export function renderHtml(name: string, views: CriterionView[], evidenceDir: string): string {
  const cards: string[] = [];
  for (const v of views) {
    const badge = v.status === "present" ? "&#9679; present" : "&#9675; missing";
    const fresh = v.freshness === "stale" ? ' <span class="stale">&#9682; stale</span>' : v.freshness === "unknown" ? ' <span class="unknown">? unknown</span>' : "";
    let body = "";
    const abs = artifactAbs(evidenceDir, v.artifact);
    if (abs && v.status === "present") {
      const lower = abs.toLowerCase();
      if (v.kind === "screenshot" && !lower.endsWith(".svg")) {
        body = `<img src="data:image/${lower.endsWith(".png") ? "png" : "jpeg"};base64,${readFileSync(abs).toString("base64")}" alt="${escapeHtml(v.id)}">`;
      } else if (v.kind === "json" || v.kind === "text" || v.kind === "metrics" || v.kind === "report") {
        let text = readFileSync(abs, "utf-8");
        if (v.kind === "json") { try { text = JSON.stringify(JSON.parse(text), null, 2); } catch { /* raw */ } }
        body = `<pre>${escapeHtml(text)}</pre>`;
      } else if (abs) {
        body = `<p><a href="${escapeHtml(v.artifact!)}">download ${escapeHtml(v.artifact!)}</a></p>`;
      }
    }
    if (!body && v.artifact) body = `<p><a href="${escapeHtml(v.artifact)}">download ${escapeHtml(v.artifact)}</a></p>`;
    cards.push(
      `<section class="card"><h2>${escapeHtml(v.id)} <small>${badge}${fresh}</small></h2>` +
      (v.description ? `<p class="desc">${escapeHtml(v.description)}</p>` : "") +
      body + (v.provenance ? `<footer>${escapeHtml(v.provenance)}</footer>` : "") + `</section>`,
    );
  }
  return `<!doctype html><html><head><meta charset="utf-8"><title>Evidence — ${escapeHtml(name)}</title>` +
    `<style>body{font-family:system-ui;margin:2rem;max-width:60rem}.card{border:1px solid #ccc;border-radius:8px;padding:1rem;margin:1rem 0}.stale{color:#b45309}.unknown{color:#6b7280}pre{background:#f6f8fa;padding:.5rem;overflow:auto}img{max-width:100%}footer{color:#6b7280;font-size:.8rem;margin-top:.5rem}</style>` +
    `</head><body><h1>Evidence — ${escapeHtml(name)}</h1>${cards.join("")}</body></html>`;
}
```

CLI wiring in `src/cli/commands/evidence.ts` (inside the action, before the unknown-leaf branch):

```ts
      if (subcommand === "report") {
        try {
          const graph = loadGraph(join(cwd, "graph.yaml"));
          const views = buildViews(cwd, graph);
          if (opts.html) {
            const outPath = join(cwd, ".graphkit", "reports", `${graph.metadata.name}-evidence.html`);
            mkdirSync(dirname(outPath), { recursive: true });
            writeFileSync(outPath, renderHtml(graph.metadata.name, views, join(cwd, graph.outputs.evidence_dir)));
            console.log(JSON.stringify(ok({ written: outPath, keys: views.length })));
          } else {
            console.log(JSON.stringify(ok({ markdown: renderMarkdown(graph.metadata.name, views), views })));
          }
        } catch (e) {
          console.log(JSON.stringify(e instanceof GraphKitError ? fail(e.code, e.message, e.details) : fail("EVIDENCE_ERROR", String(e))));
          process.exit(1);
        }
        return;
      }
```

Add imports (`mkdirSync`, `writeFileSync`, `dirname`, `buildViews`, `renderHtml`, `renderMarkdown`, `GraphKitError`) and options `.option("--html", "report: write self-contained HTML page")`. Register `evidence report` in `CLI_COMMANDS` + `cli-manifest.json` with options `["--html", "--json"]`.

- [ ] **Step 4: Run tests + parity**

Run: `bun test tests/unit/evidence-report.test.ts tests/unit/evidence-cli.test.ts && bun run build && bun scripts/check-cli-parity.ts`
Expected: PASS; parity counts +1 leaf.

- [ ] **Step 5: Commit**

```bash
git add src/evidence/report.ts src/cli/commands/evidence.ts src/cli/command-registry.ts cli-manifest.json tests/unit/evidence-report.test.ts
git commit -m "feat(evidence): criterion-first report — markdown + escaped self-contained HTML"
```

---

### Task 8: Run-start fingerprint stamp + kit skill + docs + changelog + CI

**Files:**
- Modify: `src/memory/ledger.ts` (`startRun` meta)
- Modify: `kits/claude/skills/gk-evidence/SKILL.md` (shell out to `gk evidence report`)
- Modify: `kits/codex/...` mirror of gk-evidence skill if one exists (check `kits/` for other hosts shipping the same skill — keep them byte-identical if they already are)
- Modify: `README.md` (evidence section: criteria/freshness/`gk evidence add`)
- Modify: `CHANGELOG.md` (`## [Unreleased]` bullets — CI gate requires the section)
- Test: `tests/unit/run-cli.test.ts` (extend — one assertion)

**Interfaces:**
- Consumes: `fingerprint` (Task 2).
- Produces: `meta.json` gains `fingerprint: { head: string | null; tree: string | null }` on every new run.

- [ ] **Step 1: Write the failing test**

In `tests/unit/run-cli.test.ts`, inside the existing "executes run start, status, node, end lifecycle" test after `startOk`, add:

```ts
      const metaFile = JSON.parse(readFileSync(join(startOk.data.dir, "meta.json"), "utf-8"));
      expect(metaFile.fingerprint).toEqual({ head: null, tree: null }); // tmp cwd is not a git repo
```

(Add `readFileSync` to the file's `node:fs` import if missing. `head: null` because the test's tmp cwd is not a git repo — the honest null, not a fabricated value.)

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/run-cli.test.ts`
Expected: FAIL — `fingerprint` undefined in meta.

- [ ] **Step 3: Implement**

In `src/memory/ledger.ts` add `import { fingerprint } from "../evidence/fingerprint.js";` and in `startRun`'s `meta` object (after `graph_sha256`):

```ts
    fingerprint: fingerprint(cwd),
```

- [ ] **Step 4: Kit skill + docs**

`kits/claude/skills/gk-evidence/SKILL.md`: replace the aggregation prose (the part describing reading `.graphkit/evidence/.index` and scanning `*.md`) with `gk evidence report --json` as the enumeration source, keeping the existing gate/verdict contract text unchanged. `gk-evidence` ships in at least `kits/claude/skills/` and `kits/codex/skills/` — diff the SKILL.md copies first; if they are byte-identical, apply the same edit to every kit target that ships it and keep them byte-identical (the hooks `evidence-persist.cjs` in `kits/claude/hooks/` + `kits/cursor/hooks/` are unchanged — `evidence add` only extends the `.index` they write). `tests/unit/kit-skill-parity.test.ts` will catch drift — run it.

`README.md`: add to the evidence/gate section: criteria registry (`criteria/<id>.md` + `evidence.criteria` id list), freshness modes, `gk evidence add` usage, `gk evidence report --html`. ~15 lines, example YAML block copied from the spec §1.

`CHANGELOG.md`: under `## [Unreleased]` add:

```markdown
### Added
- `criteria/` registry + `evidence.criteria` id list + `evidence.freshness: report|strict` in graph.yaml; `criteria-keys`/`criteria-file` validation
- `gk evidence add` — content-addressed artifacts with provenance markers (`EVIDENCE_KEY_NOT_DECLARED` / `EVIDENCE_FILE_MISSING` / `EVIDENCE_TOO_LARGE`)
- Gate/status per-key freshness (`fresh|stale|unknown`); strict mode BLOCKs on stale required keys
- `gk evidence report` — criterion-first markdown + `--html` self-contained page (SVG never inlined, all content escaped)
- `gk run start` stamps the repo fingerprint into the run ledger
```

- [ ] **Step 5: Full CI + commit**

Run: `bun run ci:local`
Expected: typecheck + lint + build + all tests + cbm parity + changelog gate PASS (575+ new tests included).

```bash
git add src/memory/ledger.ts kits/ README.md CHANGELOG.md tests/unit/run-cli.test.ts
git commit -m "feat(evidence): run-start fingerprint stamp, kit skill + docs for the evidence layer"
```

---

## Verification (whole plan)

After Task 8, one manual smoke in a scratch repo proves the vertical slice end-to-end:

```bash
mkdir -p /tmp/gk-smoke && cd /tmp/gk-smoke && git init -q .
cat > graph.yaml <<'EOF'
apiVersion: graphkit.dev/v2
kind: Graph
metadata:
  name: smoke
topology: diamond
nodes:
  probe:
    agent: prober
    objective: probe
    depend_on: []
    evidence: [api-response]
evidence:
  required_keys: [api-response]
  criteria: [api-response]
  freshness: strict
EOF
mkdir -p criteria
cat > criteria/api-response.md <<'EOF2'
---
kind: json
---
GET /users returns 200
EOF2
echo '{"status":200}' > resp.json
gk validate && gk run start && gk evidence add resp.json --key api-response --node probe
gk gate          # → MERGE (fresh)
echo '{"status":500}' > resp.json   # worktree now differs from stamp… no: marker unchanged, tree changed via tracked file
touch graph.yaml                      # edit AFTER stamping → marker stale
gk gate          # → BLOCK stale-evidence (strict)
gk evidence report --html && open .graphkit/reports/smoke-evidence.html
```

Note: `graph.yaml` must be git-tracked and committed for the staleness flip (untracked works too — both enter the tree manifest). The `agent: prober` binding needs `.omp/agents/prober.md` or validate fails — use a repo with that scaffold or adjust.
