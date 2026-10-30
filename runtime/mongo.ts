/**
 * MongoDB semantics in JavaScript: filters, sorting and update operators. The
 * owner matches Processor filters with it and the in-memory adapter executes
 * queries with it; SQL adapters translate queries instead.
 */
import type { Doc, Filter, FindOptions, Update } from "./store.ts";

export function get(doc: unknown, path: string): unknown {
  let value: unknown = doc;
  for (const key of path.split(".")) {
    if (value === null || typeof value !== "object") return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

function set(doc: Record<string, unknown>, path: string, value: unknown) {
  const keys = path.split(".");
  let target = doc;
  for (const key of keys.slice(0, -1)) {
    if (target[key] === null || typeof target[key] !== "object") target[key] = {};
    target = target[key] as Record<string, unknown>;
  }
  target[keys.at(-1)!] = value;
}

function unset(doc: Record<string, unknown>, path: string) {
  const keys = path.split(".");
  const parent = keys.length > 1 ? get(doc, keys.slice(0, -1).join(".")) : doc;
  if (parent && typeof parent === "object") {
    delete (parent as Record<string, unknown>)[keys.at(-1)!];
  }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

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
  const take = (clause: Filter) => {
    for (const [path, value] of Object.entries(clause)) {
      if (path === "$and") { for (const each of value as Filter[]) take(each); }
      else if (path.startsWith("$")) continue;
      else if (value === null || typeof value !== "object") seed[path] = value;
      else if ("$eq" in value && Object.keys(value).length === 1) seed[path] = value.$eq;
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
