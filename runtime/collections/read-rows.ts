import type { SqlExecutor } from "../events/index.ts";

/** Bound rows independently of capability wire limits and trusted source guards. */
export async function queryCollectionRows<Row extends Record<string, unknown>>(
  executor: SqlExecutor,
  sql: string,
  params: readonly unknown[],
  { sourceChecked = false }: Readonly<{ sourceChecked?: boolean }> = {},
): Promise<readonly Row[]> {
  // Only guarded reads need JSON projection: rejected source values must never
  // reach the driver, even when an aggregate or cursor would hide them.
  if (sourceChecked) {
    const rows = (await executor.query<{
      value: Row | null;
      source_rejected: boolean;
    }>(
      `SELECT CASE WHEN read_row.__collection_source_rejected THEN NULL
                   ELSE to_jsonb(read_row) - '__collection_source_rejected' END AS value,
               read_row.__collection_source_rejected AS source_rejected
          FROM (${sql}) AS read_row LIMIT 10001`,
      [...params],
    )).rows;
    if (rows.some((row) => row.source_rejected)) {
      throw new TypeError(
        "Collection read source contains unsupported protected data.",
      );
    }
    if (rows.length > 10000) {
      throw new RangeError("Collection read exceeds its row capacity.");
    }
    return rows.map((row) => row.value!);
  }
  const { rows } = await executor.query<Row>(
    `SELECT * FROM (${sql}) AS read_row LIMIT 10001`,
    [...params],
  );
  if (rows.length > 10000) {
    throw new RangeError("Collection read exceeds its row capacity.");
  }
  return rows;
}
