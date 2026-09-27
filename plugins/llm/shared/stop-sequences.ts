import type { ProviderConfig } from "./types.ts";
import { suffixPrefixAny } from "./protocol-tags.ts";

const LOCAL_DEFAULT_STOP_SEQUENCES = [
  "<tool_results",
  "</tool_results>",
  "<continue_after_tool_results",
  "<result",
  "</result>",
  "<tool_result",
  "</tool_result>",
];

/**
 * Runtime diagnostics are explicit configuration so provider behavior remains
 * identical in Deno, Node, Bun, browsers, and isolate runtimes.
 */
export function isStopDebugEnabled(config?: ProviderConfig): boolean {
  return config?.runtimeDiagnostics?.enabled === true;
}

function normalizeStopValues(value?: string | string[]): string[] {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.filter((candidate): candidate is string =>
      typeof candidate === "string" && candidate.length > 0
    );
  }
  return typeof value === "string" && value.length > 0 ? [value] : [];
}

export function withDefaultStopSequences(
  config: ProviderConfig,
): ProviderConfig {
  const mergedStops = [
    ...new Set([
      ...normalizeStopValues(config.stopSequences),
      ...normalizeStopValues(config.stop),
    ]),
  ];

  if (mergedStops.length === 0) return config;

  return {
    ...config,
    stop: mergedStops,
    stopSequences: mergedStops,
  };
}

export function getLocalStopSequences(config?: ProviderConfig): string[] {
  return [
    ...new Set([
      ...normalizeStopValues(config?.stopSequences),
      ...normalizeStopValues(config?.stop),
      ...LOCAL_DEFAULT_STOP_SEQUENCES,
    ]),
  ];
}

/**
 * Resolve the stop sequences a provider adapter should send natively.
 *
 * Prefers the runtime-resolved {@link ProviderConfig.nativeStopSequences}
 * (populated by `runProviderStream` with the full client-side stop set,
 * including Copilotz control tags) and falls back to the caller-provided
 * `stopSequences`/`stop` for direct adapter usage (e.g. tests).
 *
 * Returns `undefined` when there is nothing to send. When `maxCount` is given
 * (e.g. Gemini caps at 5), the list is truncated, keeping user-intent stops
 * first; any dropped control tags remain enforced client-side.
 */
export function resolveProviderStopSequences(
  config: ProviderConfig,
  options?: { maxCount?: number },
): string[] | undefined {
  const base = config.nativeStopSequences &&
      config.nativeStopSequences.length > 0
    ? config.nativeStopSequences
    : [
      ...normalizeStopValues(config.stopSequences),
      ...normalizeStopValues(config.stop),
    ];

  const deduped = [...new Set(base.filter((value) => value.length > 0))];
  if (deduped.length === 0) return undefined;

  const max = options?.maxCount;
  const capped = typeof max === "number" && max > 0
    ? deduped.slice(0, max)
    : deduped;

  return capped.length > 0 ? capped : undefined;
}

export type LocalStopState = {
  pending: string;
  matchedStop?: string;
};

export function applyLocalStopSequences(
  input: string,
  stopSequences: string[],
  state: LocalStopState,
): { text: string; matchedStop?: string } {
  if (stopSequences.length === 0) {
    return { text: input };
  }

  const combined = state.pending + input;
  state.pending = "";

  let earliestIndex = -1;
  let matchedStop: string | undefined;

  for (const stop of stopSequences) {
    const index = combined.indexOf(stop);
    if (index === -1) continue;
    if (earliestIndex === -1 || index < earliestIndex) {
      earliestIndex = index;
      matchedStop = stop;
    }
  }

  if (earliestIndex !== -1) {
    state.matchedStop = matchedStop;
    return {
      text: combined.slice(0, earliestIndex),
      matchedStop,
    };
  }

  const overlap = suffixPrefixAny(combined, stopSequences);
  if (overlap > 0) {
    state.pending = combined.slice(combined.length - overlap);
    return { text: combined.slice(0, combined.length - overlap) };
  }

  return { text: combined };
}
