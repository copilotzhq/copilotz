import type {
  ChatMessage,
  ChatRequest,
  ToolDefinition,
} from "@/runtime/llm/types.ts";
import { materializeAssetRefsForProvider } from "@/runtime/llm/asset-materialization.ts";
import type { AssetConfig, AssetStore } from "@/runtime/storage/assets.ts";
import type { Agent } from "@/types/index.ts";

export interface PrepareAgentChatRequestOptions {
  messages: ChatMessage[];
  tools: ToolDefinition[];
  agent?: Pick<Agent, "assetOptions"> | null;
  assetConfig?: AssetConfig;
  assetStore?: AssetStore;
  debugLabel?: string;
}

export interface PreparedAgentChatRequest {
  request: ChatRequest;
  resolvesAssets: boolean;
}

function debugEnabled(): boolean {
  try {
    return Deno.env.get("COPILOTZ_DEBUG") === "1";
  } catch {
    return false;
  }
}

function textOnlyMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) => {
    if (!Array.isArray(message.content)) return message;
    const content = message.content
      .map((part) => part.type === "text" ? part.text : "")
      .join("");
    return { ...message, content };
  });
}

/**
 * Builds the provider-independent request shared by normal agent calls and
 * background agent work such as long-term-memory consolidation.
 *
 * Asset refs remain unresolved until each provider attempt so fallbacks never
 * inherit another provider's media wire format.
 */
export function prepareAgentChatRequest(
  options: PrepareAgentChatRequestOptions,
): PreparedAgentChatRequest {
  const perAgentResolve = options.agent?.assetOptions?.resolveInLLM;
  const resolvesAssets = perAgentResolve !== undefined
    ? perAgentResolve
    : options.assetConfig?.resolveInLLM !== false;
  const label = options.debugLabel ?? "agent_chat";

  if (resolvesAssets && !options.assetStore && debugEnabled()) {
    console.warn(
      `[${label}] resolveInLLM is true but assetStore is undefined; asset refs will be represented as unavailable`,
    );
  }

  const request: ChatRequest = {
    messages: resolvesAssets
      ? options.messages
      : textOnlyMessages(options.messages),
    tools: options.tools,
  };

  if (resolvesAssets) {
    request.materializeMessages = async (messages, providerConfig) => {
      try {
        return await materializeAssetRefsForProvider(
          messages,
          providerConfig,
          options.assetStore,
        );
      } catch (error) {
        if (debugEnabled()) {
          console.warn(
            `[${label}] materializeAssetRefsForProvider failed:`,
            error,
          );
        }
        return textOnlyMessages(messages);
      }
    };
  }

  return { request, resolvesAssets };
}
