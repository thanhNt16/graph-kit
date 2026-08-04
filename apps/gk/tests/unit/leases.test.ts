import { describe, expect, test } from "bun:test";
import { type ErrorCode, GraphKitError } from "../../src/errors.js";
import { issueLeases, settleLease, validateLease } from "../../src/runtime/leases.js";

function toThrowCode(fn: () => unknown, code: ErrorCode) {
  try {
    fn();
    throw new Error("expected throw");
  } catch (err) {
    expect(err).toBeInstanceOf(GraphKitError);
    expect((err as GraphKitError).code).toBe(code);
  }
}

const T0 = 1_700_000_000_000;
const TTL = 30_000;

describe("lease lifecycle", () => {
  test("issues distinct IDs and settles once", () => {
    const issued = issueLeases([{ work_item: "a", node: "work", now: T0 }]);
    const l1 = issued[0];
    const l2 = issueLeases([{ work_item: "a", node: "work", now: T0 + 1 }])[0];
    expect(l1.id).not.toBe(l2.id);
    expect(validateLease({ leases: issued, now: T0, id: l1.id, work_item: "a" }).status).toBe("active");
    expect(() => settleLease({ leases: issued, now: T0 + 1, id: l1.id })).not.toThrow();
    toThrowCode(() => settleLease({ leases: issued, now: T0 + 2, id: l1.id }), "LEASE_INVALID");
  });
  test("rejects wrong item, expired, and unknown leases", () => {
    const leases = issueLeases([{ work_item: "a", node: "work", now: T0 }]);
    toThrowCode(() => validateLease({ leases, now: T0, id: leases[0].id, work_item: "b" }), "LEASE_INVALID");
    toThrowCode(() => validateLease({ leases, now: T0 + TTL + 1, id: leases[0].id, work_item: "a" }), "LEASE_EXPIRED");
    toThrowCode(() => validateLease({ leases, now: T0, id: "nope", work_item: "a" }), "LEASE_INVALID");
  });
});
