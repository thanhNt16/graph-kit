import { GraphKitError } from "../errors.js";

export function ok<T>(data: T) {
  return { status: "ok", data };
}

export function fail(code: string, message: string, details?: Record<string, unknown>) {
  // F6: every "fail" emit is an honest non-zero exit, even when the emitting
  // handler forgets its own process.exit. This is the single exit-code rule.
  process.exitCode = 1;
  return { status: "fail", error: { code, message, details } };
}

export interface FailPrintOpts {
  details?: Record<string, unknown>;
  /**
   * true → print the raw JSON envelope (the --json contract agents parse).
   * Default is HUMAN rendering: one `✗ CODE — message` verdict line, plus the
   * finding list / remediation hint when the error carries one. Fail envelopes
   * used to print raw JSON to humans unconditionally — the one gap round 4's
   * human-defaults pass left open (catch blocks kept `JSON.stringify(fail())`).
   */
  json?: boolean;
}

/**
 * The one fail-printing rule. Emits the exact JSON envelope in --json mode and
 * a human verdict otherwise; always goes through fail() so the exit-code rule
 * holds. `hint` and `findings`/`issues` in details get dedicated lines in
 * human mode instead of being buried in a JSON blob.
 */
export function printFail(code: string, message: string, opts?: FailPrintOpts) {
  const envelope = fail(code, message, opts?.details); // the single exit-code rule, both modes
  if (opts?.json) {
    console.log(JSON.stringify(envelope));
    return;
  }
  const lines = [`✗ ${code} — ${message}`];
  const issues = opts?.details?.findings ?? opts?.details?.issues;
  if (Array.isArray(issues) && issues.length > 0) lines.push(renderFindings(issues as ValidationFinding[]));
  const available = opts?.details?.available;
  if (Array.isArray(available) && available.length > 0) lines.push(`  available: ${available.join(", ")}`);
  if (typeof opts?.details?.hint === "string") lines.push(`  hint: ${opts.details.hint}`);
  console.log(lines.join("\n"));
}

/**
 * Catch-block form: GraphKitError carries its own code/details; anything else
 * falls back to the command's generic error code. Absorbs the copies of the
 * `e instanceof GraphKitError ? fail(e.code,…) : fail(GENERIC,…)` ternary.
 */
export function printFailFromError(e: unknown, fallbackCode: string, opts?: FailPrintOpts) {
  if (e instanceof GraphKitError)
    printFail(e.code, e.message, { ...opts, details: { ...opts?.details, ...e.details } });
  else printFail(fallbackCode, e instanceof Error ? e.message : String(e), opts);
}

export interface ValidationFinding {
  check?: string;
  path?: string;
  message: string;
  /** position data when the finding came from a parse error (YAML_INVALID shape) */
  file?: string;
  line?: number;
  column?: number;
}

/**
 * Human rendering for finding lists (VALIDATION_FAILED envelopes) — one
 * indented line per finding with check/path context. These used to be visible
 * only inside the JSON `details.findings`, even in human mode.
 */
export function renderFindings(findings: ValidationFinding[]): string {
  return findings
    .map((f) => {
      const where =
        f.file != null
          ? `${f.file}${f.line != null ? `:${f.line}${f.column != null ? `:${f.column}` : ""}` : ""}: `
          : "";
      const check = typeof f.check === "string" && f.check ? `[${f.check}] ` : "";
      const path = typeof f.path === "string" && f.path ? `${f.path}: ` : "";
      return `  - ${where}${check}${path}${f.message}`;
    })
    .join("\n");
}
