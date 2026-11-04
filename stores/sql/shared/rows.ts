/**
 * What a maintenance read's rows weigh, as JSON: bytes as base64, big
 * integers as text (as the maintenance endpoints answer them). A read stops
 * fetching before a row would take it past the bytes it may answer with.
 */

const encoder = new TextEncoder();

const plain = (_key: string, value: unknown) =>
  typeof value === "bigint"
    ? value.toString()
    : value instanceof Uint8Array
    ? "x".repeat(Math.ceil(value.length / 3) * 4)
    : value;

/** About how many bytes of JSON `row` comes to. */
export const weight = (row: unknown): number =>
  encoder.encode(JSON.stringify(row ?? null, plain)).length + 1;

/**
 * At most `limit` rows, and only those within `bytes`: `cut` when a row
 * past them was left out (more may follow).
 */
export function upTo<T>(
  rows: T[],
  limit?: number,
  bytes?: number,
): T[] & { cut?: true } {
  const kept = limit === undefined ? rows : rows.slice(0, limit);
  if (bytes === undefined) return kept;
  let used = 0;
  for (const [i, row] of kept.entries()) {
    used += weight(row);
    if (used > bytes) return Object.assign(kept.slice(0, i), { cut: true as const });
  }
  return kept;
}
