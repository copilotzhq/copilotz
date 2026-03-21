import type {
  ChatContentPart,
  ChatMessage,
  ProviderConfig,
  ProviderFactory,
  ExtractedPart,
} from "../types.ts";

type MiniMaxRole = "system" | "user" | "assistant";

function toMiniMaxRole(role: ChatMessage["role"]): MiniMaxRole {
  if (role === "assistant") return "assistant";
  if (role === "system") return "system";
  return "user";
}

function flattenTextContent(content: string | ChatContentPart[]): string {
  if (typeof content === "string") return content;

  return content
    .filter((part) => part.type === "text")
    .map((part) => (part as Extract<ChatContentPart, { type: "text" }>).text)
    .join("\n");
}

function normalizeTemperature(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 1;
  }
  return Math.min(value, 1);
}

function normalizeTopP(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 0.95;
  }
  return Math.min(value, 1);
}

/**
 * Strip <output>...</output> wrapper that MiniMax-M2.7 puts around the final answer.
 * If the tags are absent (e.g. non-reasoning models), the text is returned as-is.
 */
function stripOutputTags(text: string): string {
  return text
    .replace(/<output>/g, "")
    .replace(/<\/output>/g, "")
    .trim();
}

export const minimaxProvider: ProviderFactory = (config: ProviderConfig) => {
  const baseUrl = config.baseUrl || "https://api.minimax.io";

  return {
    endpoint: `${baseUrl.replace(/\/$/, "")}/v1/text/chatcompletion_v2`,

    headers: (config: ProviderConfig) => ({
      "Content-Type": "application/json",
      "Authorization": `Bearer ${config.apiKey || ""}`,
    }),

    body: (messages: ChatMessage[], config: ProviderConfig) => {
      const minimaxMessages = messages.map((message) => ({
        role: toMiniMaxRole(message.role),
        content: flattenTextContent(message.content),
      }));

      const body: Record<string, unknown> = {
        model: config.model || "M2-her",
        messages: minimaxMessages,
        stream: true,
        temperature: normalizeTemperature(config.temperature),
        top_p: normalizeTopP(config.topP),
      };

      const maxCompletionTokens = config.maxCompletionTokens ?? config.maxTokens;
      if (
        typeof maxCompletionTokens === "number" &&
        Number.isFinite(maxCompletionTokens) &&
        maxCompletionTokens > 0
      ) {
        body.max_completion_tokens = Math.min(Math.floor(maxCompletionTokens), 2048);
      }

      return body;
    },

    extractContent: (data: any): ExtractedPart[] | null => {
      const delta = data?.choices?.[0]?.delta;
      if (!delta) return null;
      const parts: ExtractedPart[] = [];

      if (delta.reasoning_content) {
        parts.push({ text: delta.reasoning_content, isReasoning: true });
      }
      if (delta.content) {
        const cleaned = stripOutputTags(delta.content);
        if (cleaned) parts.push({ text: cleaned });
      }

      return parts.length > 0 ? parts : null;
    },

    streamOptions: {
      postProcess: stripOutputTags,
    },
  };
};

