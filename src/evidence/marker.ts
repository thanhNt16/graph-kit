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

const KEYS = [
  "key",
  "run_id",
  "node",
  "fingerprint_head",
  "fingerprint_tree",
  "artifact",
  "artifact_sha256",
  "bytes",
  "ts",
  "note",
] as const;

export function renderMarker(meta: MarkerMeta, body: string): string {
  const fm = KEYS.filter((k) => meta[k] !== null && meta[k] !== undefined)
    .map((k) => `${k}: ${String(meta[k])}`)
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
    run_id: s(raw.run_id),
    node: s(raw.node),
    fingerprint_head: s(raw.fingerprint_head),
    fingerprint_tree: s(raw.fingerprint_tree),
    artifact: s(raw.artifact),
    artifact_sha256: s(raw.artifact_sha256),
    bytes: typeof raw.bytes === "number" ? raw.bytes : s(raw.bytes) === null ? null : Number(raw.bytes),
    ts: s(raw.ts),
    note: s(raw.note),
  };
}

export function freshnessOf(
  item: { fingerprint_head: string | null; fingerprint_tree: string | null } | null,
  cur: Fingerprint,
): Freshness {
  if (!item?.fingerprint_head || !item.fingerprint_tree || !cur.head || !cur.tree) return "unknown";
  return item.fingerprint_head === cur.head && item.fingerprint_tree === cur.tree ? "fresh" : "stale";
}
