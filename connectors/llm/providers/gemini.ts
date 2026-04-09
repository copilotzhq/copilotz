import type { ChatMessage, ProviderConfig, ProviderFactory, ExtractedPart, ProviderUsageUpdate } from "../types.ts";

interface GeminiPart {
  text?: string;
  inline_data?: {
    mime_type: string;
    data: string;
  };
}

interface GeminiMessage {
  parts: GeminiPart[];
  role: "user" | "model";
}

function getEnvFlag(key: string): string | undefined {
  try {
    const anyGlobal = globalThis as unknown as {
      Deno?: { env?: { get?: (name: string) => string | undefined } };
      process?: { env?: Record<string, string | undefined> };
    };

    const fromDeno = anyGlobal?.Deno?.env?.get?.(key);
    if (typeof fromDeno === "string") return fromDeno;

    const fromNode = anyGlobal?.process?.env?.[key];
    if (typeof fromNode === "string") return fromNode;
  } catch {
    // Ignore env lookup failures in unsupported runtimes.
  }

  return undefined;
}

/**
 * Build the Gemini `thinkingConfig` for a model, or return undefined to omit it.
 *
 * Model families:  2.5 → thinkingBudget,  3.x/exp → thinkingLevel.
 * Lite models only think when explicitly requested (reasoningEffort or geminiThinkingConfig).
 */
function buildThinkingConfig(
  config: ProviderConfig,
  model: string,
): Record<string, unknown> | undefined {
  if (config.outputReasoning === false) return undefined;

  const g = config.geminiThinkingConfig;
  if (g?.includeThoughts === false) return undefined;

  const m = model.toLowerCase().replace(/^models\//, "");
  const is25 = /^gemini-2\.5/.test(m);
  const is3x = /^gemini-3/.test(m) || /gemini-exp/.test(m);
  if (!is25 && !is3x && !g?.includeThoughts) return undefined;

  const isLite = m.includes("-lite");
  if (isLite && !config.reasoningEffort && !g) return undefined;

  const effort = config.reasoningEffort;
  let effortFields: Record<string, unknown> | undefined;
  if (effort && !g?.thinkingLevel && g?.thinkingBudget == null) {
    effortFields = is3x
      ? { thinkingLevel: { minimal: "MINIMAL", low: "LOW", medium: "MEDIUM", high: "HIGH" }[effort] }
      : { thinkingBudget: { minimal: 0, low: 2048, medium: 8192, high: -1 }[effort] };
  }

  return { includeThoughts: true, ...effortFields, ...g };
}

export const geminiProvider: ProviderFactory = (config: ProviderConfig) => {
  const debugStream = getEnvFlag("COPILOTZ_DEBUG_GEMINI_STREAM") === "1" ||
    getEnvFlag("COPILOTZ_DEBUG") === "1";
  let streamEventIndex = 0;
  let lastVisibleSnapshot = "";
  let lastReasoningSnapshot = "";

  const transformMessages = (messages: ChatMessage[]) => {
    const systemPrompts: string[] = [];
    const geminiMessages: GeminiMessage[] = [];

    messages.forEach((msg) => {
      if (msg.role === "system") {
        systemPrompts.push(
          typeof msg.content === "string"
            ? msg.content
            : JSON.stringify(msg.content),
        );
      } else {
        const parts: GeminiPart[] = [];

        if (Array.isArray(msg.content)) {
          msg.content.forEach((item: any) => {
            if (item.type === "text") {
              parts.push({ text: item.text });
            } else if (item.type === "image_url" && item.image_url?.url) {
              const url = item.image_url.url;
              if (url.startsWith("data:")) {
                const [mimeType, base64Data] = url.substring(5).split(
                  ";base64,",
                );
                parts.push({
                  inline_data: {
                    mime_type: mimeType,
                    data: base64Data,
                  },
                });
              }
            } else if (item.type === "input_audio" && item.input_audio?.data) {
              parts.push({
                inline_data: {
                  mime_type: `audio/${item.input_audio.format || "wav"}`,
                  data: item.input_audio.data,
                },
              });
            } else if (item.type === "file" && item.file?.file_data) {
              const fileData = item.file.file_data;
              if (fileData.startsWith("data:")) {
                const [mimeType, base64Data] = fileData.substring(5).split(
                  ";base64,",
                );
                parts.push({
                  inline_data: {
                    mime_type: mimeType,
                    data: base64Data,
                  },
                });
              }
            }
          });
        } else {
          parts.push({
            text: typeof msg.content === "string"
              ? msg.content
              : JSON.stringify(msg.content),
          });
        }

        geminiMessages.push({
          parts,
          role: msg.role === "user" ? "user" : "model",
        });
      }
    });

    if (geminiMessages.length === 0) {
      geminiMessages.push({
        parts: [{
          text: systemPrompts.length > 0
            ? "Please proceed with the instructions above."
            : "Hello.",
        }],
        role: "user",
      });
    }

    return {
      messages: geminiMessages,
      systemInstruction: systemPrompts.length > 0
        ? { parts: [{ text: systemPrompts.join("\n") }] }
        : undefined,
    };
  };

  return {
    endpoint: `https://generativelanguage.googleapis.com/v1beta/models/${
      config.model || "gemini-2.0-flash-lite-preview-02-05"
    }:streamGenerateContent?key=${config.apiKey}&alt=sse`,

    headers: (config: ProviderConfig) => ({
      "Content-Type": "application/json",
    }),

    transformMessages,

    body: (messages: ChatMessage[], config: ProviderConfig) => {
      const transformed = transformMessages(messages);
      const modelId = config.model || "gemini-2.0-flash-lite-preview-02-05";

      const safetySettings = [
        { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
        {
          category: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
          threshold: "BLOCK_NONE",
        },
        {
          category: "HARM_CATEGORY_DANGEROUS_CONTENT",
          threshold: "BLOCK_NONE",
        },
      ];

      const generationConfig: Record<string, unknown> = {
        temperature: config.temperature || 0,
        maxOutputTokens: config.maxTokens || 1000,
        topP: config.topP,
        topK: config.topK,
        candidateCount: config.candidateCount,
        stopSequences: config.stopSequences || config.stop,
        responseMimeType: config.responseType === "json"
          ? "application/json"
          : config.responseMimeType,
      };

      const thinkingConfig = buildThinkingConfig(config, modelId);
      if (thinkingConfig) generationConfig.thinkingConfig = thinkingConfig;

      return {
        contents: transformed.messages,
        generationConfig,
        safetySettings,
        systemInstruction: transformed.systemInstruction,
      };
    },

    extractContent: (data: any): ExtractedPart[] | null => {
      const gParts = data?.candidates?.[0]?.content?.parts || [];
      const parts: ExtractedPart[] = [];
      const visibleParts: string[] = [];
      const reasoningParts: string[] = [];

      for (const part of gParts) {
        if (part.thought) {
          if (part.text) {
            reasoningParts.push(part.text);
            parts.push({ text: part.text, isReasoning: true });
          }
        } else if (part.text) {
          visibleParts.push(part.text);
          parts.push({ text: part.text });
        }
      }

      if (debugStream) {
        streamEventIndex += 1;

        const previousVisibleSnapshot = lastVisibleSnapshot;
        const previousReasoningSnapshot = lastReasoningSnapshot;
        const visibleSnapshot = visibleParts.join("");
        const reasoningSnapshot = reasoningParts.join("");
        const visibleLooksCumulative = visibleSnapshot.length > 0 &&
          previousVisibleSnapshot.length > 0 &&
          visibleSnapshot.startsWith(previousVisibleSnapshot);
        const reasoningLooksCumulative = reasoningSnapshot.length > 0 &&
          previousReasoningSnapshot.length > 0 &&
          reasoningSnapshot.startsWith(previousReasoningSnapshot);

        console.log("[gemini.extractContent]", {
          eventIndex: streamEventIndex,
          candidateIndex: 0,
          finishReason: data?.candidates?.[0]?.finishReason,
          rawPartCount: Array.isArray(gParts) ? gParts.length : 0,
          rawParts: Array.isArray(gParts)
            ? gParts.map((part: GeminiPart & { thought?: boolean }) => ({
              thought: part?.thought === true,
              text: part?.text ?? "",
            }))
            : [],
          visibleSnapshot,
          previousVisibleSnapshot,
          visibleLooksCumulative,
          visibleDeltaGuess: visibleLooksCumulative
            ? visibleSnapshot.slice(previousVisibleSnapshot.length)
            : null,
          reasoningSnapshot,
          previousReasoningSnapshot,
          reasoningLooksCumulative,
          reasoningDeltaGuess: reasoningLooksCumulative
            ? reasoningSnapshot.slice(previousReasoningSnapshot.length)
            : null,
          extractedParts: parts,
        });

        if (visibleSnapshot.length > 0) {
          lastVisibleSnapshot = visibleSnapshot;
        }
        if (reasoningSnapshot.length > 0) {
          lastReasoningSnapshot = reasoningSnapshot;
        }
      }

      return parts.length > 0 ? parts : null;
    },

    extractUsage: (data: any): ProviderUsageUpdate | null => {
      const usage = data?.usageMetadata;
      if (!usage || typeof usage !== "object" || Array.isArray(usage)) {
        return null;
      }

      return {
        inputTokens: typeof usage.promptTokenCount === "number"
          ? usage.promptTokenCount
          : undefined,
        outputTokens: typeof usage.candidatesTokenCount === "number"
          ? usage.candidatesTokenCount
          : undefined,
        reasoningTokens: typeof usage.thoughtsTokenCount === "number"
          ? usage.thoughtsTokenCount
          : undefined,
        cacheReadInputTokens: typeof usage.cachedContentTokenCount === "number"
          ? usage.cachedContentTokenCount
          : undefined,
        totalTokens: typeof usage.totalTokenCount === "number"
          ? usage.totalTokenCount
          : undefined,
        rawUsage: usage as Record<string, unknown>,
      };
    },
  };
};
