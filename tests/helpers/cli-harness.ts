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
  /**
   * run() for cac-unawaited async handlers (the CBM bridge commands, memory
   * index/recall): cli.parse returns before the handler settles, so the
   * stubs are held for `settleMs` (default 100) before restoration — the
   * handler's console.log/process.exit land inside the window instead of
   * after it (a late real process.exit would kill the test runner).
   */
  runAsync(args: string[], settleMs?: number): Promise<CliRun>;
}

/**
 * Build a CLI with `register` applied (the command family under test), pin
 * process.cwd for the duration of each run, and capture stdout/exit.
 *
 * Options:
 * - cwd: pin process.cwd to this directory for each run (fixture roots).
 * - version: set the CLI version (`gk --version` assertions).
 * - captureWarn: route console.warn into the stdout sink — some commands
 *   emit skip-warnings there and tests assert the merged text.
 */
export function createCliHarness(
  register: (cli: CAC) => void,
  opts: { cwd?: string; version?: string; captureWarn?: boolean } = {},
): CliHarness {
  const cli = cac("gk");
  if (opts.version) cli.version(opts.version);
  register(cli);
  cli.help();

  function stubConsoleAndProcess(sink: string[], exited: { code: number | undefined }) {
    const origLog = console.log;
    const origWarn = console.warn;
    const origExit = process.exit;
    const origCwd = process.cwd;
    console.log = (...a: unknown[]) => sink.push(a.map(String).join(" "));
    if (opts.captureWarn) console.warn = (...a: unknown[]) => sink.push(a.map(String).join(" "));
    process.exit = (code?: number) => {
      exited.code = code ?? 1;
    };
    if (opts.cwd) process.cwd = () => opts.cwd!;
    return () => {
      console.log = origLog;
      console.warn = origWarn;
      process.exit = origExit;
      process.cwd = origCwd;
    };
  }

  return {
    run(args: string[]): CliRun {
      const sink: string[] = [];
      const exited: { code: number | undefined } = { code: undefined };
      const restore = stubConsoleAndProcess(sink, exited);
      try {
        cli.parse(["node", "gk", ...args], { run: true });
      } catch {
        // cac throws for async handlers — they settle via awaited microtasks
      }
      restore();
      // process.exitCode is deliberately NOT saved/restored: commands set it
      // (fail() → 1) and the caller asserts on run().exitCode. Tests that care
      // reset it in afterEach, as they always had to.
      return { stdout: sink.join("\n"), exit: exited.code, exitCode: process.exitCode };
    },

    async runAsync(args: string[], settleMs = 100): Promise<CliRun> {
      const sink: string[] = [];
      const exited: { code: number | undefined } = { code: undefined };
      const restore = stubConsoleAndProcess(sink, exited);
      try {
        cli.parse(["node", "gk", ...args], { run: true });
        await new Promise((r) => setTimeout(r, settleMs));
      } catch {
        // cac throws for async handlers — they settle via awaited microtasks
      } finally {
        restore();
      }
      return { stdout: sink.join("\n"), exit: exited.code, exitCode: process.exitCode };
    },
  };
}
