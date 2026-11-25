/**
 * A record dialog's draft, as data (see record-dialog.tsx). The draft holds only what was
 * edited, by field name or dot path (`address.city`), each in its control's own form (a number
 * field's text). What the form shows is those edits over the record as it is now. A save sends
 * only the edits that change something: an untouched field never goes, an edit back to the
 * record's value doesn't either, and a field emptied is a clear (`unset`). A list emptied is
 * the empty list, a value of its own. What the form's parts hand up is compared the same way,
 * and wins over an edit of the same field, unless that edit was made after the submit started
 * (a correction typed while a part works).
 *
 * Only plain data is walked: plain objects and arrays are copied and compared by what's in
 * them; anything else (a `Date`, a `File`) is kept as it is, and a date compared by its time.
 * A path goes into what's there: a list by its index, an object by its key. Where nothing is
 * there, a word makes an object; a number is refused, as it could be a list's index or an
 * object's key (`hours.1`): give that field a value first, in the defaults or the record.
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

/** A plain object: `{…}` or one with no prototype, not a `Date`, a `File` or an array. */
const isPlain = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

/** A step of a path that indexes a list. */
const isIndex = (key: string) => /^(0|[1-9]\d*)$/.test(key);

/** A path's own keys; one through `__proto__` or `constructor` reaches nothing. */
const keysOf = (path: string): string[] | undefined => {
  const keys = path.split(".");
  return keys.some((key) => key === "__proto__" || key === "constructor" || key === "prototype")
    ? undefined
    : keys;
};

/** What a record holds at a path: `address.city`, `lines.0.qty`. */
export function valueAt(record: unknown, path: string): unknown {
  let at = record;
  for (const key of keysOf(path) ?? []) {
    if (at === null || typeof at !== "object" || !Object.hasOwn(at, key)) return undefined;
    at = (at as Record<string, unknown>)[key];
  }
  return keysOf(path) ? at : undefined;
}

/** A copy of the record with a path set (objects made on the way); `undefined` deletes it. */
export function withValue<T>(record: T, path: string, value: unknown): T {
  const keys = keysOf(path);
  // A number over nothing could be a list's or an object's: no guess, nothing set.
  if (!keys || unshaped(record, path) !== undefined) return record;
  const put = (at: unknown, [key, ...rest]: string[]): unknown => {
    // Nothing there (a word step): an object.
    const copy: Record<string, unknown> = Array.isArray(at)
      ? [...at] as unknown as Record<string, unknown>
      : isPlain(at)
      ? { ...at }
      : {};
    if (rest.length) copy[key] = put(Object.hasOwn(copy, key) ? copy[key] : undefined, rest);
    else if (value === undefined) delete copy[key];
    else copy[key] = value;
    return copy;
  };
  // Clearing what isn't there leaves the record as it is.
  if (value === undefined && valueAt(record, path) === undefined) return record;
  return put(record, keys) as T;
}

/**
 * Of a path, the field where nothing is and a number follows (`hours` in `hours.1`): it could be
 * a list's index or an object's key, so the path's shape there is unknown.
 */
export function unshaped(record: unknown, path: string): string | undefined {
  const keys = path.split(".");
  for (let i = 1; i < keys.length; i++) {
    const parent = keys.slice(0, i).join(".");
    if (isIndex(keys[i]) && (valueAt(record, parent) ?? undefined) === undefined) return parent;
  }
  return undefined;
}

/** A path the record can't hold as it is: the developer gives that field a value first. */
const unshapedError = (path: string, parent: string) =>
  new Error(
    `${path}: nothing is at ${parent}, and the number after it could be a list's index or an ` +
      `object's key. Give ${parent} a value first ([] or {}), in the defaults or the record.`,
  );

/**
 * Whether two values hold the same: arrays and plain objects by what's in them, dates by their
 * time, anything else only if it's the very same.
 */
export function same(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a instanceof Date && b instanceof Date) return Object.is(a.getTime(), b.getTime());
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => same(item, b[i]));
  }
  if (isPlain(a) && isPlain(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length &&
      keys.every((key) => Object.hasOwn(b, key) && same(a[key], b[key]));
  }
  return false;
}

/** Nothing at all: none, `null`, or empty text. */
const empty = (value: unknown) => value === undefined || value === null || value === "";

/** What a control of a kind shows for a stored value. */
export function shownAs(kind: DraftKind, value: unknown): unknown {
  switch (kind) {
    case "text":
    case "number":
      return value === undefined || value === null ? "" : String(value);
    case "checked":
      return value === true;
    case "value":
      return value ?? undefined;
    case "list":
      return Array.isArray(value) ? value : [];
    default:
      return value;
  }
}

/** What an edit saves, as the record keeps it: `undefined` when it clears the field. */
export function savedOf({ kind, raw }: Edit): unknown {
  switch (kind) {
    case "text":
      return raw === "" || raw === undefined || raw === null ? undefined : String(raw);
    case "number": {
      const text = raw === undefined || raw === null ? "" : String(raw);
      if (text.trim() === "") return undefined;
      const number = Number(text);
      // Text that isn't a number stays text: the schema refuses it, by its field.
      return Number.isFinite(number) ? number : text;
    }
    case "checked":
      return raw === true;
    case "value":
      return empty(raw) ? undefined : raw;
    case "list":
      return Array.isArray(raw) ? raw : [];
    default:
      return raw;
  }
}

/**
 * Whether what an edit (or a part) saves changes the stored value. A clear changes a field that
 * holds something (`undefined`, `null` and `""` hold nothing). A checkbox changes whether it's
 * checked (a field with no value isn't). Any other value changes the field unless it's the same
 * as what's stored, exactly: `[]` over `null` is a change.
 */
export function changes(kind: DraftKind, saved: unknown, stored: unknown): boolean {
  if (kind === "checked") return (saved === true) !== (stored === true);
  if (saved === undefined) return !empty(stored);
  return !same(saved, stored);
}

/** Whether a path is `_id`, which a save names in its filter and never sets. */
const isId = (path: string) => path === "_id" || path.startsWith("_id.");

/** The edits and the parts' values, as what each path saves: a part's value over an edit. */
function finalOf(
  edits: Edits,
  handed: Record<string, unknown>,
  later: ReadonlySet<string> = new Set(),
): Map<string, Edit & { saved: unknown }> {
  const final = new Map<string, Edit & { saved: unknown }>();
  for (const [path, edit] of Object.entries(edits)) {
    if (!isId(path)) final.set(path, { ...edit, saved: savedOf(edit) });
  }
  for (const [path, value] of Object.entries(handed)) {
    if (isId(path) || value === undefined) continue;
    // An edit made after the submit started is the person's last word on its field.
    if ([...later].some((edited) => holds(edited, path))) continue;
    // One made inside the part's field goes into the part's value, in its place.
    let merged = value;
    for (const edited of later) {
      if (edited === path || !holds(path, edited)) continue;
      merged = withValue(merged, edited.slice(path.length + 1), final.get(edited)?.saved);
      final.delete(edited);
    }
    final.set(path, { kind: "set", raw: merged, saved: merged });
  }
  return final;
}

/**
 * What changed in a stored record: the edits and the parts' values that change it (`set`, or
 * `unset` for a clear). A part's value wins over an edit of its field, unless that edit is in
 * `later` (made after the submit started). `undefined` when nothing changed. A path with a
 * number over nothing (`hours.1` with no `hours`) throws: give that field a value first.
 */
export function updateOf(
  record: unknown,
  edits: Edits,
  handed: Record<string, unknown>,
  later?: ReadonlySet<string>,
): Changed | undefined {
  const set: Record<string, unknown> = {};
  const unset: string[] = [];
  for (const [path, change] of finalOf(edits, handed, later)) {
    if (!changes(change.kind, change.saved, valueAt(record, path))) continue;
    if (change.saved === undefined) {
      unset.push(path);
      continue;
    }
    const parent = unshaped(record, path);
    if (parent !== undefined) throw unshapedError(path, parent);
    set[path] = change.saved;
  }
  const setting = Object.keys(set).length > 0;
  if (!setting && !unset.length) return undefined;
  const $unset = Object.fromEntries(unset.map((path) => [path, ""])) as Record<string, "">;
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

/**
 * A new record: its defaults, with the edits that change them (a clear deletes the field) and
 * what the form's parts handed up (over an edit of the same field, unless that edit is in
 * `later`). A path with a number over nothing throws: give that field a value first.
 */
export function createOf(
  defaults: Record<string, unknown>,
  edits: Edits,
  handed: Record<string, unknown>,
  later?: ReadonlySet<string>,
): Record<string, unknown> {
  let values = copy(defaults) as Record<string, unknown>;
  for (const [path, change] of finalOf(edits, handed, later)) {
    if (!changes(change.kind, change.saved, valueAt(defaults, path))) continue;
    const parent = change.saved === undefined ? undefined : unshaped(values, path);
    if (parent !== undefined) throw unshapedError(path, parent);
    values = withValue(values, path, change.saved);
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
  if (field && errors) {
    const keys = field.split(".");
    for (let n = keys.length; n > 0; n--) {
      const path = keys.slice(0, n).join(".");
      if (Object.hasOwn(errors, path)) return errors[path];
    }
  }
  return wordsOf(error);
}
