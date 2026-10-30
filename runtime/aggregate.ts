/**
 * MongoDB's `aggregate`, the part of it every store runs the same way: an
 * optional `$match`, at most one `$group`, then `$sort`, `$skip` and `$limit`
 * on what the group made. The reference runs it in JavaScript; SQL stores
 * send the match and the group as one `GROUP BY` and finish the (small)
 * grouped result with `finish`, so ordering is the reference's everywhere.
 *
 * - A group key (`_id`) is `null` (one group), a field (`"$tags.agent"`), an
 *   object of them (`{ day: { $substr: ["$at", 0, 10] }, agent: "$tags.agent" }`),
 *   or `$substr` of a field (a string's code units from `start`, `length` of them).
 *   A missing field groups as null.
 * - Accumulators: `$sum` (of a field's numbers, or a number per document),
 *   `$count: {}`, `$avg` (of numbers), `$min` and `$max` (numbers below
 *   strings, as MongoDB orders them; other types are left out).
 * - Groups come out ordered by `_id`, unless `$sort` says otherwise.
 */
import { get, matches, sortAndPage } from "./mongo.ts";
import { check } from "./mongo.ts";
import type { Doc, Filter } from "./store.ts";

/** A field (`"$a.b"`), a literal number or null, or a substring of a field. */
export type Expr = string | number | null | { $substr: [Expr, number, number] };

export type Accumulator =
  | { $sum: Expr }
  | { $count: Record<string, never> }
  | { $avg: Expr }
  | { $min: Expr }
  | { $max: Expr };

export type Stage =
  | { $match: Filter }
  | { $group: { _id: Expr | Record<string, Expr> } & Record<string, unknown> }
  | { $sort: Record<string, 1 | -1> }
  | { $skip: number }
  | { $limit: number };

export type Pipeline = Stage[];

export type Operator = "$sum" | "$count" | "$avg" | "$min" | "$max";

/** A pipeline in the one shape every store runs. */
export type Plan = {
  match: Filter;
  group?: {
    /** The key: one expression, or named ones (an object `_id`). */
    key: { expr: Expr } | { fields: [string, Expr][] };
    fields: [string, Operator, Expr][];
  };
  sort?: Record<string, 1 | -1>;
  skip?: number;
  limit?: number;
};

const invalid = (message: string) => Object.assign(new Error(message), { code: "invalid" });

const isField = (expr: unknown): expr is string => typeof expr === "string" && expr.startsWith("$");

function checkExpr(expr: unknown): Expr {
  if (expr === null || typeof expr === "number" || isField(expr)) return expr as Expr;
  if (expr && typeof expr === "object" && "$substr" in expr) {
    const [of, start, length] = (expr as { $substr: unknown[] }).$substr ?? [];
    if (!isField(of) || !Number.isInteger(start) || !Number.isInteger(length)) {
      throw invalid('$substr takes a field, a start and a length: ["$at", 0, 10]');
    }
    return expr as Expr;
  }
  throw invalid(
    `Unsupported expression ${JSON.stringify(expr)}: a field ("$a.b"), a number, null or $substr`,
  );
}

const OPERATORS = new Set<Operator>(["$sum", "$count", "$avg", "$min", "$max"]);

/** Checks a pipeline and puts it in the one shape every store runs; throws `invalid` otherwise. */
export function plan(pipeline: Pipeline): Plan {
  if (!Array.isArray(pipeline)) throw invalid("A pipeline is a list of stages");
  const out: Plan = { match: {} };
  let stage = 0;
  for (const step of pipeline) {
    const [name, ...extra] = Object.keys(step ?? {});
    if (!name || extra.length) throw invalid("Each stage has exactly one operator");
    const arg = (step as Record<string, unknown>)[name];
    if (name === "$match" && stage === 0) {
      check(arg as Filter);
      out.match = arg as Filter;
      stage = 1;
    } else if (name === "$group" && stage <= 1) {
      const { _id, ...rest } = (arg ?? {}) as Record<string, unknown>;
      if (!("_id" in (arg as object))) throw invalid("$group needs an _id (null for one group)");
      const key = _id !== null && typeof _id === "object" && !("$substr" in _id)
        ? { fields: Object.entries(_id).map(([k, e]) => [k, checkExpr(e)] as [string, Expr]) }
        : { expr: checkExpr(_id) };
      const fields = Object.entries(rest).map(([field, acc]): [string, Operator, Expr] => {
        const [op, ...more] = Object.keys(acc ?? {});
        if (!OPERATORS.has(op as Operator) || more.length) {
          throw invalid(`Unsupported accumulator for "${field}": $sum, $count, $avg, $min, $max`);
        }
        const expr = (acc as Record<string, unknown>)[op];
        return [field, op as Operator, op === "$count" ? 1 : checkExpr(expr)];
      });
      out.group = { key, fields };
      stage = 2;
    } else if (name === "$sort" && stage <= 2 && !out.sort) {
      out.sort = arg as Record<string, 1 | -1>;
      stage = 3;
    } else if (name === "$skip" && stage <= 3 && out.skip === undefined) {
      out.skip = Number(arg);
      stage = 4;
    } else if (name === "$limit" && stage <= 4 && out.limit === undefined) {
      out.limit = Number(arg);
      stage = 5;
    } else {
      throw invalid(
        `Unsupported stage ${name} here: a pipeline is $match, $group, $sort, $skip, $limit, in that order`,
      );
    }
  }
  return out;
}

/** An expression's value in a document; a missing field is null. */
export function evaluate(doc: unknown, expr: Expr): unknown {
  if (expr === null || typeof expr === "number") return expr;
  if (typeof expr === "string") return get(doc, expr.slice(1)) ?? null;
  const [of, start, length] = expr.$substr;
  const value = evaluate(doc, of);
  return typeof value === "string" ? value.slice(start, start + length) : null;
}

/** MongoDB's order across types: null, numbers, strings, objects, arrays, booleans. */
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

/** Group keys in a total order: by type, then value; objects field by field, arrays element by element. */
export function compareKeys(a: unknown, b: unknown): number {
  const ranks = rank(a) - rank(b);
  if (ranks) return ranks;
  switch (rank(a)) {
    case 0:
      return 0;
    case 3: {
      const [x, y] = [a as Record<string, unknown>, b as Record<string, unknown>];
      for (const key of new Set([...Object.keys(x), ...Object.keys(y)])) {
        const order = compareKeys(x[key], y[key]);
        if (order) return order;
      }
      return 0;
    }
    case 4: {
      const [x, y] = [a as unknown[], b as unknown[]];
      for (let i = 0; i < Math.min(x.length, y.length); i++) {
        const order = compareKeys(x[i], y[i]);
        if (order) return order;
      }
      return x.length - y.length;
    }
    default:
      return (a as number) < (b as number) ? -1 : (a as number) > (b as number) ? 1 : 0;
  }
}

/** Orders, skips and limits grouped documents, as the reference does. */
export function finish(groups: Doc[], p: Plan): Doc[] {
  const byKey = [...groups].sort((a, b) => compareKeys(a._id, b._id));
  return sortAndPage(byKey, { sort: p.sort, skip: p.skip, limit: p.limit });
}

/** The reference: runs a pipeline over documents. */
export function aggregate(docs: Doc[], pipeline: Pipeline | Plan): Doc[] {
  const p = Array.isArray(pipeline) ? plan(pipeline) : pipeline;
  const found = docs.filter((doc) => matches(doc, p.match));
  if (!p.group) return sortAndPage(found, { sort: p.sort, skip: p.skip, limit: p.limit });
  const { key, fields } = p.group;
  const keyOf = (doc: Doc) =>
    "expr" in key
      ? evaluate(doc, key.expr)
      : Object.fromEntries(key.fields.map(([name, expr]) => [name, evaluate(doc, expr)]));
  const groups = new Map<string, { _id: unknown; docs: Doc[] }>();
  for (const doc of found) {
    const _id = keyOf(doc);
    const id = JSON.stringify(_id);
    if (!groups.has(id)) groups.set(id, { _id, docs: [] });
    groups.get(id)!.docs.push(doc);
  }
  const out = [...groups.values()].map(({ _id, docs: members }) => {
    const doc: Doc = { _id: _id as string };
    for (const [field, op, expr] of fields) doc[field] = accumulate(members, op, expr);
    return doc;
  });
  return finish(out, p);
}

function accumulate(docs: Doc[], op: Operator, expr: Expr): unknown {
  if (op === "$count") return docs.length;
  if (op === "$sum" && (typeof expr === "number" || expr === null)) {
    return docs.length * (expr ?? 0);
  }
  const values = docs.map((doc) => evaluate(doc, expr));
  const numbers = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const strings = values.filter((v): v is string => typeof v === "string");
  switch (op) {
    case "$sum":
      return numbers.reduce((a, b) => a + b, 0);
    case "$avg":
      return numbers.length ? numbers.reduce((a, b) => a + b, 0) / numbers.length : null;
    case "$min":
      return numbers.length
        ? Math.min(...numbers)
        : strings.length
        ? strings.reduce((a, b) => (b < a ? b : a))
        : null;
    case "$max":
      return strings.length
        ? strings.reduce((a, b) => (b > a ? b : a))
        : numbers.length
        ? Math.max(...numbers)
        : null;
  }
}
