import type { SqlExecutor } from "../events/index.ts";
import type { CollectionDefinition } from "./definition.ts";
import { compileCollectionPredicate } from "./predicate.ts";
import type {
  CollectionAggregateQuery,
  CollectionAggregateRow,
  CollectionFilter,
} from "./types.ts";

const MAX_GROUPS = 10_000;
const DEFAULT_GROUPS = 1_000;
const PATH = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const ALIAS = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ISO_TIMESTAMP = "^[0-9]{4}-[0-9]{2}-[0-9]{2}T" +
  "[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]+)?(?:Z|[+-][0-9]{2}:[0-9]{2})$";

function path(value: unknown, label: string): string {
  if (
    typeof value !== "string" || value.length > 256 || !PATH.test(value)
  ) throw new TypeError(`${label} must be a safe record field path.`);
  return value;
}
function json(field: string): string {
  const columns: Record<string, string> = {
    id: "to_jsonb(id)",
    namespace: "to_jsonb(namespace)",
    createdAt: "to_jsonb(created_at)",
    updatedAt: "to_jsonb(updated_at)",
  };
  return Object.hasOwn(columns, field)
    ? columns[field]
    : `(data #> '{${field.split(".").join(",")}}')`;
}
function text(field: string): string {
  const columns: Record<string, string> = {
    id: "id",
    namespace: "namespace",
    createdAt: "created_at::text",
    updatedAt: "updated_at::text",
  };
  return Object.hasOwn(columns, field)
    ? columns[field]
    : `(data #>> '{${field.split(".").join(",")}}')`;
}
function numeric(field: string): string {
  return `CASE WHEN jsonb_typeof(${json(field)}) = 'number' THEN ${
    text(field)
  }::numeric END`;
}
function quoted(value: string): string {
  // Callers pass aliases already restricted to identifier characters.
  return `"${value}"`;
}
function limit(value: unknown): number {
  if (value === undefined) return DEFAULT_GROUPS;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError("Aggregate limit must be a positive safe integer.");
  }
  if (value > MAX_GROUPS) {
    throw new RangeError(
      `Aggregate limit exceeds the maximum of ${MAX_GROUPS} groups.`,
    );
  }
  return value;
}
function metricValue(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const number = typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(number) ? number : null;
}
function groupValue(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (
    typeof value === "string" || typeof value === "number" ||
    typeof value === "boolean"
  ) return value;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function appendFilter(
  input: unknown,
  filters: string[],
  params: unknown[],
): void {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Aggregate filters must be objects.");
  }
  const filter = input as Record<string, unknown>;
  for (const key of Object.keys(filter)) {
    if (!["filter", "where", "contains", "containsAny"].includes(key)) {
      throw new TypeError(`Unsupported aggregate filter '${key}'.`);
    }
  }
  if (filter.filter !== undefined) {
    filters.push(
      compileCollectionPredicate(
        filter.filter as Parameters<typeof compileCollectionPredicate>[0],
        params,
      ),
    );
  }
  for (const [field, value] of Object.entries(filter.where ?? {})) {
    const safe = path(field, "Aggregate where field");
    const index = params.push(value);
    filters.push(
      safe === "id" ? `id = $${index}` : `${text(safe)} = $${index}::text`,
    );
  }
  for (const [field, value] of Object.entries(filter.contains ?? {})) {
    const safe = path(field, "Aggregate contains field");
    filters.push(
      `(data #> '{${safe.split(".").join(",")}}') @> $${
        params.push(JSON.stringify(value))
      }::jsonb`,
    );
  }
  for (const [field, values] of Object.entries(filter.containsAny ?? {})) {
    if (!Array.isArray(values)) {
      throw new TypeError("Aggregate containsAny values must be arrays.");
    }
    const safe = path(field, "Aggregate containsAny field");
    const target = `(data #> '{${safe.split(".").join(",")}}')`;
    filters.push(
      `(${
        values.map((value) =>
          `${target} @> $${params.push(JSON.stringify([value]))}::jsonb`
        ).join(" OR ") || "FALSE"
      })`,
    );
  }
}
function bucketTimestamp(field: string): string {
  if (field === "createdAt") return "created_at";
  if (field === "updatedAt") return "updated_at";
  // The regular expression avoids casts for non-timestamp JSON values. Values
  // that look like ISO instants but contain invalid calendar data fail visibly.
  return `CASE WHEN jsonb_typeof(${json(field)}) = 'string' AND ${
    text(field)
  } ~ '${ISO_TIMESTAMP}' THEN ${text(field)}::timestamptz END`;
}

/** Executes a bounded, namespace/type-scoped aggregation without loading records. */
export async function aggregateCollectionRecords(
  executor: SqlExecutor,
  tables: { nodes: string },
  definition: CollectionDefinition,
  namespace: string,
  query: CollectionAggregateQuery,
): Promise<readonly CollectionAggregateRow[]> {
  if (!query || typeof query !== "object" || Array.isArray(query)) {
    throw new TypeError("Aggregate query must be an object.");
  }
  const entries = Object.entries(query.metrics ?? {});
  if (!entries.length || entries.length > 64) {
    throw new TypeError(
      "Aggregate metrics must contain between 1 and 64 metrics.",
    );
  }
  const params: unknown[] = [namespace, definition.name];
  const filters = ["namespace = $1", "type = $2"];
  appendFilter({ filter: query.filter, where: query.where }, filters, params);
  if (query.all !== undefined && !Array.isArray(query.all)) {
    throw new TypeError("Aggregate all must be an array.");
  }
  for (const extra of query.all ?? []) {
    appendFilter(extra as CollectionFilter, filters, params);
  }

  const select: string[] = [], grouping: string[] = [];
  const output = new Set<string>();
  const groups = query.groupBy ?? [];
  if (!Array.isArray(groups) || groups.length > 8) {
    throw new TypeError("Aggregate groupBy must contain at most 8 groups.");
  }
  for (const group of groups) {
    if (typeof group === "string") {
      const field = path(group, "Aggregate group field");
      if (output.has(field)) {
        throw new TypeError(`Duplicate aggregate output '${field}'.`);
      }
      output.add(field);
      const value = `CASE WHEN jsonb_typeof(${
        json(field)
      }) IN ('string', 'number', 'boolean') THEN ${json(field)} END`;
      select.push(`${value} AS ${quoted(field)}`);
      grouping.push(value);
      continue;
    }
    if (!group || typeof group !== "object" || Array.isArray(group)) {
      throw new TypeError(
        "Aggregate groups must be fields or time bucket descriptors.",
      );
    }
    const field = path(
      (group as { field?: unknown }).field,
      "Aggregate bucket field",
    );
    const interval = (group as { interval?: unknown }).interval;
    if (interval !== "hour" && interval !== "day" && interval !== "week") {
      throw new TypeError(
        "Aggregate bucket interval must be hour, day, or week.",
      );
    }
    if (output.has("bucket")) {
      throw new TypeError("Only one aggregate time bucket is supported.");
    }
    output.add("bucket");
    const value = `date_trunc('${interval}', ${
      bucketTimestamp(field)
    } AT TIME ZONE 'UTC')`;
    select.push(
      `to_char(${value}, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "bucket"`,
    );
    grouping.push(value);
  }
  for (const [alias, metric] of entries) {
    if (
      !ALIAS.test(alias) || new TextEncoder().encode(alias).byteLength > 63 ||
      output.has(alias)
    ) {
      throw new TypeError(
        `Invalid or duplicate aggregate metric alias '${alias}'.`,
      );
    }
    output.add(alias);
    if (!metric || typeof metric !== "object" || Array.isArray(metric)) {
      throw new TypeError(`Aggregate metric '${alias}' must be an object.`);
    }
    const op = metric.op;
    if (op !== "count" && op !== "sum" && op !== "avg") {
      throw new TypeError(
        `Aggregate metric '${alias}' has an invalid operator.`,
      );
    }
    const condition = metric.filter === undefined
      ? "TRUE"
      : compileCollectionPredicate(metric.filter, params);
    if (metric.field === undefined) {
      if (op !== "count") {
        throw new TypeError(
          `Aggregate metric '${alias}' requires a numeric field.`,
        );
      }
      select.push(`COUNT(*) FILTER (WHERE ${condition}) AS ${quoted(alias)}`);
      continue;
    }
    const value = numeric(
      path(metric.field, `Aggregate metric '${alias}' field`),
    );
    select.push(
      op === "count"
        ? `COUNT(${value}) FILTER (WHERE ${condition}) AS ${quoted(alias)}`
        : `${op.toUpperCase()}(${value}) FILTER (WHERE ${condition}) AS ${
          quoted(alias)
        }`,
    );
  }
  const capacity = limit(query.limit);
  const result = await executor.query<Record<string, unknown>>(
    `SELECT ${select.join(", ")} FROM ${tables.nodes} WHERE ${
      filters.join(" AND ")
    }${grouping.length ? ` GROUP BY ${grouping.join(", ")}` : ""} LIMIT ${
      capacity + 1
    }`,
    params,
  );
  if (result.rows.length > capacity) {
    throw new RangeError(
      `Aggregate result exceeds its ${capacity}-group capacity; narrow the query or request a larger limit.`,
    );
  }
  const metrics = new Set(entries.map(([alias]) => alias));
  return (result.rows.map((row) => (Object.fromEntries(
    Object.entries(row).map((
      [key, value],
    ) => [key, metrics.has(key) ? metricValue(value) : groupValue(value)]),
  ))));
}
