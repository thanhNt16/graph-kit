import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseOmpJsonStream } from "../../src/factory/omp-events";

const FIX = join(import.meta.dir, "..", "fixtures", "factory", "omp");

describe("parseOmpJsonStream (omp 18.12.6 fixtures)", () => {
  test("p1: happy stream → final assistant text", () => {
    const p = parseOmpJsonStream(readFileSync(join(FIX, "p1-json-stream.jsonl"), "utf8"));
    expect(p.text).toBe("OK");
    expect(p.aborted).toBe(false);
    expect(p.blocked).toEqual([]);
    expect(p.event_types).toContain("agent_end");
  });

  test("p4: tool excluded → tool_execution_end isError surfaces as blocked", () => {
    const p = parseOmpJsonStream(readFileSync(join(FIX, "p4-tools-exclude.jsonl"), "utf8"));
    expect(p.blocked.length).toBe(1);
    expect(p.blocked[0].tool).toBe("write");
    expect(p.blocked[0].reason).toContain("not found");
  });

  test("p5: guard-blocked bash surfaces reason", () => {
    const p = parseOmpJsonStream(readFileSync(join(FIX, "p5-guard-bash-block.jsonl"), "utf8"));
    expect(p.blocked.length).toBe(1);
    expect(p.blocked[0].tool).toBe("bash");
    expect(p.blocked[0].reason).toContain("denied by policy");
  });

  test("p6: --max-time abort → aborted flag", () => {
    const p = parseOmpJsonStream(readFileSync(join(FIX, "p6-max-time.jsonl"), "utf8"));
    expect(p.aborted).toBe(true);
  });

  test("tolerates non-JSON lines and unknown events", () => {
    const p = parseOmpJsonStream('banner\n{"type":"new_event","x":1}\nnot json\n{"type":"agent_end","messages":[]}\n');
    expect(p.event_types).toContain("new_event");
    expect(p.text).toBe("");
  });

  test("truncated stream → partial output, no crash", () => {
    const p = parseOmpJsonStream('{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"partial"}],"stopReason":"stop"}}\n{"type":"agent_end","mes');
    expect(p.text).toBe("partial");
    expect(p.aborted).toBe(false);
  });
});
