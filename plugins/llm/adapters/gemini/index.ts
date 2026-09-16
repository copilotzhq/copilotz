/** Gemini provider adapter wire protocol. @module */
// deno-lint-ignore-file no-explicit-any
// Private vendor-wire decoder: payload shapes are provider-controlled JSON.
import type {
  ChatMessage,
  ExtractedPart,
  ProviderConfig,
  ProviderFactory,
  ProviderFinishReason,
  ProviderUsageUpdate,
} from "../../shared/types.ts";
import { resolveProviderStopSequences } from "../../shared/utils.ts";
import {
  cloneBlock,
  isRecord,
  matchingNativeBlocks,
} from "../native-reasoning/index.ts";
import { providerEndpoint } from "../transport/index.ts";

// Gemini rejects requests with more than 5 stop sequences.
const GEMINI_MAX_STOP_SEQUENCES = 5;

interface GeminiPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  thought_signature?: string;
  inline_data?: {
    mime_type: string;
    data: string;
  };
}

function isSafeSignedGeminiPart(
  block: Record<string, unknown>,
): block is GeminiPart & Record<string, unknown> {
  if (
    typeof block.thoughtSignature !== "string" &&
    typeof block.thought_signature !== "string"
  ) return false;
  if (block.text !== undefined && typeof block.text !== "string") return false;
  if (block.thought !== undefined && typeof block.thought !== "boolean") {
    return false;
  }
  return Object.keys(block).every((key) =>
    key === "text" || key === "thought" || key === "thoughtSignature" ||
    key === "thought_signature"
  );
}

/**
 * Reinsert signed Gemini response parts without duplicating their text in the
 * canonical assistant wire message. Function-call and other native tool parts
 * are intentionally rejected: Copilotz's text-tool protocol owns those.
 */
function mergeSignedGeminiParts(
  canonical: GeminiPart[],
  nativeBlocks: Record<string, unknown>[] | null,
): GeminiPart[] {
  if (!nativeBlocks || nativeBlocks.length === 0) return canonical;
  const signed = nativeBlocks.filter(isSafeSignedGeminiPart);
  if (signed.length !== nativeBlocks.length) return canonical;
  if (
    !canonical.every((part) => Object.keys(part).every((key) => key === "text"))
  ) {
    return canonical;
  }

  const canonicalText = canonical.map((part) => part.text ?? "").join("");
  const merged: GeminiPart[] = [];
  const pendingEmpty: GeminiPart[] = [];
  let cursor = 0;

  for (const native of signed) {
    const text = native.text ?? "";
    // A signed thought carries hidden provider state, not canonical visible
    // assistant text. Keep it in stream order without trying to find it in the
    // visible text sequence.
    if (native.thought === true) {
      merged.push(...pendingEmpty.splice(0));
      merged.push(structuredClone(native));
      continue;
    }
    if (!text) {
      pendingEmpty.push(structuredClone(native));
      continue;
    }
    const position = canonicalText.indexOf(text, cursor);
    if (position === -1) return canonical;
    if (position > cursor) {
      merged.push({ text: canonicalText.slice(cursor, position) });
    }
    merged.push(...pendingEmpty.splice(0));
    merged.push(structuredClone(native));
    cursor = position + text.length;
  }

  if (cursor < canonicalText.length) {
    merged.push({ text: canonicalText.slice(cursor) });
  }
  merged.push(...pendingEmpty);
  return merged;
}

interface GeminiMessage {
  parts: GeminiPart[];
  role: "user" | "model";
}

const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash-lite";

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
  const debugStream = config.runtimeDiagnostics?.enabled === true;
  const cacheDebug = debugStream;
  let streamEventIndex = 0;
  let usageEventIndex = 0;
  let lastVisibleSnapshot = "";
  let lastReasoningSnapshot = "";
  const signedParts: Record<string, unknown>[] = [];

  const transformMessages = (
    messages: ChatMessage[],
    replayConfig: ProviderConfig = config,
  ) => {
    const systemPrompts: string[] = [];
    const geminiMessages: GeminiMessage[] = [];

    messages.forEach((msg) => {
      if (msg.role === "system") {
        systemPrompts.push(
          typeof msg.content === "string" ? msg.content : msg.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join(""),
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

        const nativeBlocks = matchingNativeBlocks(
          msg,
          replayConfig,
          "gemini",
          "gemini.generateContent",
          replayConfig.model || DEFAULT_GEMINI_MODEL,
        );
        geminiMessages.push({
          parts: msg.role === "assistant"
            ? mergeSignedGeminiParts(parts, nativeBlocks)
            : parts,
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
    endpoint: providerEndpoint(
      config.baseUrl,
      "https://generativelanguage.googleapis.com/v1beta",
      "models/" + (config.model || DEFAULT_GEMINI_MODEL) +
        ":streamGenerateContent",
    ) + "?key=" + encodeURIComponent(config.apiKey || "") + "&alt=sse",

    headers: (config: ProviderConfig) => ({
      ...(config.extraHeaders ?? {}),
      "Content-Type": "application/json",
    }),

    transformMessages,

    body: (messages: ChatMessage[], config: ProviderConfig) => {
      const transformed = transformMessages(messages, config);
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
        stopSequences: resolveProviderStopSequences(config, {
          maxCount: GEMINI_MAX_STOP_SEQUENCES,
        }),
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

    nativeReasoningApi: "gemini.generateContent",
    extractNativeReasoning: (data: any): Record<string, unknown>[] | null => {
      const candidate = data?.candidates?.[0];
      const rawParts = candidate?.content?.parts;
      if (Array.isArray(rawParts)) {
        for (const part of rawParts) {
          if (
            !isRecord(part) ||
            (typeof part.thoughtSignature !== "string" &&
              typeof part.thought_signature !== "string")
          ) {
            continue;
          }
          signedParts.push(cloneBlock(part));
        }
      }
      return candidate?.finishReason === "STOP" && signedParts.length > 0
        ? signedParts.map(cloneBlock)
        : null;
    },
    isStreamActivity: (data: any) =>
      Array.isArray(data?.candidates) || Boolean(data?.usageMetadata),

    extractUsage: (data: any): ProviderUsageUpdate | null => {
      const usage = data?.usageMetadata;
      if (!usage || typeof usage !== "object" || Array.isArray(usage)) {
        return null;
      }

      if (cacheDebug) {
        usageEventIndex += 1;
        console.log("[cache-debug] gemini usageMetadata", {
          usageEventIndex,
          finishReason: data?.candidates?.[0]?.finishReason ?? null,
          promptTokenCount: usage.promptTokenCount,
          candidatesTokenCount: usage.candidatesTokenCount,
          // The key signal: does the cache count appear in early events
          // (cumulative) or only in the final event (timing-sensitive)?
          cachedContentTokenCount: usage.cachedContentTokenCount ?? null,
          thoughtsTokenCount: usage.thoughtsTokenCount ?? null,
          totalTokenCount: usage.totalTokenCount,
        });
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
