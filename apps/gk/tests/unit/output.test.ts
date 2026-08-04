import { expect, test } from "bun:test";
import { createCli } from "../../src/cli/command-registry.js";
import { fail, ok } from "../../src/cli/output.js";

test("uses one stable machine envelope", () => {
  expect(ok({ id: "r1" })).toEqual({ ok: true, data: { id: "r1" } });
  expect(fail("LEASE_INVALID", "unknown lease", true)).toEqual({
    ok: false,
    error: { code: "LEASE_INVALID", message: "unknown lease", recoverable: true },
  });
});

test("createCli registers the version with zero arguments", () => {
  const { cli } = createCli();
  expect(cli).toBeDefined();
  const logs: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => logs.push(args.join(" "));
  try {
    cli.outputVersion();
  } finally {
    console.log = original;
  }
  expect(logs.join("\n")).toContain("0.1.0");
});
