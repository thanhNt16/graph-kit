import type { ErrorCode } from "../errors.js";

export type ResultEnvelope<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: ErrorCode; message: string; recoverable: boolean; details?: unknown } };

export const ok = <T>(data: T): ResultEnvelope<T> => ({ ok: true, data });

export const fail = (
  code: ErrorCode,
  message: string,
  recoverable = false,
  details?: unknown,
): ResultEnvelope<never> => ({
  ok: false,
  error: { code, message, recoverable, ...(details === undefined ? {} : { details }) },
});
