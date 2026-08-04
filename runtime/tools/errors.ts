export class ToolExecutionError extends Error {
  readonly response: unknown;
  readonly status: number;

  constructor(response: unknown, status: number, statusText: string) {
    super(`HTTP ${status}: ${statusText}`);
    this.name = "ToolExecutionError";
    this.response = response;
    this.status = status;
  }
}

export function toolExecutionErrorResult(error: unknown): unknown {
  if (error instanceof ToolExecutionError) return error.response;
  return `EXECUTION ERROR: ${
    error instanceof Error ? error.message : String(error)
  }`;
}

export function stringifyToolError(error: unknown): string {
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
