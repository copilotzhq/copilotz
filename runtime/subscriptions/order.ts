import { collectionField } from "../collections/field.ts";
import { compareCodePoints } from "../collections/predicate.ts";
import type { CollectionDefinition } from "../collections/definition.ts";
import type {
  CollectionQuery,
  CollectionRecord,
} from "../collections/types.ts";
import { queryRefused } from "./predicate.ts";

export type OrderTimestamps = Readonly<
  { createdAt: string; updatedAt: string }
>;
export type OrderKey = string | number | boolean | bigint | null;

/** Same schema-derived types, C text order and null placement as SQL list(). */
export function compileLiveOrder(
  definition: CollectionDefinition,
  query: CollectionQuery,
) {
  try {
    if (
      query.order !== undefined &&
      (!query.order || typeof query.order !== "object" ||
        typeof query.order.field !== "string")
    ) {
      throw new TypeError("Ordering requires a field");
    }
    const field = query.order?.field ?? "id";
    const column = collectionField(definition, field);
    const direction = query.order?.direction ?? "asc";
    if (!["asc", "desc"].includes(direction)) {
      throw new TypeError("Invalid order direction");
    }
    const factor = direction === "desc" ? -1 : 1;
    const path = field.split(".");
    return {
      key(row: CollectionRecord, timestamps?: OrderTimestamps): OrderKey {
        if (column.cast === "timestamptz") {
          const key = timestamps?.[field as keyof OrderTimestamps];
          if (key === undefined) {
            throw queryRefused("Timestamp ordering key unavailable");
          }
          return BigInt(key);
        }
        const value = path.reduce<unknown>(
          (v, key) =>
            v && typeof v === "object" && !Array.isArray(v)
              ? (v as Record<string, unknown>)[key]
              : undefined,
          row,
        );
        if (value === undefined || value === null) return null;
        const expected = column.cast === "text"
          ? "string"
          : column.cast === "numeric"
          ? "number"
          : "boolean";
        const actual = typeof value;
        if (actual !== expected) {
          throw queryRefused("Ordering requires the declared scalar type");
        }
        return value as OrderKey;
      },
      compare(a: OrderKey, b: OrderKey, aid: string, bid: string): number {
        const primary = a === b
          ? 0
          : a === null
          ? 1
          : b === null
          ? -1
          : typeof a === "string" && typeof b === "string"
          ? compareCodePoints(a, b)
          : a < b
          ? -1
          : 1;
        return (primary || compareCodePoints(aid, bid)) * factor;
      },
    };
  } catch (error) {
    throw queryRefused(
      error instanceof Error ? error.message : "Unsupported ordering",
    );
  }
}
