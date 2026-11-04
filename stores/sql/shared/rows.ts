/**
 * What a maintenance read's rows weigh, as JSON: bytes as base64, big
 * integers as text (as the maintenance endpoints answer them). A read stops
 * fetching once its rows pass the bytes it may answer with.
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

/** Rows up to the first that takes them past `bytes` (that one included), or all of them. */
export function upTo<T>(rows: T[], bytes?: number): T[] {
  if (bytes === undefined) return rows;
  let used = 0;
  for (const [i, row] of rows.entries()) {
    used += weight(row);
    if (used > bytes) return rows.slice(0, i + 1);
  }
  return rows;
}
