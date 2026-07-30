import type {
  ChatMessage,
  ChatRequest,
  ProviderConfig,
} from "@/runtime/llm/types.ts";
import { toLLMConfig } from "@/runtime/llm/config.ts";
import { formatMessagesDetailed } from "@/runtime/llm/utils.ts";
import { estimateChatMessages } from "@/runtime/tokens/index.ts";
import type { ChatTokenEstimate } from "@/runtime/tokens/chat.ts";

export interface PreparedAttemptTranscript {
  messages: ChatMessage[];
  promptFingerprint: string;
  promptPrefixFingerprint: string;
  promptPrefixMessageCount: number;
  inputTokenEstimate: ChatTokenEstimate;
}

async function fingerprintMessages(messages: ChatMessage[]): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(messages));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function promptProfileKey(
  config: ProviderConfig,
  namespace = "default",
): string {
  return `${namespace}:${config.provider ?? "unknown"}:${
    config.model ?? "default"
  }:${config.limitEstimatedInputTokens ?? 0}`;
}

function applyHistoryCutoff(
  messages: ChatMessage[],
  sourceEndMessageId: string | undefined,
): { messages: ChatMessage[]; found: boolean } {
  if (!sourceEndMessageId) return { messages, found: false };
  const boundary = messages.findIndex((message) =>
    message.metadata?.sourceMessageId === sourceEndMessageId
  );
  if (boundary < 0) return { messages, found: false };
  return {
    messages: [
      ...messages.filter((message, index) =>
        message.role === "system" && index <= boundary
      ),
      ...messages.slice(boundary + 1),
    ],
    found: true,
  };
}

/**
 * Provider-attempt transcript seam. The existing normalization/budgeting
 * implementation remains untouched behind this boundary.
 */
export async function prepareAttemptTranscript(args: {
  request: ChatRequest;
  config: ProviderConfig;
  recoveryMessages?: ChatMessage[];
}): Promise<PreparedAttemptTranscript> {
  const profileKey = promptProfileKey(
    args.config,
    args.request.historyCutoffNamespace,
  );
  const persistedCutoff = args.request.historyCutoffs?.[profileKey];
  const cutoffApplied = applyHistoryCutoff(
    args.request.messages,
    persistedCutoff,
  );
  if (persistedCutoff && !cutoffApplied.found) {
    await args.request.onHistoryCutoff?.(profileKey, null);
  }

  const materialized = args.request.materializeMessages
    ? await args.request.materializeMessages(
      cutoffApplied.messages,
      args.config,
    )
    : cutoffApplied.messages;
  const config = toLLMConfig(args.config);
  const recoveryMessages = args.recoveryMessages ?? [];
  const recoveryEstimatedTokens = recoveryMessages.length > 0
    ? estimateChatMessages(recoveryMessages, args.config).estimatedTokens
    : 0;
  const baseInputLimit = typeof config.limitEstimatedInputTokens === "number" &&
      config.limitEstimatedInputTokens > 0
    ? Math.max(1, config.limitEstimatedInputTokens - recoveryEstimatedTokens)
    : config.limitEstimatedInputTokens;
  const formatted = formatMessagesDetailed({
    ...args.request,
    messages: materialized,
    config: {
      ...config,
      limitEstimatedInputTokens: baseInputLimit,
    },
  });
  if (
    formatted.cutoffSourceMessageId &&
    formatted.cutoffSourceMessageId !== persistedCutoff
  ) {
    await args.request.onHistoryCutoff?.(
      profileKey,
      formatted.cutoffSourceMessageId,
    );
  }

  const messages = [
    ...formatted.messages,
    ...recoveryMessages,
  ];
  const promptPrefixMessageCount = Math.min(
    Math.max(
      args.request.debugPromptPrefixMessageCount ?? messages.length,
      0,
    ),
    messages.length,
  );
  const [promptFingerprint, promptPrefixFingerprint] = await Promise.all([
    fingerprintMessages(messages),
    fingerprintMessages(messages.slice(0, promptPrefixMessageCount)),
  ]);

  return {
    messages,
    promptFingerprint,
    promptPrefixFingerprint,
    promptPrefixMessageCount,
    inputTokenEstimate: estimateChatMessages(messages, args.config),
  };
}
