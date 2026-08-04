import { describe, expect, test } from "bun:test";
import { type ErrorCode, GraphKitError } from "../../src/errors.js";
import { evaluateCondition, resolveTemplate } from "../../src/runtime/expression.js";

function expectCode(fn: () => unknown, code: ErrorCode) {
  try {
    fn();
    throw new Error("expected throw");
  } catch (err) {
    expect(err).toBeInstanceOf(GraphKitError);
    expect((err as GraphKitError).code).toBe(code);
  }
}

describe("expressions", () => {
  const scope = {
    inputs: { task: "ship", count: 2 },
    state: { ok: true },
    nodes: {},
    run: { status: "running" },
    limits: {},
  };
  test("resolves nested values and unknown paths", () => {
    const sub = (expr: string) => `${String.fromCharCode(36)}{{ ${expr} }}`;
    expect(resolveTemplate("do ".concat(sub("inputs.task")), scope)).toBe("do ship");
    expect(resolveTemplate(sub("inputs.count"), scope)).toBe(2);
    expect(resolveTemplate(sub("inputs.missing"), scope)).toBeNull();
  });
  test("evaluates bounded conditions", () => {
    expect(evaluateCondition("inputs.count >= 2 && state.ok", scope)).toBe(true);
    expect(evaluateCondition("inputs.missing == null || !state.nope", scope)).toBe(true);
  });
  test("rejects unsafe syntax", () => {
    for (const expression of ["inputs.task()", "inputs.x = 1", "inputs.count + 1", "inputs[x]", "process" + ".env.X"]) {
      expectCode(() => evaluateCondition(expression, scope), "ERR_EXPRESSION");
    }
  });
  test("rejects prototype traversal in conditions and templates", () => {
    const sub = (expr: string) => `${String.fromCharCode(36)}{{ ${expr} }}`;
    for (const expression of [
      "inputs.constructor.constructor",
      "inputs.__proto__",
      "state.prototype",
      "inputs.constructor",
      "inputs.__proto__.x",
    ]) {
      expectCode(() => evaluateCondition(expression, scope), "ERR_EXPRESSION");
      expectCode(() => resolveTemplate(sub(expression), scope), "ERR_EXPRESSION");
    }
  });
  test("rejects excessive nesting depth", () => {
    const expr = "!".repeat(200).concat("state.ok");
    const parens = "(".repeat(200).concat("state.ok").concat(")".repeat(200));
    expectCode(() => evaluateCondition(expr, scope), "ERR_EXPRESSION");
    expectCode(() => evaluateCondition(parens, scope), "ERR_EXPRESSION");
  });
});
