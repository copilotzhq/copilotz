/** Closed ordinary read wire data. No SQL, session or authority reaches callers. */
import { assertJsonValue } from "../json.ts";
import type {
  CollectionAggregateQuery,
  CollectionFilter,
  CollectionQuery,
} from "../collections/types.ts";

export const OWNER_COLLECTION_READ = "collections.read";
export type OwnerCollectionReadRequest =
  | Readonly<{ collectionAlias: string; operation: "get"; id: string }>
  | Readonly<
    { collectionAlias: string; operation: "list"; query: CollectionQuery }
  >
  | Readonly<{
    collectionAlias: string;
    operation: "aggregate";
    query: CollectionAggregateQuery;
  }>;

function invalid(): never {
  throw new TypeError("Invalid ordinary Collection read request.");
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function keys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) invalid();
}
function text(value: unknown): asserts value is string {
  if (
    typeof value !== "string" || !value || value !== value.trim() ||
    value.length > 512
  ) invalid();
}
function array(value: unknown, max: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length > max) invalid();
  return value;
}
function detached(value: unknown): unknown {
  assertJsonValue(value, { maxDepth: 32, maxNodes: 20_000 });
  if (new TextEncoder().encode(JSON.stringify(value)).length > 65_536) {
    invalid();
  }
  return structuredClone(value);
}
function filter(value: unknown): CollectionFilter {
  const data = object(value);
  keys(data, ["filter", "where", "contains", "containsAny"]);
  if (data.where !== undefined) {
    for (const [field, value] of Object.entries(object(data.where))) {
      text(field);
      // Legacy list/aggregate `where` disagree on these physical-column names.
      // The shared structured predicate has explicit, consistent semantics.
      if (["namespace", "createdAt", "updatedAt"].includes(field)) invalid();
      if (
        value !== null && typeof value !== "string" &&
        typeof value !== "number" && typeof value !== "boolean"
      ) invalid();
      if (field === "id" && typeof value !== "string") invalid();
    }
  }
  if (data.contains !== undefined) object(data.contains);
  if (data.containsAny !== undefined) {
    for (const values of Object.values(object(data.containsAny))) {
      array(values, 256);
    }
  }
  // Predicate shape/path/operator validation is shared with the actual compiler.
  return data as CollectionFilter;
}
/** A policy grants the whole ordinary record, constrained conjunctively by this
 * filter. Empty object is an explicit grant; absence is never an implicit grant. */
export function parseOwnerCollectionReadScope(
  value: unknown,
): CollectionFilter {
  return filter(detached(value));
}
export function parseOwnerCollectionReadRequest(
  value: unknown,
): OwnerCollectionReadRequest {
  const data = object(detached(value));
  text(data.collectionAlias);
  if (data.operation === "get") {
    keys(data, ["collectionAlias", "operation", "id"]);
    text(data.id);
    return data as OwnerCollectionReadRequest;
  }
  if (data.operation !== "list" && data.operation !== "aggregate") invalid();
  keys(data, ["collectionAlias", "operation", "query"]);
  const query = object(data.query);
  const aggregate = data.operation === "aggregate";
  keys(
    query,
    aggregate ? ["filter", "where", "all", "groupBy", "metrics", "limit"] : [
      "filter",
      "where",
      "contains",
      "containsAny",
      "all",
      "order",
      "after",
      "before",
      "limit",
    ],
  );
  filter(
    Object.fromEntries(
      Object.entries(query).filter(([key]) =>
        ["filter", "where", "contains", "containsAny"].includes(key)
      ),
    ),
  );
  if (query.all !== undefined) {
    for (const entry of array(query.all, 64)) filter(entry);
  }
  if (
    query.limit !== undefined &&
    (!Number.isSafeInteger(query.limit) || (query.limit as number) < 1 ||
      (query.limit as number) > 1000)
  ) invalid();
  if (aggregate) {
    const metrics = Object.entries(object(query.metrics));
    if (!metrics.length || metrics.length > 64) invalid();
    for (const [alias, metric] of metrics) {
      text(alias);
      keys(object(metric), ["op", "field", "filter"]);
    }
    if (query.groupBy !== undefined) {
      for (const group of array(query.groupBy, 8)) {
        if (typeof group === "string") text(group);
        else keys(object(group), ["field", "interval"]);
      }
    }
  } else {
    for (const key of ["after", "before"]) {
      if (query[key] !== undefined) text(query[key]);
    }
    if (query.order !== undefined) {
      const order = object(query.order);
      keys(order, ["field", "direction"]);
      text(order.field);
    }
  }
  return data as OwnerCollectionReadRequest;
}
