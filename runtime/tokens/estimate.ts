export type TokenEstimateConfidence = "exact" | "high" | "heuristic";

export type TokenEstimateModality =
  | "text"
  | "image"
  | "audio"
  | "video"
  | "document"
  | "protocol"
  | "unknown";

export type TokenEstimatePart =
  | { type: "text"; text: string }
  | {
    type: "image";
    width?: number;
    height?: number;
    detail?: "low" | "high" | "original" | "auto";
  }
  | { type: "audio"; durationSeconds?: number }
  | {
    type: "video";
    durationSeconds?: number;
    width?: number;
    height?: number;
  }
  | {
    type: "document";
    text?: string;
    pages?: number;
    pageWidth?: number;
    pageHeight?: number;
  }
  | { type: "protocol"; tokens: number }
  | { type: "unknown"; tokens?: number; byteLength?: number };

export interface TokenEstimateOptions {
  provider?: string;
  model?: string;
  calibrationFactor?: number;
  safetyMargin?: number;
}

export interface TokenEstimateBreakdown {
  modality: TokenEstimateModality;
  tokens: number;
  confidence: TokenEstimateConfidence;
}

export interface TokenEstimate {
  rawEstimatedTokens: number;
  estimatedTokens: number;
  safeTokens: number;
  calibrationFactor: number;
  safetyMargin: number;
  confidence: TokenEstimateConfidence;
  byModality: Record<TokenEstimateModality, number>;
  parts: TokenEstimateBreakdown[];
}

export interface TokenMediaMetadata {
  width?: number;
  height?: number;
  durationSeconds?: number;
  pages?: number;
  extractedText?: string;
}

export interface TokenCalibrationSample {
  estimatedTokens: number;
  actualInputTokens: number;
}

const DEFAULT_IMAGE_WIDTH = 1024;
const DEFAULT_IMAGE_HEIGHT = 1024;
const DEFAULT_DOCUMENT_PAGE_WIDTH = 768;
const DEFAULT_DOCUMENT_PAGE_HEIGHT = 1024;
const DEFAULT_AUDIO_SECONDS = 30;
const DEFAULT_VIDEO_SECONDS = 10;
const DEFAULT_DOCUMENT_PAGES = 1;
const DEFAULT_SAFETY_MARGIN = 0.15;
const MAX_TEXT_SAMPLE_CODE_UNITS = 4096;

const MODALITIES: TokenEstimateModality[] = [
  "text",
  "image",
  "audio",
  "video",
  "document",
  "protocol",
  "unknown",
];

const CONFIDENCE_RANK: Record<TokenEstimateConfidence, number> = {
  exact: 2,
  high: 1,
  heuristic: 0,
};

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function positive(value: unknown, fallback: number): number {
  const normalized = finiteNonNegative(value);
  return normalized && normalized > 0 ? normalized : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeProvider(provider?: string): string {
  const normalized = provider?.trim().toLowerCase() ?? "";
  if (normalized === "google") return "gemini";
  return normalized || "generic";
}

function normalizeModel(model?: string): string {
  return model?.trim().toLowerCase() ?? "";
}

function sampledText(text: string): string {
  if (text.length <= MAX_TEXT_SAMPLE_CODE_UNITS) return text;
  const segmentSize = Math.floor(MAX_TEXT_SAMPLE_CODE_UNITS / 3);
  const middleStart = Math.max(
    0,
    Math.floor(text.length / 2 - segmentSize / 2),
  );
  return text.slice(0, segmentSize) +
    text.slice(middleStart, middleStart + segmentSize) +
    text.slice(-segmentSize);
}

function isCjk(codePoint: number): boolean {
  return (
    (codePoint >= 0x3040 && codePoint <= 0x30ff) ||
    (codePoint >= 0x3400 && codePoint <= 0x9fff) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7af)
  );
}

function isEmojiOrSymbol(codePoint: number): boolean {
  return (
    (codePoint >= 0x1f000 && codePoint <= 0x1faff) ||
    (codePoint >= 0x2600 && codePoint <= 0x27bf)
  );
}

/**
 * Fast dependency-free text estimate. It samples very large strings so runtime
 * stays bounded while still accounting for CJK, emoji, and punctuation-heavy
 * payloads more accurately than a single characters-per-token ratio.
 */
export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  const sample = sampledText(text);
  let weightedTokens = 0;
  let sampledCodeUnits = 0;

  for (const character of sample) {
    const codePoint = character.codePointAt(0) ?? 0;
    sampledCodeUnits += character.length;
    if (isCjk(codePoint)) {
      weightedTokens += 1;
    } else if (isEmojiOrSymbol(codePoint)) {
      weightedTokens += 2;
    } else if (codePoint <= 0x7f) {
      weightedTokens += /\s|[a-z0-9]/i.test(character) ? 0.25 : 0.5;
    } else {
      weightedTokens += 0.6;
    }
  }

  const tokensPerCodeUnit = sampledCodeUnits > 0
    ? weightedTokens / sampledCodeUnits
    : 0.25;
  return Math.max(1, Math.ceil(text.length * tokensPerCodeUnit));
}

function scaledDimensions(
  width: number,
  height: number,
  maxDimension: number,
  maxPixels: number,
): { width: number; height: number } {
  let scale = Math.min(1, maxDimension / Math.max(width, height));
  const scaledPixels = width * height * scale * scale;
  if (scaledPixels > maxPixels) {
    scale *= Math.sqrt(maxPixels / scaledPixels);
  }
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
  };
}

function openAiTileRates(model: string): { base: number; tile: number } {
  if (model.includes("4o-mini")) return { base: 2833, tile: 5667 };
  if (model.includes("computer-use")) return { base: 65, tile: 129 };
  if (/\bo1\b|o1-pro|\bo3\b/.test(model)) return { base: 75, tile: 150 };
  if (model.includes("gpt-5")) return { base: 70, tile: 140 };
  return { base: 85, tile: 170 };
}

function openAiPatchMultiplier(model: string): number {
  if (model.includes("o4-mini")) return 1.72;
  if (model.includes("nano")) return 2.46;
  if (model.includes("mini")) return 1.62;
  return 1;
}

function estimateOpenAiPatchImage(
  width: number,
  height: number,
  model: string,
  detail: Extract<TokenEstimatePart, { type: "image" }>["detail"],
): number {
  const original = detail === "original" ||
    (detail === "auto" && model.includes("5.5"));
  const patchBudget = original ? 10_000 : model.includes("mini") ||
      model.includes("nano") || model.includes("o4-mini")
    ? 1536
    : 2500;
  const maxDimension = original ? 6000 : 2048;
  const resized = scaledDimensions(
    width,
    height,
    maxDimension,
    patchBudget * 32 * 32,
  );
  const patches = Math.min(
    patchBudget,
    Math.ceil(resized.width / 32) * Math.ceil(resized.height / 32),
  );
  return Math.ceil(patches * openAiPatchMultiplier(model));
}

function estimateOpenAiTileImage(
  width: number,
  height: number,
  model: string,
  detail: Extract<TokenEstimatePart, { type: "image" }>["detail"],
): number {
  const rates = openAiTileRates(model);
  if (detail === "low") return rates.base;

  const fitScale = Math.min(1, 2048 / Math.max(width, height));
  let resizedWidth = width * fitScale;
  let resizedHeight = height * fitScale;
  const shortest = Math.min(resizedWidth, resizedHeight);
  if (shortest > 768) {
    const detailScale = 768 / shortest;
    resizedWidth *= detailScale;
    resizedHeight *= detailScale;
  }
  const tiles = Math.ceil(resizedWidth / 512) *
    Math.ceil(resizedHeight / 512);
  return rates.base + rates.tile * tiles;
}

function estimateImageTokens(
  part: Extract<TokenEstimatePart, { type: "image" }>,
  provider: string,
  model: string,
): TokenEstimateBreakdown {
  const hasDimensions = finiteNonNegative(part.width) !== undefined &&
    finiteNonNegative(part.height) !== undefined &&
    Number(part.width) > 0 && Number(part.height) > 0;
  const width = positive(part.width, DEFAULT_IMAGE_WIDTH);
  const height = positive(part.height, DEFAULT_IMAGE_HEIGHT);
  const detail = part.detail ?? "auto";
  let tokens: number;

  if (provider === "openai") {
    const patchBased = model.includes("gpt-5.4") ||
      model.includes("gpt-5.5") ||
      model.includes("gpt-5-mini") ||
      model.includes("gpt-5-nano") ||
      model.includes("o4-mini");
    tokens = patchBased
      ? estimateOpenAiPatchImage(width, height, model, detail)
      : estimateOpenAiTileImage(width, height, model, detail);
  } else if (provider === "gemini") {
    tokens = width <= 384 && height <= 384
      ? 258
      : Math.ceil(width / 768) * Math.ceil(height / 768) * 258;
  } else if (provider === "anthropic") {
    const resized = scaledDimensions(width, height, 1568, 1_150_000);
    tokens = Math.ceil((resized.width * resized.height) / 750);
  } else {
    const resized = scaledDimensions(width, height, 2048, 1_150_000);
    tokens = Math.ceil((resized.width * resized.height) / 900);
  }

  return {
    modality: "image",
    tokens: Math.max(1, tokens),
    confidence: hasDimensions && provider !== "generic" ? "high" : "heuristic",
  };
}

function estimateAudioTokens(
  part: Extract<TokenEstimatePart, { type: "audio" }>,
  provider: string,
): TokenEstimateBreakdown {
  const duration = finiteNonNegative(part.durationSeconds);
  const rate = provider === "gemini" ? 32 : provider === "openai" ? 50 : 40;
  return {
    modality: "audio",
    tokens: Math.ceil((duration ?? DEFAULT_AUDIO_SECONDS) * rate),
    confidence: duration !== undefined && provider !== "generic"
      ? "high"
      : "heuristic",
  };
}

function estimateVideoTokens(
  part: Extract<TokenEstimatePart, { type: "video" }>,
  provider: string,
): TokenEstimateBreakdown {
  const duration = finiteNonNegative(part.durationSeconds);
  const rate = provider === "gemini" ? 263 : provider === "minimax" ? 180 : 180;
  return {
    modality: "video",
    tokens: Math.ceil((duration ?? DEFAULT_VIDEO_SECONDS) * rate),
    confidence: duration !== undefined && provider === "gemini"
      ? "high"
      : "heuristic",
  };
}

function estimateDocumentTokens(
  part: Extract<TokenEstimatePart, { type: "document" }>,
  provider: string,
  model: string,
): TokenEstimateBreakdown {
  const pages = finiteNonNegative(part.pages);
  const pageCount = Math.ceil(pages ?? DEFAULT_DOCUMENT_PAGES);
  const textTokens = estimateTextTokens(part.text ?? "");
  const pageImage = estimateImageTokens(
    {
      type: "image",
      width: positive(part.pageWidth, DEFAULT_DOCUMENT_PAGE_WIDTH),
      height: positive(part.pageHeight, DEFAULT_DOCUMENT_PAGE_HEIGHT),
      detail: "high",
    },
    provider,
    model,
  );
  return {
    modality: "document",
    tokens: textTokens + pageCount * pageImage.tokens,
    confidence: pages !== undefined && typeof part.text === "string" &&
        provider !== "generic"
      ? "high"
      : "heuristic",
  };
}

function estimatePart(
  part: TokenEstimatePart,
  provider: string,
  model: string,
): TokenEstimateBreakdown {
  switch (part.type) {
    case "text":
      return {
        modality: "text",
        tokens: estimateTextTokens(part.text),
        confidence: "heuristic",
      };
    case "image":
      return estimateImageTokens(part, provider, model);
    case "audio":
      return estimateAudioTokens(part, provider);
    case "video":
      return estimateVideoTokens(part, provider);
    case "document":
      return estimateDocumentTokens(part, provider, model);
    case "protocol":
      return {
        modality: "protocol",
        tokens: Math.ceil(finiteNonNegative(part.tokens) ?? 0),
        confidence: "exact",
      };
    case "unknown": {
      const explicit = finiteNonNegative(part.tokens);
      return {
        modality: "unknown",
        tokens: Math.ceil(
          explicit ??
            ((finiteNonNegative(part.byteLength) ?? 0) / 4),
        ),
        confidence: explicit !== undefined ? "exact" : "heuristic",
      };
    }
  }
}

function lowestConfidence(
  parts: TokenEstimateBreakdown[],
): TokenEstimateConfidence {
  if (parts.length === 0) return "exact";
  return parts.reduce<TokenEstimateConfidence>(
    (lowest, part) =>
      CONFIDENCE_RANK[part.confidence] < CONFIDENCE_RANK[lowest]
        ? part.confidence
        : lowest,
    "exact",
  );
}

/**
 * Estimates mixed-modality input tokens without external dependencies or I/O.
 *
 * Callers should provide media metadata rather than raw base64. The function
 * intentionally never decodes or scans media payloads.
 */
export function estimateTokens(
  input: TokenEstimatePart | readonly TokenEstimatePart[],
  options: TokenEstimateOptions = {},
): TokenEstimate {
  const provider = normalizeProvider(options.provider);
  const model = normalizeModel(options.model);
  const calibrationFactor = clamp(
    finiteNonNegative(options.calibrationFactor) ?? 1,
    0.25,
    4,
  );
  const safetyMargin = clamp(
    finiteNonNegative(options.safetyMargin) ?? DEFAULT_SAFETY_MARGIN,
    0,
    1,
  );
  const inputs = Array.isArray(input) ? input : [input];
  const parts = inputs.map((part) => estimatePart(part, provider, model));
  const byModality = Object.fromEntries(
    MODALITIES.map((modality) => [modality, 0]),
  ) as Record<TokenEstimateModality, number>;

  for (const part of parts) {
    byModality[part.modality] += part.tokens;
  }

  const rawEstimatedTokens = parts.reduce(
    (sum, part) => sum + part.tokens,
    0,
  );
  const estimatedTokens = Math.ceil(rawEstimatedTokens * calibrationFactor);
  const safeTokens = Math.ceil(estimatedTokens * (1 + safetyMargin));

  return {
    rawEstimatedTokens,
    estimatedTokens,
    safeTokens,
    calibrationFactor,
    safetyMargin,
    confidence: lowestConfidence(parts),
    byModality,
    parts,
  };
}

/**
 * Produces a robust rolling correction factor from provider-reported usage.
 */
export function calculateTokenCalibration(
  samples: readonly TokenCalibrationSample[],
  options: { maxSamples?: number; min?: number; max?: number } = {},
): number {
  const maxSamples = Math.max(1, Math.floor(options.maxSamples ?? 20));
  const min = finiteNonNegative(options.min) ?? 0.5;
  const max = Math.max(min, finiteNonNegative(options.max) ?? 2);
  const ratios = samples.slice(-maxSamples).flatMap((sample) => {
    const estimated = finiteNonNegative(sample.estimatedTokens);
    const actual = finiteNonNegative(sample.actualInputTokens);
    return estimated && estimated > 0 && actual !== undefined
      ? [actual / estimated]
      : [];
  }).sort((left, right) => left - right);

  if (ratios.length === 0) return 1;
  const middle = Math.floor(ratios.length / 2);
  const median = ratios.length % 2 === 0
    ? ((ratios[middle - 1] ?? 1) + (ratios[middle] ?? 1)) / 2
    : ratios[middle] ?? 1;
  return clamp(median, min, max);
}
