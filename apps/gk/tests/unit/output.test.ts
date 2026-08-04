import { expect, test } from "bun:test";
import { fail, ok } from "../../src/cli/output.js";

test("uses one stable machine envelope", () => {
  expect(ok({ id: "r1" })).toEqual({ ok: true, data: { id: "r1" } });
  expect(fail("LEASE_INVALID", "unknown lease", true)).toEqual({
    ok: false,
    error: { code: "LEASE_INVALID", message: "unknown lease", recoverable: true },
  });
});
