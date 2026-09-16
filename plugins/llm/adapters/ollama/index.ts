/** Ollama provider adapter wire protocol. @module */
// deno-lint-ignore-file no-explicit-any
// Private vendor-wire decoder: payload shapes are provider-controlled JSON.
import type {
  ChatContentPart,
  ChatMessage,
  ExtractedPart,
  ProviderConfig,
  ProviderFactory,
  ProviderFinishReason,
} from "../../shared/types.ts";
import { providerEndpoint } from "../transport/index.ts";
import {
  matchingNativeBlocks,
  stringField,
} from "../native-reasoning/index.ts";

function extractOllamaFinishReason(data: any): ProviderFinishReason | null {
  if (data?.done !== true) return null;
  const reason = data?.done_reason;
  if (reason === "length") return "length";
  if (reason === "stop" || reason === "unload") return "stop";
  return typeof reason === "string" ? "unknown" : "stop";
}

export const ollamaProvider: ProviderFactory = (config: ProviderConfig) => {
  let thinking = "";

  return {
    endpoint: providerEndpoint(
      config.baseUrl,
      "http://localhost:11434",
      "api/chat",
    ),

    headers: (config: ProviderConfig) => ({
      ...(config.extraHeaders ?? {}),
      "Content-Type": "application/json",
    }),

    body: (messages: ChatMessage[], config: ProviderConfig) => {
      const ollamaMessages = messages.map((msg) => {
        if (Array.isArray(msg.content)) {
          const parts = msg.content as ChatContentPart[];
          const text = parts
            .filter((p) => p.type === "text")
            .map((p) => (p as Extract<ChatContentPart, { type: "text" }>).text)
            .join("");
          const images: string[] = [];
          for (const p of parts) {
            if (
              p.type === "image_url" && p.image_url?.url &&
              p.image_url.url.startsWith("data:")
            ) {
              const base64 = p.image_url.url.split(",")[1];
              if (base64) images.push(base64);
            } else if (
              p.type === "file" && typeof p.file?.file_data === "string" &&
              p.file.file_data.startsWith("data:")
            ) {
              const base64 = p.file.file_data.split(",")[1];
              if (base64) images.push(base64);
            }
          }
          const nativeBlocks = matchingNativeBlocks(
            msg,
            config,
            "ollama",
            "ollama.chat",
            config.model || "llama3.2",
          );
          const nativeThinking = nativeBlocks?.map((block) =>
            stringField(block, "thinking")
          ).filter((value): value is string => value !== undefined).join("");
          const m: any = {
            role: msg.role,
            content: text,
            ...(nativeThinking ? { thinking: nativeThinking } : {}),
          };
          if (images.length > 0) m.images = images;
          return m;
        }
        const nativeBlocks = matchingNativeBlocks(
          msg,
          config,
          "ollama",
          "ollama.chat",
          config.model || "llama3.2",
        );
        const nativeThinking = nativeBlocks?.map((block) =>
          stringField(block, "thinking")
        ).filter((value): value is string => value !== undefined).join("");
        return {
          role: msg.role,
          content: msg.content,
          ...(nativeThinking ? { thinking: nativeThinking } : {}),
        } as any;
      });

      return {
        model: config.model || "llama3.2",
        messages: ollamaMessages,
        stream: true,
        options: {
          temperature: config.temperature || 0,
          num_predict: config.maxTokens || 1000,
          top_p: config.topP,
          top_k: config.topK,
          repeat_penalty: config.repeatPenalty,
          seed: config.seed,
          stop: config.stop,
          num_ctx: config.numCtx,
        },
      };
    },

    extractContent: (data: any): ExtractedPart[] | null => {
      const message = data?.message;
      const parts: ExtractedPart[] = [];
      if (typeof message?.thinking === "string" && message.thinking) {
        parts.push({ text: message.thinking, isReasoning: true });
      }
      if (typeof message?.content === "string" && message.content) {
        parts.push({ text: message.content });
      }
      return parts.length > 0 ? parts : null;
    },

    nativeReasoningApi: "ollama.chat",
    extractNativeReasoning: (data: any): Record<string, unknown>[] | null => {
      if (typeof data?.message?.thinking === "string") {
        thinking += data.message.thinking;
      }
      const successful = data?.done === true &&
        (data.done_reason === undefined || data.done_reason === "stop");
      return successful && thinking ? [{ thinking }] : null;
    },
    isStreamActivity: (data: any) =>
      Boolean(data?.message) || data?.done === true,
    extractFinishReason: extractOllamaFinishReason,

    streamOptions: { format: "jsonl" },
  };
};
