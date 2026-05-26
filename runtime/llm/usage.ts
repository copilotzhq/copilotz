import type {
  ProviderUsageUpdate,
  TokenUsage,
} from "@/runtime/llm/types.ts";

export function normalizeProviderUsage(
  usage: ProviderUsageUpdate | undefined,
  status: TokenUsage["status"],
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
    rawUsage: usage.rawUsage ?? null,
  };
}
