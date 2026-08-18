export function ok<T>(data: T) {
  return { status: "ok", data };
}

export function fail(code: string, message: string, details?: Record<string, unknown>) {
  // F6: every "fail" emit is an honest non-zero exit, even when the emitting
  // handler forgets its own process.exit. This is the single exit-code rule.
  process.exitCode = 1;
  return { status: "fail", error: { code, message, details } };
}
