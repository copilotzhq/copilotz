import { assertJsonValue } from "../json.ts";
import { stableStringify } from "./equal.ts";
import type { CollectionFilter } from "./types.ts";

/** Scalar predicates deliberately avoid string/number coercion. */
export type CollectionPredicateValue = string | number | boolean | null;
export type CollectionPredicate =
  | Readonly<{ and: readonly CollectionPredicate[] }>
  | Readonly<{ or: readonly CollectionPredicate[] }>
  | Readonly<{ not: CollectionPredicate }>
  | (
    & Readonly<{ field: string }>
    & (
      | Readonly<{ eq: CollectionPredicateValue }>
      | Readonly<{ ne: CollectionPredicateValue }>
      | Readonly<{ in: readonly CollectionPredicateValue[] }>
      | Readonly<{ lt: string | number }>
      | Readonly<{ lte: string | number }>
      | Readonly<{ gt: string | number }>
      | Readonly<{ gte: string | number }>
      | Readonly<{ exists: boolean }>
      | Readonly<{ isNull: boolean }>
      | Readonly<{ isBlank: boolean }>
      | Readonly<{ trimEq: string }>
      | Readonly<{ eqIgnoreCase: string }>
      | Readonly<{ inIgnoreCase: readonly string[] }>
      | Readonly<{ overlaps: readonly CollectionPredicateValue[] }>
      | Readonly<{ jsonEquals: unknown }>
    )
  );

function valueAt(
  record: Readonly<Record<string, unknown>>,
  field: string,
): unknown {
  return field.split(".").reduce<unknown>(
    (value, part) =>
      value && typeof value === "object" && !Array.isArray(value) &&
        Object.hasOwn(value, part)
        ? (value as Record<string, unknown>)[part]
        : undefined,
    record,
  );
}

function jsonContains(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) {
    return Array.isArray(actual) &&
      expected.every((item) =>
        actual.some((candidate) => jsonContains(candidate, item))
      );
  }
  if (expected && typeof expected === "object" && !Array.isArray(expected)) {
    if (!actual || typeof actual !== "object" || Array.isArray(actual)) {
      return false;
    }
    return Object.entries(expected as Record<string, unknown>).every((
      [key, value],
    ) => jsonContains((actual as Record<string, unknown>)[key], value));
  }
  return stableStringify(actual) === stableStringify(expected);
}

/** Mirrors query.ts JSON text comparisons, including SQL NULL behavior. */
function jsonText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  return undefined;
}

/** PostgreSQL timestamptz comparisons retain microseconds and normalize offsets. */
function timestampMicros(value: unknown): bigint | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^(.*?)(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return undefined;
  const base = Date.parse(`${match[1]}${match[3]}`);
  if (!Number.isFinite(base)) return undefined;
  const fraction = (match[2] ?? "").padEnd(6, "0").slice(0, 6);
  return BigInt(base) * 1_000n + BigInt(fraction);
}

function predicateEqual(
  field: string,
  actual: unknown,
  expected: unknown,
): boolean {
  if (field === "createdAt" || field === "updatedAt") {
    const left = timestampMicros(actual);
    const right = timestampMicros(expected);
    return left !== undefined && right !== undefined && left === right;
  }
  return stableStringify(actual) === stableStringify(expected);
}

function predicateCompare(
  field: string,
  actual: unknown,
  expected: string | number,
  comparison: (
    left: bigint | string | number,
    right: bigint | string | number,
  ) => boolean,
): boolean {
  if (field === "createdAt" || field === "updatedAt") {
    const left = timestampMicros(actual);
    const right = timestampMicros(expected);
    return left !== undefined && right !== undefined
      ? comparison(left, right)
      : false;
  }
  return typeof actual === typeof expected
    ? comparison(actual as string | number, expected)
    : false;
}

/** Evaluates the bounded JSON filter form against a candidate record. */
export function matchesCollectionPredicate(
  input: CollectionPredicate,
  record: Readonly<Record<string, unknown>>,
): boolean {
  if ("and" in input) {
    return input.and.every((item) => matchesCollectionPredicate(item, record));
  }
  if ("or" in input) {
    return input.or.some((item) => matchesCollectionPredicate(item, record));
  }
  if ("not" in input) return !matchesCollectionPredicate(input.not, record);
  const actual = valueAt(record, input.field);
  if ("exists" in input) return input.exists === (actual !== undefined);
  if ("isNull" in input) return input.isNull === (actual === null);
  if ("isBlank" in input) {
    return input.isBlank ===
      (typeof actual === "string" && actual.trim() === "");
  }
  if ("eq" in input) {
    return predicateEqual(input.field, actual, input.eq);
  }
  if ("ne" in input) {
    return !predicateEqual(input.field, actual, input.ne);
  }
  if ("jsonEquals" in input) {
    return stableStringify(actual) === stableStringify(input.jsonEquals);
  }
  if ("in" in input) {
    return input.in.some((entry) => predicateEqual(input.field, actual, entry));
  }
  if ("overlaps" in input) {
    return Array.isArray(actual) &&
      actual.some((entry) =>
        input.overlaps.some((candidate) =>
          stableStringify(entry) === stableStringify(candidate)
        )
      );
  }
  if ("trimEq" in input) {
    return typeof actual === "string" && actual.trim() === input.trimEq;
  }
  if ("eqIgnoreCase" in input) {
    return typeof actual === "string" &&
      actual.toLowerCase() === input.eqIgnoreCase.toLowerCase();
  }
  if ("inIgnoreCase" in input) {
    return typeof actual === "string" &&
      input.inIgnoreCase.some((entry) =>
        actual.toLowerCase() === entry.toLowerCase()
      );
  }
  if (typeof actual !== "string" && typeof actual !== "number") return false;
  if ("lt" in input) {
    return predicateCompare(
      input.field,
      actual,
      input.lt,
      (left, right) => left < right,
    );
  }
  if ("lte" in input) {
    return predicateCompare(
      input.field,
      actual,
      input.lte,
      (left, right) => left <= right,
    );
  }
  if ("gt" in input) {
    return predicateCompare(
      input.field,
      actual,
      input.gt,
      (left, right) => left > right,
    );
  }
  if ("gte" in input) {
    return predicateCompare(
      input.field,
      actual,
      input.gte,
      (left, right) => left >= right,
    );
  }
  return false;
}

export function matchesCollectionFilter(
  filter: CollectionFilter,
  record: Readonly<Record<string, unknown>>,
): boolean {
  if (filter.filter && !matchesCollectionPredicate(filter.filter, record)) {
    return false;
  }
  for (const [field, expected] of Object.entries(filter.where ?? {})) {
    const actualText = jsonText(valueAt(record, field));
    const expectedText = jsonText(expected);
    if (
      actualText === undefined || expectedText === undefined ||
      actualText !== expectedText
    ) return false;
  }
  for (const [field, expected] of Object.entries(filter.contains ?? {})) {
    if (!jsonContains(valueAt(record, field), expected)) return false;
  }
  for (const [field, expected] of Object.entries(filter.containsAny ?? {})) {
    const actual = valueAt(record, field);
    if (
      !Array.isArray(actual) ||
      !expected.some((candidate) =>
        actual.some((entry) => jsonContains(entry, candidate))
      )
    ) return false;
  }
  return true;
}

const MAX_DEPTH = 16;
const MAX_NODES = 256;
const MAX_VALUES = 1000;
const MAX_JSON_LENGTH = 1024 * 1024;
const MAX_JSON_DEPTH = 64;
const MAX_JSON_NODES = 65_536;
// ECMAScript String.trim whitespace, including BOM and Unicode separators.
const BLANK_CHARACTERS =
  "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";

/** Compile a bounded, two-valued predicate; all caller values are parameters. */
export function compileCollectionPredicate(
  input: CollectionPredicate,
  params: unknown[],
): string {
  let nodes = 0;
  let values = 0;
  const parameter = (value: unknown) => `$${params.push(value)}`;
  const scalar = (value: unknown): CollectionPredicateValue => {
    if (
      value === null || typeof value === "string" ||
      typeof value === "boolean" ||
      typeof value === "number" && Number.isFinite(value)
    ) return value;
    throw new TypeError("Predicate values must be finite JSON scalars.");
  };
  const canonicalJson = (value: unknown): string => {
    assertJsonValue(value, {
      label: "jsonEquals",
      maxDepth: MAX_JSON_DEPTH,
      maxNodes: MAX_JSON_NODES,
    });
    const serialized = stableStringify(value);
    if (serialized.length > MAX_JSON_LENGTH) {
      throw new TypeError("jsonEquals exceeds its size limit.");
    }
    return serialized;
  };
  const visit = (input: unknown, depth: number): string => {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) {
      throw new TypeError(
        "Collection predicate exceeds its depth or node limit.",
      );
    }
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new TypeError("Collection predicate must be an object.");
    }
    const node = input as Record<string, unknown>;
    const keys = Object.keys(node);
    const logical = keys.find((key) => ["and", "or", "not"].includes(key));
    if (logical) {
      if (keys.length !== 1) {
        throw new TypeError("Logical predicates accept exactly one operator.");
      }
      if (logical === "not") return `(NOT ${visit(node.not, depth + 1)})`;
      const children = node[logical];
      if (!Array.isArray(children) || children.length > MAX_NODES) {
        throw new TypeError("Logical predicates require a bounded array.");
      }
      return `(${
        Array.from(children, (child) => visit(child, depth + 1)).join(
          logical === "and" ? " AND " : " OR ",
        ) || (logical === "and" ? "TRUE" : "FALSE")
      })`;
    }
    if (
      keys.length !== 2 || !Object.hasOwn(node, "field") ||
      typeof node.field !== "string"
    ) {
      throw new TypeError(
        "Field predicates require a field and exactly one operator.",
      );
    }
    const field = node.field;
    if (
      field.length > 256 ||
      !/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(field)
    ) throw new TypeError(`Invalid predicate field '${field}'.`);
    const columns: Record<string, string> = {
      id: "id",
      namespace: "namespace",
      createdAt: "created_at",
      updatedAt: "updated_at",
    };
    const column = Object.hasOwn(columns, field) ? columns[field] : undefined;
    const timestamp = field === "createdAt" || field === "updatedAt";
    const json = column
      ? `to_jsonb(${column})`
      : `(data #> '{${field.split(".").join(",")}}')`;
    const text = column ?? `(data #>> '{${field.split(".").join(",")}}')`;
    const op = keys.find((key) => key !== "field")!;
    const value = node[op];
    if (op === "jsonEquals") {
      return `(COALESCE(${json} = ${
        parameter(canonicalJson(value))
      }::jsonb, FALSE))`;
    }
    values += Array.isArray(value) ? value.length : 1;
    if (values > MAX_VALUES) {
      throw new TypeError("Collection predicate exceeds its value limit.");
    }
    const equality = (raw: unknown) => {
      const value = scalar(raw);
      if (column) {
        if (value === null || typeof value !== "string") return "FALSE";
        return `COALESCE(${column} = ${parameter(value)}${
          timestamp ? "::timestamptz" : "::text"
        }, FALSE)`;
      }
      return `COALESCE(${json} = ${
        parameter(JSON.stringify(value))
      }::jsonb, FALSE)`;
    };
    if (op === "trimEq") {
      if (typeof value !== "string") {
        throw new TypeError("trimEq requires a string.");
      }
      return `(COALESCE(jsonb_typeof(${json}) = 'string' AND btrim(${text}::text, ${
        parameter(BLANK_CHARACTERS)
      }) = ${parameter(value)}, FALSE))`;
    }
    if (op === "eqIgnoreCase" || op === "inIgnoreCase") {
      if (timestamp) {
        throw new TypeError(`${op} is not supported for timestamp fields.`);
      }
      const entries = op === "eqIgnoreCase" ? [value] : value;
      if (!Array.isArray(entries) || entries.length > MAX_VALUES) {
        throw new TypeError(`${op} requires at most ${MAX_VALUES} strings.`);
      }
      for (const entry of entries) {
        if (typeof entry !== "string") {
          throw new TypeError(`${op} requires strings.`);
        }
      }
      const equality = (entry: string) =>
        column
          ? `lower(${column}::text) = lower(${parameter(entry)}::text)`
          : `jsonb_typeof(${json}) = 'string' AND lower(${text}::text) = lower(${
            parameter(entry)
          }::text)`;
      return `(COALESCE(${
        entries.map(equality).join(" OR ") || "FALSE"
      }, FALSE))`;
    }
    if (op === "eq") return `(${equality(value)})`;
    if (op === "ne") return `(NOT (${equality(value)}))`;
    if (op === "in" || op === "overlaps") {
      if (!Array.isArray(value) || value.length > MAX_VALUES) {
        throw new TypeError(
          `${op} requires at most ${MAX_VALUES} scalar values.`,
        );
      }
      for (const entry of value) scalar(entry);
      if (op === "in") {
        return `(${value.map(equality).join(" OR ") || "FALSE"})`;
      }
      const matches = value.map((entry) =>
        `${json} @> ${parameter(JSON.stringify([entry]))}::jsonb`
      ).join(" OR ") || "FALSE";
      return `(COALESCE(jsonb_typeof(${json}) = 'array' AND (${matches}), FALSE))`;
    }
    if (["exists", "isNull", "isBlank"].includes(op)) {
      if (typeof value !== "boolean") {
        throw new TypeError(`${op} requires a boolean.`);
      }
      const expression = op === "exists"
        ? `${json} IS NOT NULL`
        : op === "isNull"
        ? `COALESCE(${json} = 'null'::jsonb, FALSE)`
        : `COALESCE(jsonb_typeof(${json}) = 'string' AND btrim(${text}::text, ${
          parameter(BLANK_CHARACTERS)
        }) = '', FALSE)`;
      return `(${value ? expression : `NOT (${expression})`})`;
    }
    const comparisons: Record<string, string> = {
      lt: "<",
      lte: "<=",
      gt: ">",
      gte: ">=",
    };
    const comparison = Object.hasOwn(comparisons, op)
      ? comparisons[op]
      : undefined;
    if (!comparison) {
      throw new TypeError(`Unknown collection predicate operator '${op}'.`);
    }
    if (
      typeof value !== "string" &&
      (typeof value !== "number" || !Number.isFinite(value))
    ) {
      throw new TypeError(
        "Range predicates require a string or finite number.",
      );
    }
    if (column) {
      if (typeof value !== "string") {
        throw new TypeError(
          "Record identity and timestamp ranges require strings.",
        );
      }
      // Physical node columns are NOT NULL. Unlike nullable JSON paths, a
      // direct comparison retains two-valued semantics and lets PostgreSQL
      // use the timestamp/id keyset indexes without a COALESCE wrapper.
      return `(${column} ${comparison} ${parameter(value)}${
        timestamp ? "::timestamptz" : "::text"
      })`;
    }
    return `(COALESCE(jsonb_typeof(${json}) = '${
      typeof value === "number" ? "number" : "string"
    }' AND ${json} ${comparison} ${
      parameter(JSON.stringify(value))
    }::jsonb, FALSE))`;
  };
  return visit(input, 1);
}
