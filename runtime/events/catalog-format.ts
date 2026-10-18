/** Shared catalog marker checks. A marker is storage compatibility, not authority. */
import type { SqlExecutor } from "./session.ts";

export const OPERATION_CATALOG_FINGERPRINT = "action-obligations-v1";

/** metadataTable must be an internally quoted, schema-qualified identifier. */
export function operationCatalogFormatSql(
  metadataTable: string,
  expected = OPERATION_CATALOG_FINGERPRINT,
): string {
  return `EXISTS (SELECT 1 FROM ${metadataTable} WHERE singleton = TRUE AND fingerprint = '${
    expected.replaceAll("'", "''")
  }')`;
}

export async function assertOperationCatalogFormat(
  executor: SqlExecutor,
  metadataTable: string,
  options: Readonly<{ expected?: string; allowMissing?: boolean }> = {},
): Promise<void> {
  if (options.allowMissing) {
    const present = await executor.query<{ name: string | null }>(
      "SELECT to_regclass($1)::text AS name",
      [metadataTable],
    );
    if (!present.rows[0]?.name) return;
  }
  const result = await executor.query<{ fingerprint: string }>(
    `SELECT fingerprint FROM ${metadataTable} WHERE singleton = TRUE`,
  );
  if (
    result.rows.length !== 1 ||
    result.rows[0].fingerprint !==
      (options.expected ?? OPERATION_CATALOG_FINGERPRINT)
  ) {
    throw Object.assign(
      new Error(
        "Operation catalog format is incompatible with this entrypoint.",
      ),
      {
        code: "copilotz_operation_catalog_schema_unsupported",
      },
    );
  }
}
