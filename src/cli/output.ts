export function ok<T>(data: T) {
  return { status: "ok", data };
}

export function fail(code: string, message: string, details?: Record<string, unknown>) {
  // F6: every "fail" emit is an honest non-zero exit, even when the emitting
  // handler forgets its own process.exit. This is the single exit-code rule.
  process.exitCode = 1;
  return { status: "fail", error: { code, message, details } };
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
