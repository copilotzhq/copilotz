import type { ChatContentPart, ChatMessage, ProviderConfig } from "./types.ts";
import {
  estimateTokens,
  type TokenEstimate,
  type TokenEstimatePart,
  type TokenMediaMetadata,
} from "../authoring/token-estimation/index.ts";
import {
  getTokenCalibrationFactor,
  tokenCalibrationKey,
} from "./token-calibration.ts";

function mediaMetadata(part: ChatContentPart): TokenMediaMetadata {
  return "tokenMetadata" in part && part.tokenMetadata
    ? part.tokenMetadata
    : {};
}

export function contentToTokenEstimateParts(
  content: ChatMessage["content"],
): TokenEstimatePart[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content.flatMap((part): TokenEstimatePart[] => {
    const metadata = mediaMetadata(part);
    switch (part.type) {
      case "text":
        return [{ type: "text", text: part.text }];
      case "image_url":
        return [{
          type: "image",
          width: metadata.width,
          height: metadata.height,
          detail: part.image_url.detail,
        }];
      case "input_audio":
        return [{ type: "audio", durationSeconds: metadata.durationSeconds }];
      case "video":
        return [{
          type: "video",
          durationSeconds: metadata.durationSeconds,
          width: metadata.width,
          height: metadata.height,
        }];
      case "file":
        return [{
          type: "document",
          text: metadata.extractedText,
          pages: metadata.pages,
          pageWidth: metadata.width,
          pageHeight: metadata.height,
        }];
    }
  });
}

/**
 * Native state is not text. Prefer the producing attempt's usage, otherwise
 * estimate its opaque format locally. Keep every estimate heuristic: generated
 * reasoning usage and encrypted byte size are both proxies for replay cost.
 * The OpenAI fallback is a rounded pilot fit (30 Responses API samples), not a
 * tokenizer or a guarantee for other transports. No signed block is modified.
 */
function nativeReasoningTokenEstimateParts(
  message: ChatMessage,
): TokenEstimatePart[] {
  const native = message.nativeReasoning;
  if (!native?.blocks.length) return [];
  const hint = native.reasoningTokens;
  const encoder = new TextEncoder();
  let tokens: number;
  if (typeof hint === "number" && Number.isFinite(hint) && hint >= 0) {
    tokens = Math.ceil(hint);
  } else if (native.api === "openai.responses") {
    // Estimate encrypted payload only; visible messages, summaries, IDs and
    // JSON packaging are not an additional text transcript for the model.
    tokens = native.blocks.reduce((sum, block) => {
      if (block.type === "message") return sum;
      const encrypted = block.encrypted_content;
      return sum +
        (typeof encrypted === "string"
          ? Math.max(0, encoder.encode(encrypted).byteLength / 15 - 25)
          : encoder.encode(JSON.stringify(block)).byteLength / 2);
    }, 0);
  } else {
    // Preserve the conservative fallback for formats without a validated fit.
    // In particular, the Gemini pilot did not justify a new historical ratio.
    tokens = encoder.encode(JSON.stringify(native.blocks)).byteLength / 2;
  }
  return [
    { type: "protocol", tokens: 4 + 2 * native.blocks.length },
    { type: "unknown", tokens: Math.ceil(tokens), confidence: "heuristic" },
  ];
}

export interface ChatTokenEstimate extends TokenEstimate {
  byMessage: number[];
  modalityMask: string;
  calibrationKey: string;
}

export function estimateChatMessages(
  messages: readonly ChatMessage[],
  config: Pick<ProviderConfig, "provider" | "model"> = {},
  calibrationFactor?: number,
): ChatTokenEstimate {
  const messageParts = messages.map((message) => [
    { type: "protocol" as const, tokens: 4 },
    ...contentToTokenEstimateParts(message.content),
    ...nativeReasoningTokenEstimateParts(message),
  ]);
  const rawEstimates = messageParts.map((parts) =>
    estimateTokens(parts, {
      provider: config.provider,
      model: config.model,
      safetyMargin: 0,
    })
  );
  const modalities = new Set(
    rawEstimates.flatMap((estimate) =>
      Object.entries(estimate.byModality)
        .filter(([, tokens]) => tokens > 0)
        .map(([modality]) => modality)
    ),
  );
  const modalityMask = [...modalities].sort().join("+") || "empty";
  const calibrationKey = tokenCalibrationKey(
    config.provider,
    config.model,
    modalityMask,
  );
  const resolvedCalibrationFactor = calibrationFactor ??
    getTokenCalibrationFactor(calibrationKey);
  const estimate = estimateTokens(messageParts.flat(), {
    provider: config.provider,
    model: config.model,
    calibrationFactor: resolvedCalibrationFactor,
  });
  return {
    ...estimate,
    byMessage: rawEstimates.map((item) => item.rawEstimatedTokens),
    modalityMask,
    calibrationKey,
  };
}
