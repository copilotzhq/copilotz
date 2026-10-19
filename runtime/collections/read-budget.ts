import { createAsyncContextStorage } from "../../dependencies/async-hooks.ts";
import type { SqlExecutor } from "../events/index.ts";

/** Internal transfer bound for owner reads. This does not bound SQL scan cost. */
export type CollectionReadBudget = Readonly<{
  maxRowBytes: number;
  maxResultBytes: number;
}>;

/** Wrap an already compiled, row-limited read. Oversized values remain in SQL;
 * the driver receives null markers rather than materializing their JSON. */
export async function queryCollectionRows<Row extends Record<string, unknown>>(
  executor: SqlExecutor,
  sql: string,
  params: readonly unknown[],
  budget: CollectionReadBudget | undefined = currentCollectionReadBudget(),
  projection: Readonly<{ ordered?: boolean; sourceChecked?: boolean }> = {},
): Promise<readonly Row[]> {
  const { ordered = false, sourceChecked = false } = projection;
  if (sourceChecked && budget === undefined) {
    throw new TypeError("Source checks require a bounded read.");
  }
  if (budget === undefined) {
    return (await executor.query<Row>(sql, [...params])).rows;
  }
  if (!budget || typeof budget !== "object") {
    throw new TypeError("Invalid Collection read transfer budget.");
  }
  if (budget === currentCollectionReadBudget() && budget.maxResultBytes < 2) {
    throw new RangeError("Collection read exceeds its transfer budget.");
  }
  const { maxRowBytes, maxResultBytes } = budget;
  if (
    !Number.isSafeInteger(maxRowBytes) || maxRowBytes < 1 ||
    !Number.isSafeInteger(maxResultBytes) || maxResultBytes < 2 ||
    maxRowBytes > maxResultBytes
  ) throw new TypeError("Invalid Collection read transfer budget.");
  const parameters = [...params, maxRowBytes, maxResultBytes];
  const value = `to_jsonb(read_row)${
    ordered ? " - '__collection_read_order'" : ""
  }${sourceChecked ? " - '__collection_source_rejected'" : ""} AS value`;
  const rows = (await executor.query<{
    bounded_value: Row | null;
    oversized: boolean;
    source_rejected?: boolean;
  }>(
    `SELECT CASE WHEN oversized${
      sourceChecked ? " OR source_rejected" : ""
    } THEN NULL ELSE value END AS bounded_value,
            oversized${sourceChecked ? ", source_rejected" : ""}
       FROM (
         SELECT value${ordered ? ", ordinal" : ""}${
      sourceChecked ? ", source_rejected" : ""
    },
                (octet_length(value::text) > $${params.length + 1}
                 OR 2 + SUM(octet_length(value::text) + 1) OVER ()
                    > $${params.length + 2}) AS oversized
           FROM (
             SELECT ${value}${
      ordered ? ", read_row.__collection_read_order AS ordinal" : ""
    }${
      sourceChecked
        ? ", read_row.__collection_source_rejected AS source_rejected"
        : ""
    }
               FROM (${sql}) AS read_row
           ) AS encoded
       ) AS bounded${ordered ? " ORDER BY ordinal" : ""} LIMIT 10001`,
    parameters,
  )).rows;
  if (rows.length > 10000) {
    throw new RangeError("Collection read exceeds its row capacity.");
  }
  if (rows.some((row) => row.source_rejected === true)) {
    throw new TypeError(
      "Collection read source contains unsupported protected data.",
    );
  }
  if (rows.some((row) => row.oversized || row.bounded_value === null)) {
    throw new RangeError("Collection read exceeds its transfer budget.");
  }
  const values = rows.map((row) => row.bounded_value!);
  if (budget === currentCollectionReadBudget()) {
    const mutable = budget as { maxRowBytes: number; maxResultBytes: number };
    mutable.maxResultBytes -=
      new TextEncoder().encode(JSON.stringify(values)).length;
    mutable.maxRowBytes = Math.min(
      mutable.maxRowBytes,
      Math.max(1, mutable.maxResultBytes),
    );
    if (mutable.maxResultBytes < 0) {
      throw new RangeError("Collection read exceeds its transfer budget.");
    }
  }
  return values;
}

const budgets = createAsyncContextStorage<CollectionReadBudget | undefined>();
export function currentCollectionReadBudget() {
  return budgets.getStore();
}
export function withCollectionReadBudget<T>(
  execute: () => Promise<T>,
): Promise<T> {
  return budgets.run(
    { maxRowBytes: 256 * 1024, maxResultBytes: 512 * 1024 },
    execute,
  );
}

/** Rebind this command's exact remaining allowance; never replenish on enqueue. */
export function withCollectionReadBudgetBinding<T>(
  budget: CollectionReadBudget | undefined,
  execute: () => T | Promise<T>,
): Promise<T> {
  return budgets.run(budget, execute);
}
