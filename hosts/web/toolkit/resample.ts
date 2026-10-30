/**
 * Levels (a recording's loudness over time) as `count` of them: each the
 * average of its stretch when there are more, or drawn between its
 * neighbours when there are fewer. Rounded to hundredths; none for none.
 *
 * ```ts
 * resample([0, 1], 3); // [0, 0.5, 1]
 * ```
 */
export const resample = (levels: readonly number[], count: number): number[] => {
  const n = levels.length;
  if (!n || count < 1) return [];
  const round = (value: number) => Math.round(Math.min(1, Math.max(0, value)) * 100) / 100;
  if (n >= count) {
    return Array.from({ length: count }, (_, i) => {
      const from = Math.floor(i * n / count);
      const to = Math.max(from + 1, Math.floor((i + 1) * n / count));
      let sum = 0;
      for (let at = from; at < to; at++) sum += levels[at];
      return round(sum / (to - from));
    });
  }
  return Array.from({ length: count }, (_, i) => {
    const at = count === 1 ? 0 : i * (n - 1) / (count - 1);
    const below = Math.floor(at);
    const above = Math.min(n - 1, below + 1);
    return round(levels[below] + (levels[above] - levels[below]) * (at - below));
  });
};
