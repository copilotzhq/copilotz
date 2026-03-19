import type {
  ChatContentPart,
  ChatMessage,
  ProviderConfig,
  ProviderFactory,
  StreamCallback,
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

    // Standard extractContent – used by the default processStream path if
    // processStream below is not defined, and also by non-streaming helpers.
    extractContent: (data: any) => {
      return data?.choices?.[0]?.delta?.content || null;
    },

    /**
     * Custom stream processor for MiniMax reasoning models (e.g. MiniMax-M2.7).
     *
     * These models use a two-phase streaming format:
     *   1. Reasoning phase  – tokens arrive in `delta.reasoning_content`; `delta.content` is "".
     *   2. Answer phase     – the final answer arrives in `delta.content`, wrapped in <output>…</output>.
     *
     * This processor:
     *   - Streams reasoning tokens to the caller so the user can see the model thinking.
     *   - Collects content tokens, strips the <output> wrapper, and returns the clean answer.
     */
    processStream: async (
      reader: ReadableStreamDefaultReader<Uint8Array>,
      onChunk: StreamCallback,
      _extractContent: (data: any) => string | null,
      config: ProviderConfig,
    ): Promise<string> => {
      const decoder = new TextDecoder("utf-8");
      let buffer = "";
      let finalContent = "";
      let reasoningStarted = false;

      const parseLine = (line: string): any | null => {
        if (!line.startsWith("data:")) return null;
        const raw = line.slice(5).trim();
        if (raw === "[DONE]") return null;
        try {
          return JSON.parse(raw);
        } catch {
          return null;
        }
      };

      const handleData = (data: any) => {
        const delta = data?.choices?.[0]?.delta;
        if (!delta) return;

        const reasoningChunk: string = delta.reasoning_content ?? "";
        const contentChunk: string = delta.content ?? "";

        // Stream reasoning tokens so callers can display "thinking" output.
        // We do not output reasoning tokens if config.outputReasoning is explicitly false.
        if (reasoningChunk && config.outputReasoning !== false) {
          if (!reasoningStarted) {
            reasoningStarted = true;
          }
          onChunk(reasoningChunk, { isReasoning: true });
        }

        // Collect final-answer content tokens.
        if (contentChunk) {
          if (reasoningStarted) {
            reasoningStarted = false;
          }
          finalContent += contentChunk;
        }
      };

      try {
        while (true) {
          const { done, value } = await reader.read();

          if (done) {
            if (buffer) {
              for (const line of buffer.split("\n")) {
                const data = parseLine(line);
                if (data) handleData(data);
              }
            }
            break;
          }

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            const data = parseLine(line);
            if (data) handleData(data);
          }
        }
      } catch (err) {
        console.error("[minimax] Stream processing error:", err);
        throw err;
      }

      // Strip <output>…</output> wrapper from the final collected answer.
      const cleanAnswer = stripOutputTags(finalContent);

      // Emit the clean answer as the final token chunk so callers that only
      // capture onChunk output also see the untagged text.
      if (cleanAnswer) {
        onChunk(cleanAnswer);
      }

      return cleanAnswer;
    },
  };
};

