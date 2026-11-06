/**
 * MongoDB semantics in JavaScript: filters, sorting, projections and update
 * operators. The owner matches Processor filters with it and projects what it
 * reads; the in-memory adapter executes queries with it; SQL adapters
 * translate queries instead.
 */
import type { Doc, Filter, FindOptions, Projection, Update } from "./store.ts";
import { invalid } from "./errors.ts";

/**
 * A field name a write may give: not an operator's or a blob reference's
 * (`$…`, as MongoDB refuses them), nor `__proto__`, which reaches the
 * prototype; else `invalid`. `constructor` and `prototype` are names like any
 * other: paths follow and make an object's own fields only. `path` is what
 * the name is part of, for the message.
 */
export function checkName(name: string, path = name): void {
  if (!isFieldName(name)) {
    throw invalid(
      `A write can't name the field "${path.slice(0, 80)}": no part of it may start with "$", ` +
        `or be __proto__`,
    );
  }
}

/** Whether a write may give a field this name (see `checkName`). */
export const isFieldName = (name: string): boolean => !name.startsWith("$") && name !== "__proto__";

/** A dotted path a write may name: every part of it a field name it may give. */
export function checkPath(path: string): void {
  for (const name of path.split(".")) checkName(name, path);
}

/**
 * Whether a path goes on into `value`: an object or array, but not a blob
 * reference, which stands for a (large) string, nor any other object with a
 * `$blob` key (planted). A path ends at those as it does at a string.
 */
const branch = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Object.hasOwn(value, "$blob");

/** The value at a dotted path, through the document's own fields only (never its prototype's). */
export function get(doc: unknown, path: string): unknown {
  let value: unknown = doc;
  for (const key of path.split(".")) {
    if (!branch(value) || !Object.hasOwn(value, key)) return undefined;
    value = value[key];
  }
  return value;
}

/** Sets a dotted path's value, making objects on the way (in place of anything else there). */
function set(doc: Record<string, unknown>, path: string, value: unknown) {
  checkPath(path);
  const keys = path.split(".");
  let target = doc;
  for (const key of keys.slice(0, -1)) {
    const next = Object.hasOwn(target, key) ? target[key] : undefined;
    target = (branch(next) ? next : (target[key] = {})) as Record<string, unknown>;
  }
  target[keys.at(-1)!] = value;
}

function unset(doc: Record<string, unknown>, path: string) {
  checkPath(path);
  const keys = path.split(".");
  const parent = keys.length > 1 ? get(doc, keys.slice(0, -1).join(".")) : doc;
  if (branch(parent)) delete parent[keys.at(-1)!];
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * A projection a read may give, else `invalid`: each path 1 or 0 (`true` or
 * `false`), none naming an operator or `__proto__`, none inside another, and
 * all keeping fields or all leaving them out, but `_id`, which may go either
 * way with either.
 */
export function checkProjection(projection: unknown): asserts projection is Projection {
  if (!projection || typeof projection !== "object" || Array.isArray(projection)) {
    throw invalid("A projection is an object: { field: 1 } keeps fields, { field: 0 } leaves out");
  }
  const kinds = new Set<boolean>();
  for (const [path, on] of Object.entries(projection)) {
    if (![0, 1, true, false].includes(on as number)) {
      throw invalid(`A projection's "${path.slice(0, 80)}" is 1 or 0`);
    }
    if (!path.split(".").every(isFieldName)) {
      throw invalid(
        `A projection can't name "${path.slice(0, 80)}": no part of it may start with "$", ` +
          `or be __proto__`,
      );
    }
    if (path !== "_id") kinds.add(Boolean(on));
  }
  if (kinds.size > 1) {
    throw invalid("A projection keeps fields or leaves them out, not both (but `_id`)");
  }
  // As MongoDB: a path and one inside it ("a" and "a.b") collide.
  const paths = Object.keys(projection);
  const inside = paths.find((path) => paths.some((other) => path.startsWith(`${other}.`)));
  if (inside) throw invalid(`A projection names "${inside.slice(0, 80)}" and a path it's inside`);
}

/** `value` without the field at `path`, copied along the path: what it came from stays as it was. */
function without(value: Record<string, unknown>, path: string): Record<string, unknown> {
  const [key, ...rest] = path.split(".");
  if (!Object.hasOwn(value, key)) return value;
  const copy = { ...value };
  if (!rest.length) delete copy[key];
  else if (branch(value[key]) && !Array.isArray(value[key])) {
    copy[key] = without(value[key] as Record<string, unknown>, rest.join("."));
  }
  return copy;
}

/**
 * A document as a projection shows it, as MongoDB's `find` does: only the
 * fields it keeps (`{ name: 1 }`, with `_id` unless `_id: 0`), or all but
 * those it leaves out (`{ data: 0 }`). A dotted path goes into objects, not
 * arrays' items, and ends at a blob reference as at a string. The document
 * itself is never changed (the owner's cache holds it). Checked first
 * (`checkProjection`).
 */
export function project(doc: Doc, projection: Projection): Doc {
  const paths = Object.keys(projection).filter((path) => path !== "_id");
  const id = projection._id === undefined || Boolean(projection._id);
  if (paths.some((path) => projection[path])) {
    const kept: Record<string, unknown> = id && Object.hasOwn(doc, "_id") ? { _id: doc._id } : {};
    for (const path of paths) {
      const value = get(doc, path);
      if (value !== undefined) set(kept, path, value);
    }
    return kept as Doc;
  }
  let left: Record<string, unknown> = doc;
  for (const path of id ? paths : [...paths, "_id"]) left = without(left, path);
  return left as Doc;
}

const OPERATORS = new Set([
  "$eq",
  "$ne",
  "$gt",
  "$gte",
  "$lt",
  "$lte",
  "$in",
  "$nin",
  "$exists",
  "$not",
  "$elemMatch",
]);

/** A condition made of operators (`{ $gt: 1 }`), as opposed to a value to equal. */
const operatorObject = (condition: unknown): condition is Record<string, unknown> =>
  condition !== null && typeof condition === "object" && !Array.isArray(condition) &&
  Object.keys(condition).some((key) => key.startsWith("$"));

/**
 * MongoDB's order across types, for sorting: null and missing first (and
 * equal), then numbers, strings, objects, arrays and booleans.
 */
const rank = (v: unknown) =>
  v === undefined || v === null
    ? 0
    : typeof v === "number"
    ? 1
    : typeof v === "string"
    ? 2
    : Array.isArray(v)
    ? 4
    : typeof v === "object"
    ? 3
    : 5;

/** Sort order. Objects (and arrays) keep their insertion order among themselves. */
function compare(a: unknown, b: unknown): number {
  const ranks = rank(a) - rank(b);
  if (ranks || rank(a) === 0 || rank(a) === 3 || rank(a) === 4) return ranks;
  return (a as number) < (b as number) ? -1 : (a as number) > (b as number) ? 1 : 0;
}

const COMPARE = {
  $gt: (a: number | string, b: number | string) => a > b,
  $gte: (a: number | string, b: number | string) => a >= b,
  $lt: (a: number | string, b: number | string) => a < b,
  $lte: (a: number | string, b: number | string) => a <= b,
};

/**
 * `$gt`, `$gte`, `$lt`, `$lte` as in MongoDB: only values of the operand's
 * type compare (numbers, or strings); null is only `$gte`/`$lte` null or a
 * missing field; an array matches when one of its elements does.
 */
function compares(value: unknown, op: keyof typeof COMPARE, operand: unknown): boolean {
  const one = (v: unknown) =>
    operand === null
      ? (op === "$gte" || op === "$lte") && (v === null || v === undefined)
      : typeof v === typeof operand && COMPARE[op](v as number, operand as number);
  if (operand !== null && typeof operand !== "number" && typeof operand !== "string") {
    throw new Error(`Unsupported comparison with ${JSON.stringify(operand)}`);
  }
  return one(value) || (Array.isArray(value) && value.some(one));
}

function test(value: unknown, condition: unknown): boolean {
  if (!operatorObject(condition)) {
    // Equality also matches an element of an array field, and null a missing field,
    // as in MongoDB.
    return same(value, condition) || (condition === null && value === undefined) ||
      (Array.isArray(value) && value.some((item) => same(item, condition)));
  }
  return Object.entries(condition as Record<string, unknown>).every(([op, arg]) => {
    switch (op) {
      case "$eq":
        return test(value, arg);
      case "$ne":
        return !test(value, arg);
      case "$gt":
      case "$gte":
      case "$lt":
      case "$lte":
        return compares(value, op, arg);
      case "$in":
        return (arg as unknown[]).some((item) => test(value, item));
      case "$nin":
        return !(arg as unknown[]).some((item) => test(value, item));
      case "$exists":
        return (value !== undefined) === Boolean(arg);
      case "$not":
        return !test(value, arg);
      // An array with an element meeting the condition (`$in`, `$nin`, `$eq`, `$ne`).
      case "$elemMatch":
        return Array.isArray(value) && value.some((item) => test(item, arg));
      default:
        throw new Error(`Unsupported filter operator ${op}`);
    }
  });
}

/**
 * Throws for anything the reference doesn't implement, before reading any
 * document, as the SQL stores do when they translate the filter.
 */
export function check(filter: Filter): void {
  // What every store matches array elements on: one of these, with scalars.
  const elementCondition = (arg: unknown) => {
    const ops = operatorObject(arg) ? Object.entries(arg as Record<string, unknown>) : [];
    const [op, values] = ops[0] ?? [];
    if (
      ops.length !== 1 || !["$in", "$nin", "$eq", "$ne"].includes(op!) ||
      [values].flat().some((v) => v !== null && typeof v === "object")
    ) {
      throw new Error("$elemMatch takes one of $in, $nin, $eq or $ne, with scalars");
    }
  };
  const condition = (value: unknown): void => {
    if (!operatorObject(value)) return;
    for (const [op, arg] of Object.entries(value)) {
      if (!OPERATORS.has(op)) throw new Error(`Unsupported filter operator ${op}`);
      if (op === "$in" || op === "$nin") (arg as unknown[]).forEach(condition);
      else if (op === "$eq" || op === "$ne" || op === "$not") condition(arg);
      else if (op === "$elemMatch") elementCondition(arg);
      else if (op !== "$exists" && arg !== null && !["number", "string"].includes(typeof arg)) {
        throw new Error(`Unsupported comparison with ${JSON.stringify(arg)}`);
      }
    }
  };
  for (const [key, value] of Object.entries(filter)) {
    if (key === "$and" || key === "$or" || key === "$nor") (value as Filter[]).forEach(check);
    else if (key.startsWith("$")) throw new Error(`Unsupported filter operator ${key}`);
    else condition(value);
  }
}

/**
 * The strings a condition equals (a string, `$eq`, `$in` of strings): a
 * document it matches has one of them in that field, or in an array there.
 */
const equalTo = (condition: unknown): string[] | undefined => {
  if (typeof condition === "string") return [condition];
  if (!condition || typeof condition !== "object" || Array.isArray(condition)) return undefined;
  if (Object.keys(condition).length !== 1) return undefined;
  const { $eq, $in } = condition as { $eq?: unknown; $in?: unknown };
  if (typeof $eq === "string") return [$eq];
  return Array.isArray($in) && $in.every((v) => typeof v === "string") ? $in : undefined;
};

/** The most values a filter is known by (`namedBy`): a longer `$in` names nothing. */
const NAMED_MOST = 256;

/**
 * What a filter names, if anything: a field of its own (top-level) it
 * matches by equality to some strings (a chat's `thread`, an `_id`), the
 * fewest. A document it matches has one of them there (`valuesAt`), so a
 * change to any other can't concern it.
 */
export function namedBy(filter: Filter): { field: string; values: string[] } | undefined {
  let best: { field: string; values: string[] } | undefined;
  for (const [field, condition] of Object.entries(filter)) {
    if (field.startsWith("$") || field.includes(".")) continue;
    const values = equalTo(condition);
    if (!values || values.length > NAMED_MOST) continue;
    if (!best || values.length < best.values.length) best = { field, values };
  }
  return best;
}

/** The strings a document has in a field of its own: its value, or those of an array there. */
export function valuesAt(doc: unknown, field: string): string[] {
  const value = (doc as Record<string, unknown>)[field];
  if (typeof value === "string") return [value];
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

export function matches(doc: unknown, filter: Filter = {}): boolean {
  return Object.entries(filter).every(([key, condition]) => {
    if (key === "$and") return (condition as Filter[]).every((f) => matches(doc, f));
    if (key === "$or") return (condition as Filter[]).some((f) => matches(doc, f));
    if (key === "$nor") return !(condition as Filter[]).some((f) => matches(doc, f));
    return test(get(doc, key), condition);
  });
}

/** Orders documents by a MongoDB sort; ties compare equal (callers keep insertion order). */
export const compareBy = (sort: Record<string, 1 | -1> = {}) => (a: unknown, b: unknown) => {
  for (const [field, direction] of Object.entries(sort)) {
    const order = compare(get(a, field), get(b, field)) * direction;
    if (order) return order;
  }
  return 0;
};

export function sortAndPage<T>(docs: T[], options: FindOptions = {}): T[] {
  const sorted = options.sort ? [...docs].sort(compareBy(options.sort)) : docs;
  const start = options.skip ?? 0;
  return sorted.slice(start, options.limit === undefined ? undefined : start + options.limit);
}

/**
 * What an upsert's new document starts from, as MongoDB has it: the filter's
 * equality fields, those of its top-level `$and` clauses too (a rule's filter
 * joins the caller's that way), and its `_id`, or a new one.
 */
export function seedOf(filter: Filter): Doc {
  const seed: Record<string, unknown> = {};
  // What it takes, it writes.
  const checked = (path: string) => (checkPath(path), path);
  const take = (clause: Filter) => {
    for (const [path, value] of Object.entries(clause)) {
      if (path === "$and") { for (const each of value as Filter[]) take(each); }
      else if (path.startsWith("$")) continue;
      else if (value === null || typeof value !== "object") seed[checked(path)] = value;
      else if ("$eq" in value && Object.keys(value).length === 1) seed[checked(path)] = value.$eq;
    }
  };
  take(filter);
  return { ...seed, _id: String(seed._id ?? crypto.randomUUID()) } as Doc;
}

/** Applies a MongoDB update. A document without `$` operators replaces the fields. */
export function applyUpdate(doc: Doc, update: Update | Record<string, unknown>): Doc {
  const next = structuredClone(doc) as Doc;
  const keys = Object.keys(update);
  if (!keys.some((key) => key.startsWith("$"))) {
    return { ...(update as Record<string, unknown>), _id: doc._id };
  }
  const u = update as Update;
  for (const op of keys) {
    if (!["$set", "$unset", "$inc", "$push", "$pull", "$addToSet"].includes(op)) {
      throw new Error(`Unsupported update operator ${op}`);
    }
  }
  for (const [path, value] of Object.entries(u.$set ?? {})) set(next, path, value);
  for (const path of Object.keys(u.$unset ?? {})) unset(next, path);
  for (const [path, by] of Object.entries(u.$inc ?? {})) {
    set(next, path, (Number(get(next, path)) || 0) + Number(by));
  }
  for (const [path, value] of Object.entries(u.$push ?? {})) {
    const list = Array.isArray(get(next, path)) ? [...(get(next, path) as unknown[])] : [];
    const each = value && typeof value === "object" && "$each" in value
      ? (value as { $each: unknown[] }).$each
      : [value];
    set(next, path, [...list, ...each]);
  }
  for (const [path, value] of Object.entries(u.$addToSet ?? {})) {
    const list = Array.isArray(get(next, path)) ? [...(get(next, path) as unknown[])] : [];
    if (!list.some((item) => same(item, value))) list.push(value);
    set(next, path, list);
  }
  for (const [path, condition] of Object.entries(u.$pull ?? {})) {
    const list = Array.isArray(get(next, path)) ? (get(next, path) as unknown[]) : [];
    set(next, path, list.filter((item) => !test(item, condition)));
  }
  next._id = doc._id;
  return next;
}
