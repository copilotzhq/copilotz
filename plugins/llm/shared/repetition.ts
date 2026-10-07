export type DegenerateRepetitionDetection = {
  startIndex: number;
  endIndex: number;
  reason: "low_entropy_periodic_tail";
  periodTokens: string[];
  scores: {
    normalizedEntropy: number;
    uniqueRatio: number;
    topTokenRatio: number;
    periodicity: number;
  };
};

type DegenerateRepetitionOptions = {
  maxTailChars?: number;
  windowSizes?: number[];
  minWindowTokens?: number;
  maxPeriod?: number;
  minRepeats?: number;
  normalizedEntropyMax?: number;
  uniqueRatioMax?: number;
  topTokenRatioMin?: number;
  periodicityMin?: number;
};

type RepetitionToken = {
  value: string;
  start: number;
  end: number;
};

const DEFAULT_REPETITION_OPTIONS: Required<DegenerateRepetitionOptions> = {
  maxTailChars: 4000,
  windowSizes: [48, 64, 96, 128, 192, 256],
  minWindowTokens: 48,
  maxPeriod: 16,
  minRepeats: 4,
  normalizedEntropyMax: 0.45,
  uniqueRatioMax: 0.25,
  topTokenRatioMin: 0.30,
  periodicityMin: 0.85,
};

function tokenizeRepetitionTail(
  text: string,
  maxTailChars: number,
): RepetitionToken[] {
  const tailStart = Math.max(0, text.length - maxTailChars);
  const tail = text.slice(tailStart);
  const tokens: RepetitionToken[] = [];
  const tokenPattern = /[a-z0-9_]+/gi;
  let match: RegExpExecArray | null;

  while ((match = tokenPattern.exec(tail)) !== null) {
    const raw = match[0];
    if (!raw) continue;
    tokens.push({
      value: raw.toLowerCase(),
      start: tailStart + match.index,
      end: tailStart + match.index + raw.length,
    });
  }

  return tokens;
}

function scoreTokenConcentration(tokens: RepetitionToken[]): {
  normalizedEntropy: number;
  uniqueRatio: number;
  topTokenRatio: number;
} {
  const counts = new Map<string, number>();
  for (const token of tokens) {
    counts.set(token.value, (counts.get(token.value) ?? 0) + 1);
  }

  const total = tokens.length;
  const unique = counts.size;
  const topCount = Math.max(0, ...counts.values());
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / total;
    entropy -= p * Math.log2(p);
  }

  return {
    normalizedEntropy: unique <= 1 ? 0 : entropy / Math.log2(unique),
    uniqueRatio: unique / total,
    topTokenRatio: topCount / total,
  };
}

function repetitionPeriodicityScore(
  tokens: RepetitionToken[],
  start: number,
  end: number,
  period: number,
): number {
  const comparable = end - start - period;
  if (period <= 0 || comparable <= 0) return 0;

  let matches = 0;
  for (let i = start + period; i < end; i++) {
    if (tokens[i].value === tokens[i - period].value) matches++;
  }
  return matches / comparable;
}

function findBestRepetitionPeriod(
  tokens: RepetitionToken[],
  start: number,
  end: number,
  options: Required<DegenerateRepetitionOptions>,
): { period: number; score: number } | null {
  let best: { period: number; score: number } | null = null;
  const length = end - start;
  const maxPeriod = Math.min(options.maxPeriod, Math.floor(length / 2));

  for (let period = 1; period <= maxPeriod; period++) {
    const repeats = length / period;
    if (repeats < options.minRepeats) continue;

    const score = repetitionPeriodicityScore(tokens, start, end, period);
    if (score < options.periodicityMin) continue;
    if (
      !best ||
      score > best.score ||
      (score === best.score && period < best.period)
    ) {
      best = { period, score };
    }
  }

  return best;
}

function refineRepetitionStart(
  tokens: RepetitionToken[],
  windowStart: number,
  period: number,
): number {
  let bestStart = windowStart;

  while (bestStart > 0) {
    const previous = tokens[bestStart - 1];
    const aligned = tokens[bestStart - 1 + period];
    if (!aligned || previous.value !== aligned.value) break;
    bestStart--;
  }

  return bestStart;
}

/** Catch the punctuation-only provider failure that word tokenization misses. */
function punctuationLoop(
  text: string,
  maxTailChars: number,
): DegenerateRepetitionDetection | null {
  const tail = text.slice(-maxTailChars);
  // Require quotes mixed with JSON delimiters; ordinary separators and code
  // indentation are not evidence of a broken generation.
  const match = /["'{}\[\],:;\\]+$/.exec(tail);
  if (
    !match || match[0].length < 192 || !/["']/.test(match[0]) ||
    !/[{}\[\]]/.test(match[0])
  ) return null;
  for (let size = 1; size <= 8; size++) {
    const pattern = match[0].slice(-size);
    let start = match[0].length - size;
    while (start >= size && match[0].slice(start - size, start) === pattern) {
      start -= size;
    }
    if (match[0].length - start < Math.max(192, size * 24)) continue;
    return {
      startIndex: text.length - match[0].length + start,
      endIndex: text.length,
      reason: "low_entropy_periodic_tail",
      periodTokens: [pattern],
      scores: {
        normalizedEntropy: 0,
        uniqueRatio: size / (match[0].length - start),
        topTokenRatio: 1,
        periodicity: 1,
      },
    };
  }
  return null;
}

export function detectDegenerateRepetition(
  text: string,
  customOptions: DegenerateRepetitionOptions = {},
): DegenerateRepetitionDetection | null {
  const options: Required<DegenerateRepetitionOptions> = {
    ...DEFAULT_REPETITION_OPTIONS,
    ...customOptions,
    windowSizes: customOptions.windowSizes ??
      DEFAULT_REPETITION_OPTIONS.windowSizes,
  };
  const punctuation = punctuationLoop(text, options.maxTailChars);
  if (punctuation) return punctuation;
  const tokens = tokenizeRepetitionTail(text, options.maxTailChars);
  if (tokens.length < options.minWindowTokens) return null;

  const sortedWindowSizes = [...options.windowSizes]
    .filter((size) => size >= options.minWindowTokens)
    .sort((a, b) => a - b);

  let bestDetection: DegenerateRepetitionDetection | null = null;

  for (const windowSize of sortedWindowSizes) {
    if (tokens.length < windowSize) continue;

    const start = tokens.length - windowSize;
    const end = tokens.length;
    const windowTokens = tokens.slice(start, end);
    const scores = scoreTokenConcentration(windowTokens);
    const entropySuspicious =
      scores.normalizedEntropy <= options.normalizedEntropyMax ||
      scores.uniqueRatio <= options.uniqueRatioMax ||
      scores.topTokenRatio >= options.topTokenRatioMin;

    if (!entropySuspicious) continue;

    const period = findBestRepetitionPeriod(tokens, start, end, options);
    if (!period) continue;

    const refinedStart = refineRepetitionStart(
      tokens,
      start,
      period.period,
    );
    const candidate: DegenerateRepetitionDetection = {
      startIndex: tokens[refinedStart].start,
      endIndex: tokens[end - 1].end,
      reason: "low_entropy_periodic_tail",
      periodTokens: tokens
        .slice(refinedStart, Math.min(refinedStart + period.period, end))
        .map((token) => token.value),
      scores: {
        ...scores,
        periodicity: period.score,
      },
    };

    if (
      !bestDetection ||
      candidate.scores.periodicity > bestDetection.scores.periodicity ||
      (candidate.scores.periodicity === bestDetection.scores.periodicity &&
        candidate.startIndex < bestDetection.startIndex)
    ) {
      bestDetection = candidate;
    }
  }

  return bestDetection;
}
