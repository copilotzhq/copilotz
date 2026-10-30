/**
 * `aggregate` for SQL stores: the match and the group run in the database as
 * one `GROUP BY`; the grouped rows become documents, ordered and paged by the
 * reference's `finish`, so every store answers the same.
 */
import { type Expr, finish, type Plan } from "../../../runtime/aggregate.ts";
import type { Doc } from "../../../runtime/store.ts";
import type { Bind, Dialect } from "./filter.ts";

/** How one SQL engine reads a field for grouping and totals. */
export type Aggregates = {
  /** The field as JSON, null when missing (a group key). */
  json(path: unknown, bind: Bind): string;
  /** The field's number, else NULL. */
  number(path: unknown, bind: Bind): string;
  /** The field's string, else NULL, in code-point order. */
  text(path: unknown, bind: Bind): string;
  /** A substring of the field's string, as JSON (null when it isn't a string). */
  substr(path: unknown, start: number, length: number, bind: Bind): string;
  /** A JSON column's value, as the driver gives it, to JavaScript. */
  parse(value: unknown): unknown;
};

/** Reads one row's column into a key. */
type Read = (row: Record<string, unknown>) => unknown;

/**
 * The SELECT list and GROUP BY of a grouped plan, and how to read its rows
 * into documents. The caller adds FROM and WHERE (the match).
 */
export function grouped(
  plan: Plan & { group: NonNullable<Plan["group"]> },
  dialect: Dialect,
  aggregates: Aggregates,
  bind: Bind,
): { select: string; groupBy: string; read(rows: Record<string, unknown>[]): Doc[] } {
  const columns: string[] = [];
  const column = (sql: string) => {
    columns.push(`${sql} AS c${columns.length}`);
    return `c${columns.length - 1}`;
  };
  const keys: number[] = [];
  /** A key expression: a constant, or a column. */
  const key = (expr: Expr): Read => {
    if (expr === null || typeof expr === "number") return () => expr;
    let sql: string;
    if (typeof expr === "string") sql = aggregates.json(dialect.path(expr.slice(1)), bind);
    else {
      const [of, start, length] = expr.$substr;
      sql = aggregates.substr(dialect.path((of as string).slice(1)), start, length, bind);
    }
    keys.push(columns.length + 1);
    const name = column(sql);
    return (row) => aggregates.parse(row[name]) ?? null;
  };
  const { key: k, fields } = plan.group;
  const id: Read = "expr" in k ? key(k.expr) : (() => {
    const parts = k.fields.map(([name, expr]) => [name, key(expr)] as const);
    return (row) => Object.fromEntries(parts.map(([name, read]) => [name, read(row)]));
  })();
  const num = (value: unknown) => value === null || value === undefined ? null : Number(value);
  const values = fields.map(([field, op, expr]): [string, Read] => {
    const path = typeof expr === "string" ? dialect.path(expr.slice(1)) : undefined;
    if (op === "$count") {
      const c = column("COUNT(*)");
      return [field, (row) => Number(row[c])];
    }
    if (op === "$sum" && path === undefined) {
      const c = column("COUNT(*)");
      return [field, (row) => Number(row[c]) * ((expr as number | null) ?? 0)];
    }
    const n = aggregates.number(path, bind);
    if (op === "$sum") {
      const c = column(`SUM(${n})`);
      return [field, (row) => num(row[c]) ?? 0];
    }
    if (op === "$avg") {
      const c = column(`AVG(${n})`);
      return [field, (row) => num(row[c])];
    }
    // Numbers rank below strings: $min prefers a number, $max a string.
    const fn = op === "$min" ? "MIN" : "MAX";
    const cn = column(`${fn}(${n})`);
    const cs = column(`${fn}(${aggregates.text(path, bind)})`);
    return [
      field,
      op === "$min"
        ? (row) => num(row[cn]) ?? row[cs] ?? null
        : (row) => row[cs] ?? num(row[cn]) ?? null,
    ];
  });
  return {
    select: columns.join(", "),
    // A group exists only when documents fall in it (one row for no key over nothing).
    groupBy: (keys.length ? ` GROUP BY ${keys.join(", ")}` : "") + " HAVING COUNT(*) > 0",
    read: (rows) =>
      finish(
        rows.map((row) => {
          const doc: Record<string, unknown> = { _id: id(row) };
          for (const [field, read] of values) doc[field] = read(row);
          return doc as Doc;
        }),
        plan,
      ),
  };
}
