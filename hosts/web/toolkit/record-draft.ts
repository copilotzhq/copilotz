/**
 * A record dialog's draft, as data (see record-dialog.tsx): only what was edited, by field name
 * or dot path (`address.city`), each in its control's own form (a number field's text). A save
 * sends only the edits that change the record as it is now: an untouched field never goes, a
 * field emptied is a clear (`unset`), and a list emptied is `[]`. What the form's parts hand up
 * goes over the edits, compared the same way. A path through nothing makes objects, as MongoDB
 * does.
 */
import type { ReactNode } from "react";
import { wordsOf } from "./form-submit.ts";

/** How a control keeps its field: what it shows, and what it saves. */
export type DraftKind = "text" | "number" | "checked" | "radio" | "value" | "list" | "set";

/** One edit: the control's kind, and what it holds, in its own form. */
export type Edit = { kind: DraftKind; raw: unknown };

/** The edits, by field name or dot path. */
export type Edits = Record<string, Edit>;

/**
 * A MongoDB update of what changed: `$set` and `$unset`, each only when it has fields, never
 * empty. For `updateOne({ _id: change._id }, change.update)`.
 */
export type RecordUpdate =
  | { $set: Record<string, unknown> }
  | { $unset: Record<string, ""> }
  | { $set: Record<string, unknown>; $unset: Record<string, ""> };

/** What changed in a stored record, if anything. */
export type Changed = { set: Record<string, unknown>; unset: string[]; update: RecordUpdate };

/** A plain object (`{…}`): not a `Date`, a `File` or an array, which are kept as they are. */
const isPlain = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));

/** A path's keys; one through `__proto__` or `constructor` reaches nothing. */
const keysOf = (path: string): string[] | undefined => {
  const keys = path.split(".");
  return keys.some((key) => ["__proto__", "constructor", "prototype"].includes(key))
    ? undefined
    : keys;
};

/** What a record holds at a path: `address.city`, `lines.0.qty`. */
export function valueAt(record: unknown, path: string): unknown {
  let at = record;
  for (const key of keysOf(path) ?? [""]) {
    if (at === null || typeof at !== "object" || !Object.hasOwn(at, key)) return undefined;
    at = (at as Record<string, unknown>)[key];
  }
  return at;
}

/** A copy of the record with a path set (objects made on the way); `undefined` deletes it. */
export function withValue<T>(record: T, path: string, value: unknown): T {
  const keys = keysOf(path);
  if (!keys || (value === undefined && valueAt(record, path) === undefined)) return record;
  const put = (at: unknown, [key, ...rest]: string[]): unknown => {
    const copy = (Array.isArray(at) ? [...at] : isPlain(at) ? { ...at } : {}) as Record<
      string,
      unknown
    >;
    if (rest.length) copy[key] = put(copy[key], rest);
    else if (value === undefined) delete copy[key];
    else copy[key] = value;
    return copy;
  };
  return put(record, keys) as T;
}

/** Whether two values hold the same: arrays and plain objects by what's in them. */
export function same(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => same(item, b[i]));
  }
  if (!isPlain(a) || !isPlain(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length &&
    keys.every((key) => Object.hasOwn(b, key) && same(a[key], b[key]));
}

/** Nothing at all: none, `null`, or empty text. */
const empty = (value: unknown) => value === undefined || value === null || value === "";

/** What a control of a kind shows for a stored value. */
export function shownAs(kind: DraftKind, value: unknown): unknown {
  if (kind === "text" || kind === "number") return empty(value) ? "" : String(value);
  if (kind === "checked") return value === true;
  if (kind === "value") return value ?? undefined;
  if (kind === "list") return Array.isArray(value) ? value : [];
  return value;
}

/** What an edit saves, as the record keeps it: `undefined` when it clears the field. */
export function savedOf({ kind, raw }: Edit): unknown {
  if (kind === "text") return empty(raw) ? undefined : String(raw);
  if (kind === "number") {
    const text = empty(raw) ? "" : String(raw);
    if (text.trim() === "") return undefined;
    // Text that isn't a number stays text: the schema refuses it, by its field.
    return Number.isFinite(Number(text)) ? Number(text) : text;
  }
  if (kind === "checked") return raw === true;
  if (kind === "value") return empty(raw) ? undefined : raw;
  if (kind === "list") return Array.isArray(raw) ? raw : [];
  return raw;
}

/**
 * Whether what's saved changes the stored value. A clear changes a field that holds something; a
 * checkbox, whether it's checked; anything else, unless it's the same (`[]` over `null` is sent).
 */
export function changes(kind: DraftKind, saved: unknown, stored: unknown): boolean {
  if (kind === "checked") return (saved === true) !== (stored === true);
  if (saved === undefined) return !empty(stored);
  return !same(saved, stored);
}

/** The edits, then the parts' values over them, as what each path saves (never `_id`). */
function finalOf(edits: Edits, handed: Record<string, unknown>) {
  const final = new Map<string, Edit & { saved: unknown }>();
  for (const [path, edit] of Object.entries(edits)) {
    final.set(path, { ...edit, saved: savedOf(edit) });
  }
  for (const [path, value] of Object.entries(handed)) {
    if (value !== undefined) final.set(path, { kind: "set", raw: value, saved: value });
  }
  for (const path of final.keys()) {
    if (path === "_id" || path.startsWith("_id.")) final.delete(path);
  }
  return final;
}

/** What changed in a stored record (`set`, or `unset` for a clear); `undefined` when nothing did. */
export function updateOf(
  record: unknown,
  edits: Edits,
  handed: Record<string, unknown>,
): Changed | undefined {
  const set: Record<string, unknown> = {};
  const unset: string[] = [];
  for (const [path, change] of finalOf(edits, handed)) {
    if (!changes(change.kind, change.saved, valueAt(record, path))) continue;
    if (change.saved === undefined) unset.push(path);
    else set[path] = change.saved;
  }
  const $unset = Object.fromEntries(unset.map((path) => [path, ""])) as Record<string, "">;
  const setting = Object.keys(set).length > 0;
  if (!setting && !unset.length) return undefined;
  const update: RecordUpdate = !unset.length
    ? { $set: set }
    : !setting
    ? { $unset }
    : { $set: set, $unset };
  return { set, unset, update };
}

/** A deep copy of plain data; anything else (a `Date`, a `File`) as it is. */
const copy = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(copy)
    : isPlain(value)
    ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copy(item)]))
    : value;

/** A new record: its defaults, with the edits that change them and the parts' values. */
export function createOf(
  defaults: Record<string, unknown>,
  edits: Edits,
  handed: Record<string, unknown>,
): Record<string, unknown> {
  let values = copy(defaults) as Record<string, unknown>;
  for (const [path, change] of finalOf(edits, handed)) {
    if (changes(change.kind, change.saved, valueAt(defaults, path))) {
      values = withValue(values, path, change.saved);
    }
  }
  return values;
}

/** Whether the field `name` holds the path `field`: itself, or a field inside it. */
export const holds = (name: string, field: string): boolean =>
  field === name || field.startsWith(`${name}.`);

/** Whether two paths are one inside the other. */
export const related = (a: string, b: string): boolean => holds(a, b) || holds(b, a);

/**
 * A refusal's words for people: the app's for its field, else for the nearest field holding it
 * (`lines` for `lines.0.qty`), else the refusal's own; `undefined` when it has none.
 */
export function refusalWords(
  field: string | undefined,
  error: unknown,
  errors?: Record<string, ReactNode>,
): ReactNode | undefined {
  const keys = field?.split(".") ?? [];
  for (let n = keys.length; n > 0 && errors; n--) {
    const path = keys.slice(0, n).join(".");
    if (Object.hasOwn(errors, path)) return errors[path];
  }
  return wordsOf(error);
}
