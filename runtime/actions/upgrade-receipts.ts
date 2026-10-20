/** Offline-only conversion of receipt recovery grants. Never called by requests. */
import { createCoreTableNames } from "../events/schema.ts";
import type { SqlExecutor } from "../events/session.ts";

export async function assertReceiptUpgradeAuthority(
  transaction: SqlExecutor,
  schema: string,
): Promise<void> {
  const table = createCoreTableNames(schema).owner_receipts;
  const exists = await transaction.query<{ present: boolean }>(
    "SELECT to_regclass($1) IS NOT NULL AS present",
    [table],
  );
  if (!exists.rows[0]?.present) return;
  const unresolved = await transaction.query<{ key: string }>(
    `SELECT key FROM ${table} WHERE domain='logical' AND kind='collections.commit' AND principal LIKE 'worker:%' LIMIT 1`,
  );
  if (unresolved.rows.length) {
    throw new Error(
      "Offline receipt upgrade requires a reviewed durable invocation authority mapping for worker-bound logical receipts. Keep the source schema offline and retained; do not resume these receipts under inferred authority.",
    );
  }
}

export async function upgradeReceiptReaders(
  transaction: SqlExecutor,
  schema: string,
): Promise<void> {
  await assertReceiptUpgradeAuthority(transaction, schema);
  const table = createCoreTableNames(schema).owner_receipts;
  await transaction.query(
    `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS readers TEXT[] NOT NULL DEFAULT '{}'`,
  );
  // Fixed historical principals keep their exact authority. This does not mint
  // a logical invocation or admit a replacement physical worker.
  await transaction.query(
    `UPDATE ${table} SET readers=ARRAY[principal] WHERE cardinality(readers)=0`,
  );
}
