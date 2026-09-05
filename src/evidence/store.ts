import { createHash } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { GraphKitError } from "../errors.js";
import { activeRun } from "../memory/ledger.js";
import type { Graph } from "../compiler/validate.js";
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
    throw new GraphKitError("EVIDENCE_KEY_NOT_DECLARED", `Evidence key "${opts.key}" is not required by the graph nor produced by any node`, {
      hint: "Declare it in evidence.required_keys or nodes.<id>.evidence in graph.yaml",
    });
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
  writeFileSync(
    join(evidenceDir, `${opts.key}.md`),
    renderMarker(meta, `Evidence artifact "${opts.key}" recorded ${ts}.`),
  );

  // Same JSONL shape as kits/*/hooks/evidence-persist.cjs, extended with provenance.
  appendFileSync(
    join(evidenceDir, ".index"),
    `${JSON.stringify({
      file: join(evidenceDir, `${opts.key}.md`),
      at: ts,
      key: opts.key,
      node: opts.node ?? null,
      artifact: artifactRel,
      sha256,
    })}\n`,
  );

  return { key: opts.key, artifact: artifactRel, sha256, bytes };
}
