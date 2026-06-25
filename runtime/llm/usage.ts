import type { ProviderUsageUpdate, TokenUsage } from "@/runtime/llm/types.ts";

function toNonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : 0;
}

/**
 * Anthropic-compatible APIs report `input_tokens` as non-cached prompt tokens
 * only. Normalize to inclusive `inputTokens` so cache-hit and pricing math can
 * treat cache reads/writes as subsets of the prompt total.
 */
export function withInclusiveInputTokens(
  usage: ProviderUsageUpdate,
): ProviderUsageUpdate {
  if (typeof usage.inputTokens !== "number") return usage;

  const cacheReadInputTokens = toNonNegativeInteger(usage.cacheReadInputTokens);
  const cacheCreationInputTokens = toNonNegativeInteger(
    usage.cacheCreationInputTokens,
  );
  const inclusiveInput = usage.inputTokens +
    cacheReadInputTokens +
    cacheCreationInputTokens;

  const outputTokens = usage.outputTokens;
  const totalTokens = outputTokens !== undefined
    ? inclusiveInput + outputTokens
    : usage.totalTokens;

  return {
    ...usage,
    inputTokens: inclusiveInput,
    totalTokens,
  };
}

/**
 * Prompt cache hit rate when `inputTokens` is inclusive (cache is a subset).
 * Returns null when input is missing or zero.
 */
export function promptCacheHitRate(
  usage: Pick<ProviderUsageUpdate, "inputTokens" | "cacheReadInputTokens">,
): number | null {
  const input = usage.inputTokens;
  const cache = usage.cacheReadInputTokens;
  if (typeof input !== "number" || input <= 0) return null;
  if (typeof cache !== "number" || cache < 0) return null;
  return cache / input;
}

/**
 * Rebuild inclusive prompt totals from Anthropic-style `rawUsage` payloads
 * persisted on older usage rows.
 */
export function inclusiveInputTokensFromRawUsage(
  rawUsage: Record<string, unknown> | null | undefined,
  fallbackInputTokens: number,
): number {
  if (!rawUsage || typeof rawUsage !== "object") return fallbackInputTokens;
  if (typeof rawUsage.input_tokens !== "number") return fallbackInputTokens;

  return toNonNegativeInteger(rawUsage.input_tokens) +
    toNonNegativeInteger(rawUsage.cache_read_input_tokens) +
    toNonNegativeInteger(rawUsage.cache_creation_input_tokens);
}

export function normalizeProviderUsage(
  usage: ProviderUsageUpdate | undefined,
  status: TokenUsage["status"],
  metadata?: Pick<TokenUsage, "statusReason" | "stopSequence">,
): TokenUsage | null {
  if (!usage) return null;

  const inputTokens = typeof usage.inputTokens === "number"
    ? usage.inputTokens
    : undefined;
  const outputTokens = typeof usage.outputTokens === "number"
    ? usage.outputTokens
    : undefined;
  const reasoningTokens = typeof usage.reasoningTokens === "number"
    ? usage.reasoningTokens
    : undefined;
  const cacheReadInputTokens = typeof usage.cacheReadInputTokens === "number"
    ? usage.cacheReadInputTokens
    : undefined;
  const cacheCreationInputTokens =
    typeof usage.cacheCreationInputTokens === "number"
      ? usage.cacheCreationInputTokens
      : undefined;
  const totalTokens = typeof usage.totalTokens === "number"
    ? usage.totalTokens
    : (inputTokens !== undefined && outputTokens !== undefined)
    ? inputTokens + outputTokens
    : undefined;

  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    reasoningTokens === undefined &&
    cacheReadInputTokens === undefined &&
    cacheCreationInputTokens === undefined &&
    totalTokens === undefined &&
    !usage.rawUsage
  ) {
    return null;
  }

  return {
    inputTokens,
    outputTokens,
    reasoningTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens,
    totalTokens,
    source: "provider",
    status,
    ...(metadata?.statusReason ? { statusReason: metadata.statusReason } : {}),
    ...(metadata?.stopSequence ? { stopSequence: metadata.stopSequence } : {}),
    rawUsage: usage.rawUsage ?? null,
  };
}
