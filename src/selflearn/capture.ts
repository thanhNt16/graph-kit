// CAP — transcript-window slicer + the per-session reflect trigger.
// Port of autoharness hook/capture.py + lib/counters.py (MIT): the host
// transcript is treated as an opaque byte log — no role/format parsing in the
// window path; the reflector LLM reads raw JSONL fine. Capture only moves
// bytes: slice from the session's byte watermark to EOF, clip oversized
// records and the window total, redact at egress, persist the new watermark.
// A missing/stale/negative watermark (compaction rewrote the file) fails safe
// to a full re-read bounded by the window cap. Never write back to the host's
// transcript file.

import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync } from "node:fs";
import { dirname } from "node:path";
import { redact } from "./redact.js";
import { episodePathFor, readWatermark, writeWatermark } from "./state.js";

export const CAPTURE_MAX_RECORD_BYTES = 4_000;
export const CAPTURE_MAX_WINDOW_BYTES = 200_000;
export const DIGEST_EXCHANGES = 20;
export const DIGEST_MAX_RECORD_CHARS = 200;
export const DIGEST_MAX_BYTES = 20_000;
export const TRUNCATION_MARK = "...[truncated]";

/** Reflect cadence in main-session tool calls (PreToolUse quantum). */
export function reflectEveryN(): number {
  const raw = process.env.SELFLEARN_REFLECT_EVERY_N;
  const n = raw === undefined ? Number.NaN : Number(raw);
  return Number.isInteger(n) && n > 0 ? n : 50;
}

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: false });

/** Clip a line so its UTF-8 encoding stays within `cap` bytes. */
function clip(line: string, cap: number): string {
  const bytes = enc.encode(line);
  if (bytes.length <= cap) return line;
  return `${dec.decode(bytes.subarray(0, cap))}${TRUNCATION_MARK}`;
}

export interface WindowSlice {
  text: string;
  new_offset: number;
}

/** Slice `[offset, EOF)` of the transcript: per-record clip + tail-capped
 *  window + egress redaction. Empty/missing transcript → empty text. */
export function sliceWindow(
  transcriptPath: string,
  offset = 0,
  maxRecordBytes = CAPTURE_MAX_RECORD_BYTES,
  maxWindowBytes = CAPTURE_MAX_WINDOW_BYTES,
): WindowSlice {
  if (!existsSync(transcriptPath)) return { text: "", new_offset: 0 };
  const fd = openSync(transcriptPath, "r");
  let newOffset: number;
  let tail: string;
  try {
    newOffset = readFileSync(transcriptPath).length;
    if (!(offset >= 0 && offset <= newOffset)) offset = 0;
    const buf = Buffer.alloc(newOffset - offset);
    readSync(fd, buf, 0, newOffset - offset, offset);
    tail = dec.decode(buf);
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* closed */
    }
  }
  const lines = tail.split("\n").map((l) => clip(l, maxRecordBytes));
  const kept: string[] = [];
  let total = 0;
  for (const line of [...lines].reverse()) {
    total += enc.encode(line).length + 1;
    if (total > maxWindowBytes) {
      kept.push(TRUNCATION_MARK);
      break;
    }
    kept.push(line);
  }
  return { text: redact([...kept].reverse().join("\n")), new_offset: newOffset };
}

/** Append the fresh window (per the persisted watermark) to the session's
 *  episode file; update the watermark offset + first_offset. */
export function captureEpisode(cwd: string, session: string, transcriptPath: string) {
  const wm = readWatermark(cwd, session);
  const { text, new_offset } = sliceWindow(transcriptPath, wm.offset);
  const episode = episodePathFor(cwd, session);
  let appended = 0;
  if (text.trim()) {
    mkdirSync(dirname(episode), { recursive: true });
    appendFileSync(episode, `${text.replace(/\n{2,}/g, "\n").trim()}\n`, "utf-8");
    appended = text.split("\n").filter((l) => l.trim()).length;
  }
  writeWatermark(cwd, session, {
    ...wm,
    offset: new_offset,
    first_offset: wm.first_offset || wm.offset,
  });
  return { episode, appended, new_offset };
}

/** Append one host-event record to the episode file (omp path — no host
 *  transcript file to watermark, the extension streams records instead). */
export function recordEpisode(cwd: string, session: string, records: string[]): number {
  const episode = episodePathFor(cwd, session);
  mkdirSync(dirname(episode), { recursive: true });
  let n = 0;
  for (const rec of records) {
    const line = clip(redact(rec.trim()), CAPTURE_MAX_RECORD_BYTES);
    if (!line) continue;
    appendFileSync(episode, `${line}\n`, "utf-8");
    n++;
  }
  return n;
}

/** Prior-context digest: the exchanges before the episode window, compressed
 *  to role + text/tool names — background for the reflector, never evidence. */
export function digest(
  transcriptPath: string,
  endOffset: number,
  maxExchanges = DIGEST_EXCHANGES,
  maxRecordChars = DIGEST_MAX_RECORD_CHARS,
  maxDigestBytes = DIGEST_MAX_BYTES,
): string {
  if (!existsSync(transcriptPath) || endOffset <= 0) return "";
  const data = readFileSync(transcriptPath).subarray(0, endOffset).toString("utf-8");
  const kept: string[] = [];
  let total = 0;
  let users = 0;
  for (const line of data.split("\n").reverse()) {
    let record: { type?: string; message?: { content?: unknown } };
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record.type !== "user" && record.type !== "assistant") continue;
    const content = record.message?.content;
    const parts: string[] = [];
    if (typeof content === "string") parts.push(content);
    else if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === "text" && block.text) parts.push(String(block.text));
        else if (block?.type === "tool_use") parts.push(`[tool: ${block.name ?? "?"}]`);
      }
    }
    const text = parts
      .map((p) => p.trim())
      .filter(Boolean)
      .join(" ");
    if (!text) continue;
    const rendered = `${record.type}: ${text.length > maxRecordChars ? `${text.slice(0, maxRecordChars)}${TRUNCATION_MARK}` : text}`;
    total += rendered.length + 1;
    if (total > maxDigestBytes) {
      kept.push(TRUNCATION_MARK);
      break;
    }
    kept.push(rendered);
    if (record.type === "user" && ++users >= maxExchanges) break;
  }
  return kept.length ? redact([...kept].reverse().join("\n")) : "";
}

/** PreToolUse counter: +1 per main-session tool call. Crossing
 *  SELFLEARN_REFLECT_EVERY_N sets the sticky reflect_due flag (cleared by
 *  `reflect`) and returns true so the host hook instructs the session. */
export function tick(cwd: string, session: string): { count: number; reflect_due: boolean; n: number } {
  const wm = readWatermark(cwd, session);
  const n = reflectEveryN();
  const count = wm.count + 1;
  let reflect_due = false;
  if (count >= n) {
    wm.count = 0;
    wm.reflect_due = true;
    reflect_due = true;
  } else {
    wm.count = count;
  }
  writeWatermark(cwd, session, wm);
  return { count: wm.count, reflect_due, n };
}

/** Read the episode tail for the reflect bundle, bounded by the window cap. */
export function readEpisodeTail(cwd: string, session: string, maxBytes = CAPTURE_MAX_WINDOW_BYTES): string {
  const path = episodePathFor(cwd, session);
  if (!existsSync(path)) return "";
  const fd = openSync(path, "r");
  try {
    const size = readFileSync(path).length;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, size - start, start);
    let text = dec.decode(buf);
    if (start > 0) {
      const nl = text.indexOf("\n");
      text = nl === -1 ? "" : text.slice(nl + 1); // drop the partial first line
      if (text) text = `${TRUNCATION_MARK}\n${text}`;
    }
    return text;
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* closed */
    }
  }
}
