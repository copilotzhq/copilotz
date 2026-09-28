import type { ChatMessage, ProviderConfig, TokenUsage } from "./types.ts";
import { ContextInputLimitError } from "./errors.ts";
import { estimateTextTokens } from "../authoring/token-estimation/index.ts";
import { type ChatTokenEstimate, estimateChatMessages } from "./chat-tokens.ts";

/** Applies the configured ceiling after the exact wire transcript is formed. */
export function assertEstimatedInputLimit(
  estimate: ChatTokenEstimate,
  config: ProviderConfig | undefined,
): void {
  const limit = config?.limitEstimatedInputTokens;
  if (
    typeof limit === "number" && limit > 0 &&
    estimate.estimatedTokens > limit
  ) {
    throw new ContextInputLimitError(estimate.estimatedTokens, limit);
  }
}

/**
 * Counts tokens in messages and response using the shared lightweight estimator.
 */
export function countTokens(
  messages: ChatMessage[],
  response: string,
  config: ProviderConfig = {},
): Promise<number> {
  return Promise.resolve(
    estimateChatMessages([
      ...messages,
      { role: "assistant", content: response },
    ], config).estimatedTokens,
  );
}

export function estimateUsage(
  messages: ChatMessage[],
  response: string,
  status: TokenUsage["status"],
  metadata?: Pick<TokenUsage, "statusReason" | "stopSequence">,
  config: ProviderConfig = {},
): Promise<TokenUsage> {
  const inputTokens = estimateChatMessages(messages, config).estimatedTokens;
  const outputTokens = estimateTextTokens(response);

  return Promise.resolve({
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    source: "estimated",
    status,
    ...(metadata?.statusReason ? { statusReason: metadata.statusReason } : {}),
    ...(metadata?.stopSequence ? { stopSequence: metadata.stopSequence } : {}),
    rawUsage: null,
  });
}
