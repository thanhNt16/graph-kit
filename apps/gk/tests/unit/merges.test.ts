import { describe, expect, test } from "bun:test";
import { type ErrorCode, GraphKitError } from "../../src/errors.js";
import { mergeStateField } from "../../src/runtime/merges.js";
import type { MergePolicy } from "../../src/schemas.js";

function expectCode(fn: () => unknown, code: ErrorCode) {
  try {
    fn();
    throw new Error("expected throw");
  } catch (err) {
    expect(err).toBeInstanceOf(GraphKitError);
    expect((err as GraphKitError).code).toBe(code);
  }
}

describe("merge policies", () => {
  test("supports all policies", () => {
    expect(mergeStateField({ merge: "replace" }, 1, 2)).toBe(2);
    expect(mergeStateField({ merge: "append" }, [1], [2])).toEqual([1, 2]);
    expect(
      mergeStateField(
        { merge: "append_unique", identity: "id" },
        [{ id: "a", n: 1 }],
        [
          { id: "a", n: 2 },
          { id: "b", n: 3 },
        ],
      ),
    ).toEqual([
      { id: "a", n: 1 },
      { id: "b", n: 3 },
    ]);
    expect(mergeStateField({ merge: "first" }, 1, 2)).toBe(1);
    expect(mergeStateField({ merge: "maximum" }, 1, 2)).toBe(2);
    expect(mergeStateField({ merge: "minimum" }, 1, 2)).toBe(1);
    expect(mergeStateField({ merge: "merge_object" }, { a: 1 }, { b: 2 })).toEqual({ a: 1, b: 2 });
    expect(mergeStateField({ merge: "reject_conflict" }, "a", "a")).toBe("a");
  });
  test("rejects undeclared and conflicting merges", () => {
    expectCode(() => mergeStateField(undefined, 1, 2), "ERR_UNDECLARED_MERGE");
    expectCode(() => mergeStateField({ merge: "reject_conflict" }, "a", "b"), "ERR_MERGE_CONFLICT");
  });
  test("first write accepts incoming under every policy", () => {
    const incoming = { id: "a", n: 3 };
    const cases: Array<{
      declaration: { merge: MergePolicy; identity?: string };
      previous: unknown;
      expected: unknown;
    }> = [
      { declaration: { merge: "replace" }, previous: undefined, expected: incoming },
      { declaration: { merge: "append" }, previous: undefined, expected: [incoming] },
      { declaration: { merge: "append_unique", identity: "id" }, previous: undefined, expected: [incoming] },
      { declaration: { merge: "first" }, previous: undefined, expected: incoming },
      { declaration: { merge: "maximum" }, previous: undefined, expected: incoming },
      { declaration: { merge: "minimum" }, previous: undefined, expected: incoming },
      { declaration: { merge: "merge_object" }, previous: undefined, expected: incoming },
      { declaration: { merge: "reject_conflict" }, previous: undefined, expected: incoming },
    ];
    for (const { declaration, previous, expected } of cases) {
      expect(mergeStateField(declaration, previous, incoming)).toEqual(expected);
    }
  });
});
