/** Explicit provisioning for Core's chronological Message access path. @module */
import {
  createCoreTableNames,
  quoteEventIdentifier,
  type SqlExecutor,
  validateCopilotzSchema,
  validateEventSchemaName,
} from "@copilotz/copilotz/events";

const HISTORY_INDEX = "core_message_thread_created_idx";

/**
 * Install once per schema during provisioning or an explicit migration.
 * Existing schemas can use concurrently outside a transaction. This never
 * changes Message data, visibility, or the event schema version.
 */
export async function provisionCoreHistoryIndexes(
  executor: SqlExecutor,
  schemaName = "public",
  options: Readonly<{ concurrently?: boolean }> = {},
): Promise<void> {
  const schema = validateEventSchemaName(schemaName);
  await validateCopilotzSchema(executor, schema);
  const nodes = createCoreTableNames(schema).nodes;
  // The leading namespace/type keys also work with generic prepared plans;
  // a partial type='message' index cannot prove a parameterized type condition.
  await executor.query(
    `CREATE INDEX ${options.concurrently ? "CONCURRENTLY " : ""}IF NOT EXISTS
       ${quoteEventIdentifier(HISTORY_INDEX)}
       ON ${nodes} (namespace, type, (data ->> 'threadId'), created_at, id)`,
  );
  const existing = await executor.query<{ valid: boolean }>(
    `SELECT (i.indisvalid AND NOT i.indisunique AND i.indpred IS NULL
             AND i.indrelid = to_regclass($2) AND i.indnkeyatts = 5
             AND am.amname = 'btree'
             AND pg_get_indexdef(i.indexrelid, 1, TRUE) = 'namespace'
             AND pg_get_indexdef(i.indexrelid, 2, TRUE) = 'type'
             AND pg_get_indexdef(i.indexrelid, 3, TRUE) = '(data ->> ''threadId''::text)'
             AND pg_get_indexdef(i.indexrelid, 4, TRUE) = 'created_at'
             AND pg_get_indexdef(i.indexrelid, 5, TRUE) = 'id') AS valid
       FROM pg_catalog.pg_index i
       JOIN pg_catalog.pg_class c ON c.oid = i.indexrelid
       JOIN pg_catalog.pg_am am ON am.oid = c.relam
      WHERE i.indexrelid = to_regclass($1)`,
    [
      `${quoteEventIdentifier(schema)}.${quoteEventIdentifier(HISTORY_INDEX)}`,
      nodes,
    ],
  );
  if (!existing.rows[0]?.valid) {
    throw new Error(
      `Core history index in '${schema}' is invalid or has an unexpected definition. Repair the index before retrying provisioning.`,
    );
  }
  // Expression statistics are essential: without ANALYZE, PostgreSQL can
  // still underestimate the thread selection and scan/sort every Message.
  await executor.query(`ANALYZE ${nodes}`);
}
