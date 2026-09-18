export type Ok<T> = { status: "ok"; data: T };
export type Failure = { status: "fail"; error: { code: string; message: string; details?: Record<string, unknown> } };
/** The JSON envelope every gk command emits. */
export type Result<T = unknown> = Ok<T> | Failure;

export function ok<T>(data: T): Ok<T> {
  return { status: "ok", data };
}

export function fail(code: string, message: string, details?: Record<string, unknown>): Failure {
  // F6: every "fail" emit is an honest non-zero exit, even when the emitting
  // handler forgets its own process.exit. This is the single exit-code rule.
  process.exitCode = 1;
  return { status: "fail", error: { code, message, details } };
}

/** Print a result envelope as JSON. Exit code is governed by fail() (F6) — never call process.exit() after emit. */
export function emit(result: unknown) {
  console.log(JSON.stringify(result));
}
