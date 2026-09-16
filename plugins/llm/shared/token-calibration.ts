/** Process-local calibration for LLM token estimates. @module */

type TokenCalibrationSample = Readonly<{
  estimatedTokens: number;
  actualInputTokens: number;
}>;

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

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

const MAX_KEYS = 128;
const MAX_SAMPLES = 20;
const samplesByKey = new Map<string, TokenCalibrationSample[]>();

export function tokenCalibrationKey(
  provider?: string,
  model?: string,
  modalityMask = "text",
): string {
  return `${provider?.toLowerCase() || "generic"}:${
    model?.toLowerCase() || "default"
  }:${modalityMask}`;
}

export function getTokenCalibrationFactor(key: string): number {
  const samples = samplesByKey.get(key);
  if (!samples) return 1;
  samplesByKey.delete(key);
  samplesByKey.set(key, samples);
  return calculateTokenCalibration(samples, { maxSamples: MAX_SAMPLES });
}

export function observeTokenCalibration(
  key: string,
  estimatedTokens: number,
  actualInputTokens: number,
): void {
  if (
    !Number.isFinite(estimatedTokens) || estimatedTokens <= 0 ||
    !Number.isFinite(actualInputTokens) || actualInputTokens <= 0
  ) return;
  const samples = samplesByKey.get(key) ?? [];
  samples.push({ estimatedTokens, actualInputTokens });
  if (samples.length > MAX_SAMPLES) {
    samples.splice(0, samples.length - MAX_SAMPLES);
  }
  samplesByKey.delete(key);
  samplesByKey.set(key, samples);
  while (samplesByKey.size > MAX_KEYS) {
    const oldest = samplesByKey.keys().next().value;
    if (typeof oldest !== "string") break;
    samplesByKey.delete(oldest);
  }
}

export function resetTokenCalibration(): void {
  samplesByKey.clear();
}
