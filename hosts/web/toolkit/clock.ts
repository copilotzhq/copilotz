/**
 * A length of time as a clock shows it, from milliseconds: `0:07`, `12:30`,
 * `1:02:03`. Whole seconds, rounded down (how far something has played);
 * `round` rounds to the nearest instead (how long it is).
 */
export const clock = (ms: number, round = false): string => {
  const seconds = Number.isFinite(ms) && ms > 0 ? (round ? Math.round : Math.floor)(ms / 1000) : 0;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60;
  const rest = String(seconds % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
};
