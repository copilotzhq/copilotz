import type {
  ChatMessage,
  ExtractedPart,
  ProviderConfig,
  ProviderFactory,
  ProviderFinishReason,
  ProviderUsageUpdate,
} from "@/runtime/llm/types.ts";

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

const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash-lite";
const GEMINI_EXPLICIT_CACHE_MIN_CHARS = 4096;
const geminiSystemCache = new Map<
  string,
  { name: string; expiresAt: number }
>();

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

function getPromptCacheConfig(config: ProviderConfig) {
  const promptCache = config.promptCache;
  if (promptCache === false) return { enabled: false, mode: "auto" as const };
  if (promptCache && typeof promptCache === "object") {
    return {
      enabled: promptCache.enabled !== false,
      mode: promptCache.mode ?? "auto",
      ttl: promptCache.ttl,
      cachedContent: promptCache.cachedContent,
      displayName: promptCache.displayName,
    };
  }
  return { enabled: true, mode: "auto" as const };
}

function normalizeGeminiModelName(model: string): string {
  return model.startsWith("models/") ? model : `models/${model}`;
}

function supportsImplicitCaching(model: string): boolean {
  const normalized = model.toLowerCase().replace(/^models\//, "");
  return /^gemini-(2\.[5-9]|[3-9])/.test(normalized);
}

function ttlToMs(ttl: string | undefined): number {
  if (ttl === "1h") return 60 * 60 * 1000;
  if (ttl === "5m") return 5 * 60 * 1000;
  const seconds = /^(\d+(?:\.\d+)?)s$/.exec(ttl ?? "");
  return seconds ? Number(seconds[1]) * 1000 : 60 * 60 * 1000;
}

async function stableHash(value: string): Promise<string> {
  const input = new TextEncoder().encode(value);
  if (crypto.subtle?.digest) {
    const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }

  let hash = 0;
  for (const char of value) {
    hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  }
  return Math.abs(hash).toString(16);
}

async function createGeminiSystemCache(args: {
  apiKey?: string;
  model: string;
  systemInstruction: { parts: Array<{ text: string }> };
  ttl?: string;
  displayName?: string;
}): Promise<string | undefined> {
  if (!args.apiKey) return undefined;
  const text = args.systemInstruction.parts.map((part) => part.text).join("\n");
  if (text.length < GEMINI_EXPLICIT_CACHE_MIN_CHARS) return undefined;

  const cacheKey = await stableHash(JSON.stringify({
    model: args.model,
    systemInstruction: args.systemInstruction,
    apiKey: args.apiKey,
  }));
  const now = Date.now();
  const cached = geminiSystemCache.get(cacheKey);
  if (cached && cached.expiresAt > now + 30_000) return cached.name;

  const ttl = args.ttl && args.ttl !== "5m" ? args.ttl : "3600s";
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/cachedContents?key=${
        encodeURIComponent(args.apiKey)
      }`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: normalizeGeminiModelName(args.model),
          systemInstruction: args.systemInstruction,
          ttl,
          ...(args.displayName ? { displayName: args.displayName } : {}),
        }),
      },
    );
    if (!response.ok) return undefined;
    const data = await response.json() as { name?: unknown };
    if (typeof data.name !== "string" || data.name.length === 0) {
      return undefined;
    }
    geminiSystemCache.set(cacheKey, {
      name: data.name,
      expiresAt: now + ttlToMs(ttl),
    });
    return data.name;
  } catch {
    return undefined;
  }
}

function extractGeminiFinishReason(data: any): ProviderFinishReason | null {
  const reason = data?.candidates?.[0]?.finishReason;
  if (reason === "MAX_TOKENS") return "length";
  if (reason === "STOP") return "stop";
  if (reason === "SAFETY" || reason === "RECITATION") return "content_filter";
  return typeof reason === "string" ? "unknown" : null;
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
      ? {
        thinkingLevel: {
          minimal: "MINIMAL",
          low: "LOW",
          medium: "MEDIUM",
          high: "HIGH",
        }[effort],
      }
      : {
        thinkingBudget:
          { minimal: 0, low: 2048, medium: 8192, high: -1 }[effort],
      };
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
      config.model || DEFAULT_GEMINI_MODEL
    }:streamGenerateContent?key=${config.apiKey}&alt=sse`,

    headers: (config: ProviderConfig) => ({
      "Content-Type": "application/json",
    }),

    transformMessages,

    body: async (messages: ChatMessage[], config: ProviderConfig) => {
      const transformed = transformMessages(messages);
      const modelId = config.model || DEFAULT_GEMINI_MODEL;

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

      const promptCache = getPromptCacheConfig(config);
      const explicitCachedContent = promptCache.enabled
        ? promptCache.cachedContent
        : undefined;
      const shouldTryExplicitSystemCache = promptCache.enabled &&
        !explicitCachedContent &&
        (promptCache.mode === "explicit" ||
          (promptCache.mode === "auto" && !supportsImplicitCaching(modelId)));
      const createdCachedContent = shouldTryExplicitSystemCache &&
          transformed.systemInstruction
        ? await createGeminiSystemCache({
          apiKey: config.apiKey,
          model: modelId,
          systemInstruction: transformed.systemInstruction,
          ttl: promptCache.ttl,
          displayName: promptCache.displayName,
        })
        : undefined;
      const cachedContent = explicitCachedContent ?? createdCachedContent;

      return {
        contents: transformed.messages,
        generationConfig,
        safetySettings,
        ...(cachedContent ? { cachedContent } : {}),
        ...(cachedContent
          ? {}
          : { systemInstruction: transformed.systemInstruction }),
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
    extractFinishReason: extractGeminiFinishReason,
  };
};
