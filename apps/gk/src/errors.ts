export type ErrorCode =
  | "SCHEMA_VIOLATION"
  | "UNBOUNDED_CYCLE"
  | "UNREACHABLE_TERMINAL"
  | "MISSING_MERGE_POLICY"
  | "ERR_UNDECLARED_MERGE"
  | "ERR_MERGE_CONFLICT"
  | "ERR_EXPRESSION"
  | "LEASE_EXPIRED"
  | "LEASE_INVALID"
  | "UNSAFE_PATH"
  | "COMMAND_NOT_ALLOWED"
  | "INVALID_TRANSITION"
  | "MODIFIED_TARGET";

export class GraphKitError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public recoverable = false,
    public details?: unknown,
  ) {
    super(message);
  }
}
