export class GraphKitError extends Error {
  constructor(
    public code: string,
    message: string,
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "GraphKitError";
    this.code = code;
  }
}
