// tests/helpers/cli-harness.ts
// E3: 17 test files used to hand-roll the same cac harness — stdout sink,
// process.exit stubbing, cwd pinning — each with slightly different reset
// semantics (the drift is where envelope-contract assertions quietly diverge).
// One harness instead: create it per test, run, assert, done. Stubbing is
// scoped to the run() call, so there is no cross-file bleed to clean up.

import { type CAC, cac } from "cac";

export interface CliRun {
  /** everything the command printed via console.log, joined with "\n" */
  stdout: string;
  /** the code passed to process.exit (undefined when it was never called) */
  exit: number | undefined;
  /** process.exitCode at the end of the run (fail() sets it to 1) */
  exitCode: number | null;
}

export interface CliHarness {
  run(args: string[]): CliRun;
}

/**
 * Build a CLI with `register` applied (the command family under test), pin
 * process.cwd for the duration of each run, and capture stdout/exit.
 */
export function createCliHarness(register: (cli: CAC) => void, opts: { cwd?: string } = {}): CliHarness {
  const cli = cac("gk");
  register(cli);
  cli.help();
  return {
    run(args: string[]): CliRun {
      const sink: string[] = [];
      const origLog = console.log;
      const origExit = process.exit;
      const origCwd = process.cwd;
      let exited: number | undefined;
      console.log = (...a: unknown[]) => sink.push(a.map(String).join(" "));
      process.exit = (code?: number) => {
        exited = code ?? 1;
      };
      if (opts.cwd) process.cwd = () => opts.cwd!;
      try {
        cli.parse(["node", "gk", ...args], { run: true });
      } catch {
        // cac throws for async handlers — they settle via awaited microtasks
      }
      console.log = origLog;
      process.exit = origExit;
      process.cwd = origCwd;
      // process.exitCode is deliberately NOT saved/restored: commands set it
      // (fail() → 1) and the caller asserts on run().exitCode. Tests that care
      // reset it in afterEach, as they always had to.
      return { stdout: sink.join("\n"), exit: exited, exitCode: process.exitCode };
    },
  };
}
