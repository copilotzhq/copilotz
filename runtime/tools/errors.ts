export interface ToolExecutionErrorDetails {
  code: string;
  message: string;
  retryable: boolean;
  status?: number;
  upstreamStatus?: number;
  providerCode?: string;
  requestId?: string;
  method?: string;
  endpoint?: string;
}

const MAX_TOOL_ERROR_MESSAGE_LENGTH = 2_000;
const HTML_DOCUMENT_PATTERN = /<!doctype\s+html|<html[\s>]/i;

function truncate(value: string): string {
  if (value.length <= MAX_TOOL_ERROR_MESSAGE_LENGTH) return value;
  return `${value.slice(0, MAX_TOOL_ERROR_MESSAGE_LENGTH)}…[truncated]`;
}

export function sanitizeToolErrorMessage(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value ?? "");
  if (HTML_DOCUMENT_PATTERN.test(message)) {
    return "Upstream returned an HTML error response.";
  }
  return truncate(
    message
      .replace(/\u0000/g, "")
      .replace(
        /(authorization\s*[:=]\s*["']?bearer\s+)[^\s,"'}]+/gi,
        "$1[REDACTED]",
      )
      .replace(/((?:set-)?cookie\s*[:=]\s*)[^\r\n]+/gi, "$1[REDACTED]")
      .replace(
        /((?:api[-_]?key|access[-_]?token|refresh[-_]?token)\s*[:=]\s*["']?)[^\s,"'}]+/gi,
        "$1[REDACTED]",
      ),
  );
}

export class ToolExecutionError extends Error {
  readonly details: ToolExecutionErrorDetails;

  constructor(details: ToolExecutionErrorDetails) {
    const safeDetails = {
      ...details,
      message: sanitizeToolErrorMessage(details.message),
    };
    super(safeDetails.message);
    this.name = "ToolExecutionError";
    this.details = safeDetails;
  }
}

export function safeToolExecutionError(
  error: unknown,
): ToolExecutionErrorDetails | string {
  if (error instanceof ToolExecutionError) return error.details;
  return `EXECUTION ERROR: ${sanitizeToolErrorMessage(error)}`;
}

export function stringifyToolError(error: unknown): string {
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return sanitizeToolErrorMessage(error);
  }
}
