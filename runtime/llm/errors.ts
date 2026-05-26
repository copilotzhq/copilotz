import type {
  ProviderFallbackReason,
  ProviderName,
} from "@/runtime/llm/types.ts";

export type LLMProviderAttempt = {
  provider: ProviderName;
  model?: string;
  reason?: ProviderFallbackReason | null;
  status?: number;
  message?: string;
};

export class LLMProviderError extends Error {
  reason: ProviderFallbackReason | null;
  provider: ProviderName;
  model?: string;
  status?: number;
  attempts: LLMProviderAttempt[];
  fallbackAttempted: boolean;
  visibleStreamStarted: boolean;

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
    if (options.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }
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

export function classifyLLMError(
  error: unknown,
): ProviderFallbackReason | null {
  const requestError = error as {
    status?: number;
    statusText?: string;
    name?: string;
    message?: string;
  };

  if (requestError?.status === 401 || requestError?.status === 403) {
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
  return error instanceof Error ? error.message : String(error);
}
