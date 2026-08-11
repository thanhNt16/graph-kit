export function ok<T>(data: T) {
  return { status: "ok", data };
}

export function fail(code: string, message: string, details?: Record<string, unknown>) {
  return { status: "fail", error: { code, message, details } };
}
