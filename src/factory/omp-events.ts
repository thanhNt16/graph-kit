/** Parse `omp -p --mode json` stdout (one JSON event per line; see
 *  tests/fixtures/factory/omp/CONTRACT.md). Tolerates unknown event types and
 *  non-JSON lines (banners, warnings) — omp evolves; unknown lines are ignored
 *  rather than failing the dispatch. */
export interface OmpToolBlock {
  tool: string;
  reason: string;
}

export interface OmpStream {
  /** Concatenated text of the final assistant message (from agent_end, or the
   *  last completed assistant message_end when the run aborted mid-turn). */
  text: string;
  /** Tool calls that ended as errors (tool-not-found, extension-blocked,
   *  runtime failures) — `result.error`/`isError:true`. */
  blocked: OmpToolBlock[];
  /** Final assistant message had stopReason "aborted" (Deadline exceeded). */
  aborted: boolean;
  /** Raw event `type`s seen, for diagnostics. */
  event_types: string[];
}

interface JsonLine {
  type?: string;
  toolName?: string;
  isError?: boolean;
  result?: { details?: { error?: string }; content?: Array<{ type?: string; text?: string }> };
  message?: {
    role?: string;
    stopReason?: string;
    content?: Array<{ type?: string; text?: string }>;
  };
  messages?: Array<{ role?: string; stopReason?: string; content?: Array<{ type?: string; text?: string }> }>;
}

function textOf(m: { content?: Array<{ type?: string; text?: string }> } | undefined): string {
  return (m?.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("");
}

export function parseOmpJsonStream(raw: string): OmpStream {
  const blocked: OmpToolBlock[] = [];
  const event_types = new Set<string>();
  let lastAssistantText = "";
  let lastAssistantAborted = false;
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    let o: JsonLine;
    try {
      o = JSON.parse(t) as JsonLine;
    } catch {
      continue;
    }
    if (o.type) event_types.add(o.type);
    if (o.type === "tool_execution_end" && o.isError) {
      blocked.push({
        tool: o.toolName ?? "unknown",
        reason: o.result?.details?.error ?? textOf(o.result) ?? "tool error",
      });
    }
    if (o.type === "message_end" && o.message?.role === "assistant") {
      lastAssistantText = textOf(o.message);
      lastAssistantAborted = o.message.stopReason === "aborted";
    }
    if (o.type === "agent_end") {
      const last = [...(o.messages ?? [])].reverse().find((m) => m.role === "assistant");
      if (last) {
        const txt = textOf(last);
        if (txt || lastAssistantText === "") {
          lastAssistantText = txt || lastAssistantText;
          lastAssistantAborted = last.stopReason === "aborted" || lastAssistantAborted;
        }
      }
    }
  }
  return { text: lastAssistantText, blocked, aborted: lastAssistantAborted, event_types: [...event_types] };
}
