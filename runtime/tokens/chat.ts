import type {
  ChatContentPart,
  ChatMessage,
  ProviderConfig,
} from "@/runtime/llm/types.ts";
import {
  estimateTokens,
  type TokenEstimate,
  type TokenEstimatePart,
  type TokenMediaMetadata,
} from "./estimate.ts";
import {
  getTokenCalibrationFactor,
  tokenCalibrationKey,
} from "./calibration.ts";

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

export interface ChatTokenEstimate extends TokenEstimate {
  byMessage: number[];
  modalityMask: string;
  calibrationKey: string;
}

export function estimateChatMessages(
  messages: readonly ChatMessage[],
  config: Pick<ProviderConfig, "provider" | "model"> = {},
): ChatTokenEstimate {
  const messageParts = messages.map((message) => [
    { type: "protocol" as const, tokens: 4 },
    ...contentToTokenEstimateParts(message.content),
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
  const calibrationFactor = getTokenCalibrationFactor(calibrationKey);
  const estimate = estimateTokens(messageParts.flat(), {
    provider: config.provider,
    model: config.model,
    calibrationFactor,
  });
  return {
    ...estimate,
    byMessage: rawEstimates.map((item) => item.rawEstimatedTokens),
    modalityMask,
    calibrationKey,
  };
}
