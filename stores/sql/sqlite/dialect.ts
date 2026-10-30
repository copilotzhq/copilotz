/**
 * SQLite's leaves for the shared MongoDB-to-SQL translation (../shared/filter.ts),
 * over JSON text with the JSON1 functions.
 */
import type { Aggregates } from "../shared/aggregate.ts";
import type { Bind, Dialect } from "../shared/filter.ts";

/** A dot path as a JSON path. Numeric segments index arrays. */
const jsonPath = (field: string) =>
  "$" + field.split(".").map((key) => {
    if (/^\d+$/.test(key)) return `[${key}]`;
    if (key.includes('"')) throw new Error(`Unsupported field name ${JSON.stringify(key)}`);
    return `."${key}"`;
  }).join("");

const TYPES: Record<string, string> = {
  number: "IN ('integer','real')",
  string: "= 'text'",
};
/** A scalar type's JSON types, booleans included (read as 1 and 0). */
const KINDS: Record<string, string> = { ...TYPES, boolean: "IN ('true','false')" };

/** Values bound as one JSON array, read back as rows of `value`. */
const each = (values: unknown[], bind: Bind) =>
  `(SELECT value FROM json_each(${bind(JSON.stringify(values))}))`;

const typeOf = (value: unknown) =>
  value === null
    ? "= 'null'"
    : typeof value === "boolean"
    ? `= '${value}'`
    : typeof value === "object"
    ? "IN ('object','array')"
    : TYPES[typeof value];

/** A bound value to compare with: JSON values are normalized by SQLite itself. */
const operand = (value: unknown, bind: Bind) =>
  typeof value === "object" && value !== null
    ? `json(${bind(JSON.stringify(value))})`
    : bind(value);

const SQL_OPS = { $gt: ">", $gte: ">=", $lt: "<", $lte: "<=" } as const;

/** True when `path` holds an array with an element meeting `condition` (on `type`/`value`). */
const element = (path: unknown, bind: Bind, condition: string) =>
  `(json_type(doc, ${bind(path)}) = 'array' AND EXISTS (SELECT 1 FROM ` +
  `json_each(doc, ${bind(path)}) WHERE ${condition}))`;

/** An indexed scalar's expression: the same text in its index and in every filter on it. */
export const scalar = (field: string) =>
  `json_extract(doc, '${jsonPath(field).replaceAll("'", "''")}')`;

export const sqlite: Dialect = {
  path: jsonPath,
  scalar,
  // Booleans read as 1 and 0.
  operand: (type, value, bind) => type === "boolean" ? (value ? "1" : "0") : bind(value),
  // SQLite orders NULL (missing) below everything.
  sorted: (field, _type, direction) => `${scalar(field)} ${direction === -1 ? "DESC" : "ASC"}`,
  natural: "rowid",
  unlimited: "-1",
  equals(path, value, bind) {
    const type = typeOf(value);
    if (!type) throw new Error(`Unsupported filter value ${String(value)}`);
    // Booleans and null are fully described by their JSON type.
    const scalar = value === null || typeof value === "boolean";
    const whole = `json_type(doc, ${bind(path)}) ${type}` +
      (scalar ? "" : ` AND json_extract(doc, ${bind(path)}) = ${operand(value, bind)}`);
    const inside = element(
      path,
      bind,
      `type ${type}` + (scalar ? "" : ` AND value = ${operand(value, bind)}`),
    );
    // null also matches a missing field, as in MongoDB.
    const missing = value === null ? `json_type(doc, ${bind(path)}) IS NULL OR ` : "";
    return `COALESCE(${missing}(${whole}) OR ${inside}, 0)`;
  },
  compare(path, op, value, bind) {
    if (value === null) {
      // As in MongoDB, null only compares equal: to null and to a missing field.
      if (op === "$gt" || op === "$lt") return "FALSE";
      return `COALESCE(json_type(doc, ${bind(path)}) IS NULL OR json_type(doc, ${
        bind(path)
      }) = 'null' OR ${element(path, bind, "type = 'null'")}, 0)`;
    }
    const type = TYPES[typeof value];
    if (!type) throw new Error(`Unsupported comparison with ${JSON.stringify(value)}`);
    // Only the operand's type compares, and an array matches when an element does.
    return `COALESCE((json_type(doc, ${bind(path)}) ${type} AND json_extract(doc, ${bind(path)}) ${
      SQL_OPS[op]
    } ${bind(value)}) OR ${
      element(path, bind, `type ${type} AND value ${SQL_OPS[op]} ${bind(value)}`)
    }, 0)`;
  },
  exists: (path, present, bind) =>
    `(json_type(doc, ${bind(path)}) IS ${present ? "NOT " : ""}NULL)`,
  among(path, type, values, bind) {
    const kind = KINDS[type];
    return `COALESCE((json_type(doc, ${bind(path)}) ${kind} AND json_extract(doc, ${
      bind(path)
    }) IN ${each(values, bind)}) OR ${
      element(path, bind, `type ${kind} AND value IN ${each(values, bind)}`)
    }, 0)`;
  },
  oneOf: (expression, _type, values, bind) => `${expression} IN ${each(values, bind)}`,
  elemMatch: (path, op, values, bind) =>
    `COALESCE(${
      element(path, bind, `${op === "$nin" ? "NOT " : ""}(value IN ${each(values, bind)})`)
    }, 0)`,
  // MongoDB's order across types: null and missing (equal), numbers, strings,
  // objects, arrays, booleans; then the value, within numbers, strings and booleans.
  order(path, direction, bind) {
    const dir = direction === -1 ? "DESC" : "ASC";
    const type = () => `json_type(doc, ${bind(path)})`;
    const value = () => `json_extract(doc, ${bind(path)})`;
    return [
      `CASE ${type()} WHEN 'integer' THEN 1 WHEN 'real' THEN 1 WHEN 'text' THEN 2 ` +
      `WHEN 'object' THEN 3 WHEN 'array' THEN 4 WHEN 'true' THEN 5 WHEN 'false' THEN 5 ` +
      `ELSE 0 END ${dir}`,
      `CASE WHEN ${type()} IN ('integer', 'real') THEN ${value()} END ${dir}`,
      `CASE WHEN ${type()} = 'text' THEN ${value()} END ${dir}`,
      `CASE WHEN ${type()} IN ('true', 'false') THEN ${value()} END ${dir}`,
    ].join(", ");
  },
};

/** Grouping and totals over JSON text: keys as JSON text (`->`), parsed here. */
export const sqliteAggregates: Aggregates = {
  json: (path, bind) => `COALESCE(doc -> ${bind(path)}, 'null')`,
  number(path, bind) {
    const p = bind(path);
    return `CASE WHEN json_type(doc, ${p}) IN ('integer','real') THEN json_extract(doc, ${p}) END`;
  },
  text(path, bind) {
    const p = bind(path);
    return `CASE WHEN json_type(doc, ${p}) = 'text' THEN json_extract(doc, ${p}) END`;
  },
  substr(path, start, length, bind) {
    const p = bind(path);
    return `CASE WHEN json_type(doc, ${p}) = 'text' THEN ` +
      `json_quote(substr(json_extract(doc, ${p}), ${start + 1}, ${length})) ELSE 'null' END`;
  },
  parse: (value) => typeof value === "string" ? JSON.parse(value) : value,
};
