import type {
  ChatContentPart,
  ChatMessage,
  ExtractedPart,
  ProviderConfig,
  ProviderFactory,
  ProviderFinishReason,
  ProviderUsageUpdate,
} from "@/runtime/llm/types.ts";
import { resolveProviderStopSequences } from "@/runtime/llm/utils.ts";

/**
 * MiniMax adapter targeting the Anthropic-compatible Messages API
 * (`/anthropic/v1/messages`). This endpoint is MiniMax's recommended path and
 * the only one exposing MiniMax-M3's multimodal (image/video) input.
 *
 * Tool calling stays on Copilotz's universal prompt-injection convention (no
 * native `tools` are sent), so malformed/native tool dialects are handled by
 * the shared parser + recovery path rather than per-model logic here.
 */

const DEFAULT_MODEL = "MiniMax-M3";
const DEFAULT_MAX_TOKENS = 4096;

function dataUrlSource(dataUrl: string): {
  mimeType: string;
  base64Data: string;
} | null {
  if (!dataUrl.startsWith("data:")) return null;
  const header = dataUrl.substring(5);
  const [mimeType, base64Data] = header.split(";base64,");
  if (!mimeType || !base64Data) return null;
  return { mimeType, base64Data };
}

/**
 * Build a MiniMax `image`/`video` content block. Data URLs become `base64`
 * sources; everything else (http(s) URLs and `mm_file://{file_id}` refs) is
 * passed through as a `url` source.
 */
function mediaBlock(
  type: "image" | "video",
  url: string,
  mimeType?: string,
): Record<string, unknown> {
  const source = dataUrlSource(url);
  if (source) {
    return {
      type,
      source: {
        type: "base64",
        media_type: mimeType ?? source.mimeType,
        data: source.base64Data,
      },
    };
  }
  return { type, source: { type: "url", url } };
}

function textOf(parts: ChatContentPart[]): string {
  return parts
    .filter((p): p is Extract<ChatContentPart, { type: "text" }> =>
      p.type === "text"
    )
    .map((p) => p.text)
    .join("\n");
}

function transformMessages(
  messages: ChatMessage[],
): { messages: Record<string, unknown>[]; system?: string } {
  const systemPrompts: string[] = [];
  const out: Record<string, unknown>[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      const text = typeof msg.content === "string"
        ? msg.content
        : textOf(msg.content);
      if (text) systemPrompts.push(text);
      continue;
    }

    // The Anthropic-compatible API only accepts `user`/`assistant` roles.
    const role = msg.role === "assistant" ? "assistant" : "user";

    let contentBlocks: Record<string, unknown>[];
    if (typeof msg.content === "string") {
      contentBlocks = [{ type: "text", text: msg.content }];
    } else if (Array.isArray(msg.content)) {
      contentBlocks = msg.content.flatMap((part) => {
        if (part.type === "text") {
          return [{ type: "text", text: part.text }];
        }
        if (part.type === "image_url" && part.image_url?.url) {
          return [mediaBlock("image", part.image_url.url)];
        }
        if (part.type === "video" && part.video?.url) {
          return [mediaBlock("video", part.video.url, part.video.mime_type)];
        }
        return [] as Record<string, unknown>[];
      });
    } else {
      contentBlocks = [];
    }

    out.push({ role, content: contentBlocks });
  }

  return {
    messages: out,
    system: systemPrompts.join("\n") || undefined,
  };
}

function normalizeTemperature(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  // MiniMax accepts [0, 2]; values outside the range return an error.
  return Math.min(Math.max(value, 0), 2);
}

function normalizeTopP(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.min(Math.max(value, 0), 1);
}

function extractMiniMaxFinishReason(data: any): ProviderFinishReason | null {
  const reason = data?.delta?.stop_reason ?? data?.message?.stop_reason;
  if (reason === "max_tokens") return "length";
  if (reason === "end_turn" || reason === "stop_sequence") return "stop";
  if (reason === "tool_use") return "tool_calls";
  return typeof reason === "string" ? "unknown" : null;
}

function extractMiniMaxUsage(data: any): ProviderUsageUpdate | null {
  const usage = data?.type === "message_start"
    ? data?.message?.usage
    : data?.usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;

  const inputTokens = typeof usage.input_tokens === "number"
    ? usage.input_tokens
    : undefined;
  const outputTokens = typeof usage.output_tokens === "number"
    ? usage.output_tokens
    : undefined;

  return {
    inputTokens,
    outputTokens,
    cacheReadInputTokens: typeof usage.cache_read_input_tokens === "number"
      ? usage.cache_read_input_tokens
      : undefined,
    cacheCreationInputTokens:
      typeof usage.cache_creation_input_tokens === "number"
        ? usage.cache_creation_input_tokens
        : undefined,
    totalTokens: inputTokens !== undefined && outputTokens !== undefined
      ? inputTokens + outputTokens
      : undefined,
    rawUsage: usage as Record<string, unknown>,
  };
}

export const minimaxProvider: ProviderFactory = (config: ProviderConfig) => {
  const baseUrl = (config.baseUrl || "https://api.minimax.io").replace(
    /\/$/,
    "",
  );

  return {
    endpoint: `${baseUrl}/anthropic/v1/messages`,

    headers: (config: ProviderConfig) => ({
      "Content-Type": "application/json",
      "Authorization": `Bearer ${config.apiKey || ""}`,
    }),

    transformMessages,

    body: (messages: ChatMessage[], config: ProviderConfig) => {
      const transformed = transformMessages(messages);

      const maxCompletionTokens = config.maxCompletionTokens ??
        config.maxTokens;
      const maxTokens = typeof maxCompletionTokens === "number" &&
          Number.isFinite(maxCompletionTokens) && maxCompletionTokens > 0
        ? Math.floor(maxCompletionTokens)
        : DEFAULT_MAX_TOKENS;

      const body: Record<string, unknown> = {
        model: config.model || DEFAULT_MODEL,
        messages: transformed.messages,
        stream: true,
        max_tokens: maxTokens,
      };

      if (transformed.system) body.system = transformed.system;

      const temperature = normalizeTemperature(config.temperature);
      if (temperature !== undefined) body.temperature = temperature;

      const topP = normalizeTopP(config.topP);
      if (topP !== undefined) body.top_p = topP;

      // MiniMax-M3 thinking is off by default; enable adaptive thinking when
      // the caller requests any reasoning effort. M2.x models always think.
      if (config.reasoningEffort) {
        body.thinking = { type: "adaptive" };
      }

      if (config.metadata) body.metadata = config.metadata;

      // Forward stop sequences for parity with the other Anthropic-style
      // adapters and to halt server-side once MiniMax honors them. NOTE: as of
      // now MiniMax's Anthropic-compatible API documents `stop_sequences` as
      // ignored, so this is a no-op there and Copilotz's client-side stop
      // enforcement remains the effective mechanism for MiniMax.
      const stopSequences = resolveProviderStopSequences(config);
      if (stopSequences) body.stop_sequences = stopSequences;

      // Note: MiniMax ignores `top_k`, and the Anthropic-compatible request has
      // no top-level `cache_control`, so we intentionally omit them.

      return body;
    },

    extractContent: (data: any): ExtractedPart[] | null => {
      if (data?.type !== "content_block_delta" || !data?.delta) return null;
      const parts: ExtractedPart[] = [];

      if (data.delta.type === "thinking_delta") {
        const thinking = data.delta.thinking || "";
        if (thinking) parts.push({ text: thinking, isReasoning: true });
      } else if (data.delta.type === "text_delta") {
        const text = data.delta.text || "";
        if (text) parts.push({ text });
      }

      return parts.length > 0 ? parts : null;
    },

    extractUsage: extractMiniMaxUsage,
    extractFinishReason: extractMiniMaxFinishReason,
  };
};
