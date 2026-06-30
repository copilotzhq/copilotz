import {
  calculateTokenCalibration,
  type TokenCalibrationSample,
} from "./estimate.ts";

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
