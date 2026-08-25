import { describe, expect, test } from "bun:test";
import { buildPiArgs } from "../../kits/pi/extensions/gk-subagent";

describe("gk_dispatch_agent arg building", () => {
  test("headless flag always present", () => {
    expect(buildPiArgs({ agent: "x", objective: "y" })).toEqual(["-p"]);
  });
  test("model routes to --model", () => {
    expect(buildPiArgs({ agent: "x", objective: "y", model: "sonnet" })).toEqual(["-p", "--model", "sonnet"]);
  });

  test("allowlist passes through --tools", () => {
    expect(buildPiArgs({ agent: "x", objective: "y", constraints: { tools_allowlist: ["read", "grep"] } })).toEqual([
      "-p",
      "--tools",
      "read,grep",
    ]);
  });

  test("no_write restricts tools", () => {
    expect(buildPiArgs({ agent: "x", objective: "y", constraints: { no_write: true } })).toEqual([
      "-p",
      "--tools",
      "Read,Glob,Grep,Bash",
    ]);
  });
});
