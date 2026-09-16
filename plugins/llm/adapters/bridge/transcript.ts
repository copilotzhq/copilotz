import type {
  ChatMessage,
  ChatRequest,
  ProviderConfig,
} from "../../shared/types.ts";
import { toLLMConfig } from "./config.ts";
import {
  assertEstimatedInputLimit,
  formatMessagesDetailed,
} from "../../shared/utils.ts";
import {
  type ChatTokenEstimate,
  estimateChatMessages,
} from "../../shared/chat-tokens.ts";

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

/**
 * Provider-attempt transcript seam. The existing normalization/budgeting
 * implementation remains untouched behind this boundary.
 */
export async function prepareAttemptTranscript(args: {
  request: ChatRequest;
  config: ProviderConfig;
  recoveryMessages?: ChatMessage[];
}): Promise<PreparedAttemptTranscript> {
  const materialized = args.request.materializeMessages
    ? await args.request.materializeMessages(
      args.request.messages,
      args.config,
    )
    : args.request.messages;
  const config = toLLMConfig(args.config);
  const recoveryMessages = args.recoveryMessages ?? [];
  const formatted = formatMessagesDetailed({
    ...args.request,
    messages: materialized,
    config,
  });
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

  const inputTokenEstimate = estimateChatMessages(messages, config);
  // Recovery context is part of the provider request, so enforce the same
  // ceiling after it is appended instead of silently discarding history.
  assertEstimatedInputLimit(inputTokenEstimate, config);
  return {
    messages,
    promptFingerprint,
    promptPrefixFingerprint,
    promptPrefixMessageCount,
    inputTokenEstimate,
  };
}
