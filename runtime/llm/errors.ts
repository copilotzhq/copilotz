import type {
  LLMUsageAttempt,
  ProviderErrorDetails,
  ProviderFallbackReason,
  ProviderName,
} from "@/runtime/llm/types.ts";

export type LLMProviderAttempt = {
  provider: ProviderName;
  model?: string;
  reason?: ProviderFallbackReason | null;
  status?: number;
  message?: string;
  details?: ProviderErrorDetails;
};

export class LLMProviderError extends Error {
  reason: ProviderFallbackReason | null;
  provider: ProviderName;
  model?: string;
  status?: number;
  attempts: LLMProviderAttempt[];
  fallbackAttempted: boolean;
  visibleStreamStarted: boolean;
  usageAttempts: LLMUsageAttempt[];
  providerError?: ProviderErrorDetails;

  constructor(
    message: string,
    options: {
      reason: ProviderFallbackReason | null;
      provider: ProviderName;
      model?: string;
      status?: number;
      attempts?: LLMProviderAttempt[];
      fallbackAttempted?: boolean;
      visibleStreamStarted?: boolean;
      usageAttempts?: LLMUsageAttempt[];
      providerError?: ProviderErrorDetails;
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = "LLMProviderError";
    this.reason = options.reason;
    this.provider = options.provider;
    this.model = options.model;
    this.status = options.status;
    this.attempts = options.attempts ?? [];
    this.fallbackAttempted = options.fallbackAttempted ?? false;
    this.visibleStreamStarted = options.visibleStreamStarted ?? false;
    this.usageAttempts = options.usageAttempts ?? [];
    this.providerError = options.providerError;
    if (options.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }
}

const MAX_PROVIDER_ERROR_FIELD_LENGTH = 2_000;

function boundedString(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const normalized = String(value).trim();
  return normalized
    ? normalized.slice(0, MAX_PROVIDER_ERROR_FIELD_LENGTH)
    : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * Extracts only common, non-secret provider error fields. Raw response bodies,
 * headers, request payloads, and credentials are never retained.
 */
export function getProviderErrorDetails(
  error: unknown,
): ProviderErrorDetails | undefined {
  const data = (error as { data?: unknown })?.data;
  if (typeof data === "string") {
    const message = boundedString(data);
    return message ? { message } : undefined;
  }

  const root = asRecord(data);
  const errorRecord = asRecord(error);
  const nested = root ? asRecord(root.error) : null;
  const candidate = nested ?? root ?? errorRecord;
  if (!candidate) return undefined;
  const details: ProviderErrorDetails = {
    type: boundedString(candidate.type ?? root?.type),
    code: boundedString(candidate.code ?? root?.code),
    message: boundedString(candidate.message ?? root?.message),
    param: boundedString(candidate.param ?? root?.param),
  };
  return Object.values(details).some(Boolean) ? details : undefined;
}

export function isProviderGlobalLLMFailure(error: unknown): boolean {
  const reason = classifyLLMError(error);
  return reason === "billing_error" || reason === "auth_error";
}

export class LLMStreamTimeoutError extends Error {
  constructor(kind: "first_token" | "idle", timeoutMs: number) {
    const label = kind === "first_token"
      ? "first token timeout"
      : "stream idle timeout";
    super(`LLM ${label} after ${timeoutMs}ms`);
    this.name = "AbortError";
  }
}

export class LLMTranscriptError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "LLMTranscriptError";
    if (options && "cause" in options) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }
}

export function classifyLLMError(
  error: unknown,
): ProviderFallbackReason | null {
  const requestError = error as {
    status?: number;
    statusText?: string;
    name?: string;
    message?: string;
  };

  if (error instanceof LLMTranscriptError) {
    return "invalid_transcript";
  }

  const details = getProviderErrorDetails(error);
  const providerCode = details?.code?.toLowerCase() ?? "";
  const providerMessage = details?.message?.toLowerCase() ?? "";
  if (
    providerCode.includes("insufficient_quota") ||
    providerCode.includes("billing") ||
    providerMessage.includes("credit balance is too low") ||
    providerMessage.includes("purchase credits") ||
    providerMessage.includes("billing quota")
  ) {
    return "billing_error";
  }

  if (requestError?.status === 401 || requestError?.status === 403) {
    return "auth_error";
  }
  if (
    providerCode.includes("invalid_api_key") ||
    providerCode.includes("invalid_auth") ||
    providerMessage.includes("invalid api key") ||
    providerMessage.includes("invalid authentication")
  ) {
    return "auth_error";
  }

  if (
    requestError?.name === "AbortError" ||
    requestError?.status === 408 ||
    requestError?.status === 504
  ) {
    return "timeout";
  }

  if (requestError?.status === 429) {
    return "rate_limit";
  }

  if (
    typeof requestError?.status === "number" &&
    requestError.status >= 500
  ) {
    return "server_error";
  }

  if (
    typeof requestError?.status === "number" &&
    requestError.status >= 400
  ) {
    return "provider_error";
  }

  if (error instanceof Error) {
    return "network";
  }

  return "unknown";
}

export function getErrorStatus(error: unknown): number | undefined {
  const status = (error as { status?: unknown })?.status;
  return typeof status === "number" ? status : undefined;
}

export function getErrorMessage(error: unknown): string {
  const providerMessage = getProviderErrorDetails(error)?.message;
  if (providerMessage) return providerMessage;
  return error instanceof Error ? error.message : String(error);
}
