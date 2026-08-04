import { describe, expect, test } from "bun:test";
import { AgentNodeSchema, RunSchema } from "../../src/schemas.js";

describe("canonical schemas", () => {
  test("agent nodes require an output JSON Schema path", () => {
    expect(() => AgentNodeSchema.parse({ id: "plan", type: "agent", skill: "planner", objective: "Plan" })).toThrow();
  });
  test("run verdict is closed", () => {
    expect(() =>
      RunSchema.parse({
        run_id: "r1",
        status: "done",
        current_nodes: [],
        pending_items: [],
        in_flight: {},
        iteration: 1,
        failures: 0,
        verdict: "maybe",
      }),
    ).toThrow();
  });
});
