/**
 * What `RowsEditor` does to its rows, as plain functions: a row added
 * after another or at the end, one taken out, whether either may happen
 * (`min`, `max`), where the focus goes after a row goes, and a key for a
 * row that has none of its own (one per object, kept while it lives, so a
 * row's fields keep their focus and what's typed as rows around it come
 * and go, and carried to the row an edit makes of it: `carryKey`).
 *
 * ```ts
 * insertAfter(["a", "b"], 0, "x"); // ["a", "x", "b"]
 * removeAt(["a", "b", "c"], 1); // ["a", "c"]
 * focusAfterRemoving(3, 2); // 1: the row now last
 * ```
 */

/** The rows with `row` after the one at `index` (at the start for -1, at the end past the last). */
export function insertAfter<R>(rows: readonly R[], index: number, row: R): R[] {
  const at = Math.max(0, Math.min(index + 1, rows.length));
  return [...rows.slice(0, at), row, ...rows.slice(at)];
}

/** The rows without the one at `index`. */
export function removeAt<R>(rows: readonly R[], index: number): R[] {
  return rows.filter((_, i) => i !== index);
}

/** The rows with the one at `index` replaced. */
export function replaceAt<R>(rows: readonly R[], index: number, row: R): R[] {
  return rows.map((old, i) => (i === index ? row : old));
}

/** Whether another row may be added: fewer than `max`. */
export const canAdd = (count: number, max?: number): boolean => max === undefined || count < max;

/** Whether a row may be taken out: more than `min` (none by default). */
export const canRemove = (count: number, min = 0): boolean => count > min;

/**
 * Which row the focus goes to once the row at `index` is gone from `count` rows: the one that took
 * its place, or the one before it when it was the last; -1 when none are left (the add button).
 */
export function focusAfterRemoving(count: number, index: number): number {
  const left = count - 1;
  if (left <= 0) return -1;
  return Math.min(index, left - 1);
}

const keys = new WeakMap<object, string>();
let next = 0;

/** A row's key: its own (`rowKey`), one per object, or its place for a row that's a plain value. */
export function keyOfRow<R>(
  row: R,
  index: number,
  rowKey?: (row: R, index: number) => string | number,
): string {
  if (rowKey) return String(rowKey(row, index));
  if (typeof row === "object" && row !== null) {
    let key = keys.get(row);
    if (!key) keys.set(row, key = `row-${++next}`);
    return key;
  }
  return `at-${index}`;
}

/**
 * An edited row keeps the key of the row it was made from, so the fields being typed in aren't
 * drawn anew (an edit makes a new object of the row).
 */
export function carryKey<R>(from: R, to: R): void {
  if (typeof from !== "object" || from === null || typeof to !== "object" || to === null) return;
  const key = keys.get(from);
  if (key && !keys.has(to)) keys.set(to, key);
}
