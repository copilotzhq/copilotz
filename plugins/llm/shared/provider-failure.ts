/** Safe retry disposition for an incomplete provider invocation. */
export type ProviderFailure = Readonly<{
  code: string;
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
}>;

const messages: Record<string, string> = {
  network: "I couldn't reach the model provider.",
  timeout: "The model provider timed out before completing the response.",
  rate_limit: "The model provider is rate limiting requests.",
  server_error: "The model provider is temporarily unavailable.",
  auth_error: "The model provider rejected its credentials.",
  billing_error:
    "The model provider rejected the request because of billing or quota.",
  provider_error: "The model provider rejected the request.",
};

/** Retry-After is untrusted: retain only a bounded delay, never raw headers. */
export function providerRetryAfter(
  value: string | null,
  now = Date.now(),
): number | undefined {
  if (!value?.trim()) return undefined;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds)
    ? seconds * 1000
    : Date.parse(value) - now;
  return Number.isFinite(delay) && delay >= 0
    ? Math.min(30_000, Math.ceil(delay))
    : undefined;
}

export function providerFailure(error: unknown): ProviderFailure | undefined {
  let current = error;
  const visited = new Set<object>();
  let reason: string | undefined, retryAfterMs: number | undefined;
  while (current && typeof current === "object" && !visited.has(current)) {
    visited.add(current);
    const value = current as Record<string, unknown>;
    if (
      typeof value.retryAfterMs === "number" &&
      Number.isFinite(value.retryAfterMs)
    ) {
      retryAfterMs = Math.min(30_000, Math.max(0, value.retryAfterMs));
    }
    const status = value.status;
    const explicit = typeof value.reason === "string"
      ? value.reason
      : undefined;
    const message = typeof value.message === "string" ? value.message : "";
    const code = typeof value.code === "string" ? value.code : "";
    const details = value.providerError as { code?: unknown } | undefined;
    const refusal = /content_filter|content_policy_violation|refusal/.test(
      String(details?.code ?? code),
    ) ||
      Array.isArray(value.usageAttempts) &&
        value.usageAttempts.some((attempt) =>
          attempt?.usage?.statusReason === "content_filter"
        );
    reason ??= refusal
      ? "provider_error"
      : explicit && messages[explicit]
      ? explicit
      : status === 401 || status === 403
      ? "auth_error"
      : status === 429
      ? "rate_limit"
      : status === 408 || status === 504
      ? "timeout"
      : typeof status === "number" && status >= 500
      ? "server_error"
      : typeof status === "number" && status >= 400
      ? "provider_error"
      : value.name === "AbortError" || value.name === "TimeoutError" ||
          /ETIMEDOUT/.test(code)
      ? "timeout"
      : /ECONNRESET|ECONNREFUSED|EPIPE|ENOTFOUND|EAI_AGAIN/.test(code) ||
          /fetch failed|failed to fetch|network error|connection reset|connection closed|close_notify|TLS|socket hang up/i
            .test(message)
      ? "network"
      : undefined;
    current = value.cause;
  }
  if (!reason) return undefined;
  return {
    code: `llm_provider_${reason}`,
    message: messages[reason],
    retryable: ["network", "timeout", "rate_limit", "server_error"].includes(
      reason,
    ),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  };
}

export function providerFailureError(error: unknown): unknown {
  const disposition = providerFailure(error);
  return disposition
    ? Object.assign(
      new Error(disposition.message, { cause: error }),
      disposition,
    )
    : error;
}
