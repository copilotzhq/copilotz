/**
 * PostgreSQL's leaves for the shared MongoDB-to-SQL translation
 * (../shared/filter.ts), over `jsonb` documents.
 */
import type { Aggregates } from "../shared/aggregate.ts";
import type { Bind, Dialect } from "../shared/filter.ts";
import type { ScalarType } from "../../../runtime/store.ts";

/** A dot path as a text array: `#>` treats numeric segments as array indexes. */
const segments = (field: string) => field.split(".");

const at = (path: unknown, bind: Bind) => `doc #> ${bind(path)}::text[]`;

const SQL_OPS = { $gt: ">", $gte: ">=", $lt: "<", $lte: "<=" } as const;

/** True when `path` holds an array with an element meeting `condition` (on `e`). */
const element = (path: unknown, bind: Bind, condition: string) =>
  `CASE WHEN jsonb_typeof(${at(path, bind)}) = 'array' THEN EXISTS (SELECT 1 FROM ` +
  `jsonb_array_elements(${at(path, bind)}) e WHERE ${condition}) ELSE FALSE END`;

/** A dot path as a SQL text-array literal: `'{"tags","tenant"}'`. */
const literalPath = (field: string) =>
  `'{${
    field.split(".").map((key) => `"${key.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`)
      .join(",").replaceAll("'", "''")
  }}'`;

/** An indexed scalar's expression: the same text in its index and in every filter on it. */
export function scalar(field: string, type: ScalarType): string {
  const p = literalPath(field);
  if (type === "string") return `((doc #>> ${p}) COLLATE "C")`;
  const cast = type === "number" ? "numeric" : "boolean";
  return `(CASE WHEN jsonb_typeof(doc #> ${p}) = '${type}' THEN (doc #>> ${p})::${cast} END)`;
}

export const postgres: Dialect = {
  path: segments,
  scalar,
  // Indexes hold NULL (missing) first: forwards ascending, backwards descending.
  sorted: (field, type, direction) =>
    `${scalar(field, type)} ${direction === -1 ? "DESC NULLS LAST" : "ASC NULLS FIRST"}`,
  operand: (type, value, bind) =>
    `${bind(value)}::${type === "string" ? "text" : type === "number" ? "numeric" : "boolean"}`,
  natural: "n",
  unlimited: "ALL",
  equals(path, value, bind) {
    if (value === undefined) throw new Error("Unsupported filter value undefined");
    const json = `${bind(JSON.stringify(value))}::jsonb`;
    // null also matches a missing field, as in MongoDB.
    const missing = value === null ? `${at(path, bind)} IS NULL OR ` : "";
    return `COALESCE(${missing}${at(path, bind)} = ${json} OR ` +
      `${element(path, bind, `e = ${json}`)}, FALSE)`;
  },
  compare(path, op, value, bind) {
    if (value === null) {
      // As in MongoDB, null only compares equal: to null and to a missing field.
      if (op === "$gt" || op === "$lt") return "FALSE";
      return `COALESCE(${at(path, bind)} IS NULL OR jsonb_typeof(${at(path, bind)}) = 'null' OR ` +
        `${element(path, bind, "jsonb_typeof(e) = 'null'")}, FALSE)`;
    }
    const test = (json: string) => {
      if (typeof value === "number") {
        return `CASE WHEN jsonb_typeof(${json}) = 'number' THEN (${json} #>> '{}')::numeric ` +
          `${SQL_OPS[op]} ${bind(value)}::numeric ELSE FALSE END`;
      }
      if (typeof value === "string") {
        // Code-point order, like JavaScript's string comparison.
        return `CASE WHEN jsonb_typeof(${json}) = 'string' THEN (${json} #>> '{}') COLLATE "C" ` +
          `${SQL_OPS[op]} ${bind(value)}::text ELSE FALSE END`;
      }
      throw new Error(`Unsupported comparison with ${JSON.stringify(value)}`);
    };
    // Only the operand's type compares, and an array matches when an element does.
    return `COALESCE(${test(at(path, bind))} OR ${element(path, bind, test("e"))}, FALSE)`;
  },
  exists: (path, present, bind) => `(${at(path, bind)} IS ${present ? "NOT " : ""}NULL)`,
  // jsonb equality is type-strict, as MongoDB's: one list serves every type.
  among(path, _type, values, bind) {
    const list = () => `(SELECT jsonb_array_elements(${bind(JSON.stringify(values))}::jsonb))`;
    return `COALESCE(${at(path, bind)} IN ${list()} OR ${
      element(path, bind, `e IN ${list()}`)
    }, FALSE)`;
  },
  elemMatch: (path, op, values, bind) =>
    `COALESCE(${
      element(
        path,
        bind,
        `${op === "$nin" ? "NOT " : ""}(e IN (SELECT jsonb_array_elements(${
          bind(JSON.stringify(values))
        }::jsonb)))`,
      )
    }, FALSE)`,
  oneOf: (expression, type, values, bind) =>
    `${expression} IN (SELECT jsonb_array_elements_text(${bind(JSON.stringify(values))}::jsonb)::${
      type === "string" ? "text" : type === "number" ? "numeric" : "boolean"
    })`,
  // MongoDB's order across types: null and missing (equal), numbers, strings,
  // objects, arrays, booleans; then the value, within numbers, strings and booleans.
  order(path, direction, bind) {
    const dir = direction === -1 ? "DESC" : "ASC";
    const type = () => `jsonb_typeof(${at(path, bind)})`;
    const text = () => `doc #>> ${bind(path)}::text[]`;
    return [
      `CASE ${type()} WHEN 'number' THEN 1 WHEN 'string' THEN 2 WHEN 'object' THEN 3 ` +
      `WHEN 'array' THEN 4 WHEN 'boolean' THEN 5 ELSE 0 END ${dir}`,
      `CASE WHEN ${type()} = 'number' THEN (${text()})::numeric END ${dir}`,
      `CASE WHEN ${type()} = 'string' THEN ${text()} END COLLATE "C" ${dir}`,
      `CASE WHEN ${type()} = 'boolean' THEN (${text()})::boolean END ${dir}`,
    ].join(", ");
  },
};

/** Grouping and totals over `jsonb`: keys as jsonb, which the driver parses. */
export const postgresAggregates: Aggregates = {
  json: (path, bind) => `COALESCE(doc #> ${bind(path)}::text[], 'null'::jsonb)`,
  number(path, bind) {
    const p = `${bind(path)}::text[]`;
    return `CASE WHEN jsonb_typeof(doc #> ${p}) = 'number' THEN (doc #>> ${p})::numeric END`;
  },
  text(path, bind) {
    const p = `${bind(path)}::text[]`;
    return `CASE WHEN jsonb_typeof(doc #> ${p}) = 'string' THEN (doc #>> ${p}) END COLLATE "C"`;
  },
  substr(path, start, length, bind) {
    const p = `${bind(path)}::text[]`;
    return `CASE WHEN jsonb_typeof(doc #> ${p}) = 'string' THEN ` +
      `to_jsonb(substr(doc #>> ${p}, ${start + 1}, ${length})) ELSE 'null'::jsonb END`;
  },
  parse: (value) => value,
};
