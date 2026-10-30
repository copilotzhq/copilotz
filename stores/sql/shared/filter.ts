/**
 * Translates the MongoDB query language into SQL over JSON documents, for any
 * SQL store. This file walks filters, operators and sorts; a dialect writes
 * the SQL for each leaf. The semantics are runtime/mongo.ts's (the reference),
 * which are MongoDB's: equality also matches an array element and null also
 * a missing field; comparisons only match values of the operand's type, and
 * an array when an element does; sorting orders types as MongoDB does.
 */
import type { Filter, FindOptions, ScalarType } from "../../../runtime/store.ts";

/** Binds a value as a statement parameter and returns its placeholder. */
export type Bind = (value: unknown) => string;

export type Comparison = "$gt" | "$gte" | "$lt" | "$lte";

/** How one SQL engine expresses each leaf. Every predicate must be non-NULL. */
export type Dialect = {
  /** The bound form of a dot path. Numeric segments index arrays. */
  path(field: string): unknown;
  equals(path: unknown, value: unknown, bind: Bind): string;
  compare(path: unknown, op: Comparison, value: unknown, bind: Bind): string;
  exists(path: unknown, present: boolean, bind: Bind): string;
  /**
   * Whether the field (or, for an array, one of its elements) equals one of
   * `values`, all of one scalar type, bound as one parameter: the statement
   * is the same whatever their number.
   */
  among(path: unknown, type: ScalarType, values: unknown[], bind: Bind): string;
  /**
   * Whether the field is an array with an element that is (`$in`, `$eq`) or
   * isn't (`$nin`, `$ne`) one of `values`, bound as one.
   */
  elemMatch(path: unknown, op: "$in" | "$nin", values: unknown[], bind: Bind): string;
  /** Whether an indexed scalar's expression is one of `values` (all of `type`), bound as one. */
  oneOf(expression: string, type: ScalarType, values: unknown[], bind: Bind): string;
  order(path: unknown, direction: 1 | -1, bind: Bind): string;
  /**
   * An indexed field (a scalar its schema types) as the expression its index
   * holds, compared as that type alone: what an index can serve. May be NULL
   * (a missing field): negations around it say so.
   */
  scalar(field: string, type: ScalarType): string;
  /** A value bound for comparison with a scalar expression of its type. */
  operand(type: ScalarType, value: unknown, bind: Bind): string;
  /**
   * An indexed field in ORDER BY, as its index holds it, so the index can
   * serve the order: null and missing first, as MongoDB orders them.
   */
  sorted(field: string, type: ScalarType, direction: 1 | -1): string;
  /** The column that keeps insertion order: ties sort by it, as in the reference. */
  natural: string;
  /** The LIMIT that means "no limit", for an OFFSET without one. */
  unlimited: string;
};

/** A collection's indexed fields and their types: filters on them may use their indexes. */
export type Scalars = Map<string, ScalarType>;

/** Negates a condition that may be NULL (an indexed field that's missing): NULL is false. */
const not = (sql: string) => `NOT COALESCE(${sql}, FALSE)`;

/** Whether a value has the type a scalar field holds (only then may its index compare it). */
const fits = (type: ScalarType, value: unknown) => (typeof value as string) === type;

type Context = { dialect: Dialect; bind: Bind; scalars?: Scalars };

function compile(filter: Filter, c: Context): string {
  const parts = Object.entries(filter).map(([key, condition]) => {
    if (key === "$and" || key === "$or" || key === "$nor") {
      const each = (condition as Filter[]).map((f) => `(${compile(f, c)})`);
      if (key === "$and") return each.length ? each.join(" AND ") : "TRUE";
      const any = each.length ? each.join(" OR ") : "FALSE";
      return key === "$or" ? `(${any})` : not(`(${any})`);
    }
    if (key.startsWith("$")) throw new Error(`Unsupported filter operator ${key}`);
    return test(key, condition, c);
  });
  return parts.length ? parts.join(" AND ") : "TRUE";
}

function test(field: string, condition: unknown, c: Context): string {
  const { dialect, bind } = c;
  const path = dialect.path(field);
  const type = c.scalars?.get(field);
  const operators = condition !== null && typeof condition === "object" &&
    !Array.isArray(condition) && Object.keys(condition).some((key) => key.startsWith("$"));
  if (!operators) {
    // An indexed scalar equal to a value of its type: what its index serves.
    return type && fits(type, condition)
      ? `${dialect.scalar(field, type)} = ${dialect.operand(type, condition, bind)}`
      : dialect.equals(path, condition, bind);
  }
  const parts = Object.entries(condition as Record<string, unknown>).map(([op, arg]) => {
    switch (op) {
      case "$eq":
        return test(field, arg, c);
      case "$ne":
      case "$not":
        return not(test(field, arg, c));
      case "$in":
      case "$nin": {
        const sql = among(field, path, type, arg as unknown[], c);
        return op === "$in" ? sql : not(sql);
      }
      case "$exists":
        return dialect.exists(path, Boolean(arg), bind);
      case "$elemMatch": {
        const [[inner, values]] = Object.entries(arg as Record<string, unknown>);
        const among = inner === "$in" || inner === "$eq" ? "$in" : "$nin";
        return dialect.elemMatch(path, among, [values].flat(), bind);
      }
      case "$gt":
      case "$gte":
      case "$lt":
      case "$lte":
        return type && type !== "boolean" && fits(type, arg)
          ? `${dialect.scalar(field, type)} ${SQL_OPS[op]} ${dialect.operand(type, arg, bind)}`
          : dialect.compare(path, op, arg, bind);
      default:
        throw new Error(`Unsupported filter operator ${op}`);
    }
  });
  return `(${parts.join(" AND ")})`;
}

const SQL_OPS = { $gt: ">", $gte: ">=", $lt: "<", $lte: "<=" } as const;

/**
 * `$in`: scalars of one type in one parameter (an indexed field compares its
 * index expression with them, which its index serves); `null` (which also
 * matches a missing field) and objects one by one.
 */
function among(
  field: string,
  path: unknown,
  type: ScalarType | undefined,
  values: unknown[],
  c: Context,
): string {
  const parts = values.filter((v) => v === null || typeof v === "object")
    .map((v) => test(field, v, c));
  for (const kind of ["string", "number", "boolean"] as const) {
    const of = values.filter((v) => typeof v === kind);
    if (of.length === 1) parts.push(test(field, of[0], c));
    else if (of.length && type === kind) {
      parts.push(c.dialect.oneOf(c.dialect.scalar(field, type), type, of, c.bind));
    } else if (of.length) parts.push(c.dialect.among(path, kind, of, c.bind));
  }
  return parts.length ? `(${parts.join(" OR ")})` : "FALSE";
}

/**
 * A WHERE clause over the `doc` column; `_id` equality uses the primary key,
 * and filters on a collection's indexed fields (`scalars`) can use theirs.
 */
export function where(
  filter: Filter = {},
  dialect: Dialect,
  bind: Bind,
  scalars?: Scalars,
): string {
  const c = { dialect, bind, scalars };
  if (typeof filter._id === "string") {
    const { _id, ...rest } = filter;
    return `id = ${bind(_id)} AND ${compile(rest, c)}`;
  }
  return compile(filter, c);
}

/**
 * ORDER BY, LIMIT and OFFSET. Ties keep insertion order, like the reference.
 * A collection's indexed fields (`scalars`) sort as their indexes hold them.
 */
export function page(
  options: FindOptions = {},
  dialect: Dialect,
  bind: Bind,
  scalars?: Scalars,
): string {
  const order = Object.entries(options.sort ?? {}).map(([field, direction]) => {
    const type = scalars?.get(field);
    const dir = direction === -1 ? -1 : 1;
    return type ? dialect.sorted(field, type, dir) : dialect.order(dialect.path(field), dir, bind);
  });
  let sql = ` ORDER BY ${[...order, `${dialect.natural} ASC`].join(", ")}`;
  if (options.limit !== undefined || options.skip) {
    sql += ` LIMIT ${options.limit !== undefined ? bind(options.limit) : dialect.unlimited}`;
  }
  if (options.skip) sql += ` OFFSET ${bind(options.skip)}`;
  return sql;
}
