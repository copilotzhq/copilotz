import {
  createActionObligationStatements,
  createCoreTableNames,
  EVENT_SCHEMA_VERSION,
  validateCopilotzSchema,
  validateEventSchemaName,
} from "../events/schema.ts";
import type { SqlSession } from "../events/session.ts";
import {
  createOperationCatalogTables,
  OPERATION_CATALOG_FINGERPRINT,
  upgradeOperationCatalog,
  validateOperationCatalog,
} from "../streams/catalog.ts";

/** Offline lifecycle upgrade. Drain old writers before removing their wait state. */
export async function upgradeActionLifecycle(
  session: SqlSession,
  schemaName = "public",
): Promise<void> {
  const schema = validateEventSchemaName(schemaName);
  const core = createCoreTableNames(schema);
  const catalog = createOperationCatalogTables(schema);
  await session.transaction(async (transaction) => {
    const joined: SqlSession = {
      query: transaction.query,
      transaction: (run) => Promise.resolve(run(transaction)),
    };
    await transaction.query(
      "SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))",
      [schema, "copilotz-schema-provision"],
    );
    await transaction.query(
      "SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))",
      [schema, "copilotz-operation-catalog"],
    );
    await transaction.query(
      `LOCK TABLE ${core.copilotz_schema_metadata}, ${core.events}, ${core.event_bodies}, ${core.event_deliveries},
      ${catalog.metadata}, ${catalog.operations}, ${catalog.operationEvents}, ${catalog.operationStreams}
      IN ACCESS EXCLUSIVE MODE`,
    );
    const marker =
      (await transaction.query<{ version: number; fingerprint: string }>(
        `SELECT core.version, catalog.fingerprint FROM ${core.copilotz_schema_metadata} AS core
       CROSS JOIN ${catalog.metadata} AS catalog WHERE core.singleton AND catalog.singleton`,
      )).rows[0];
    if (
      Number(marker?.version) === EVENT_SCHEMA_VERSION &&
      marker?.fingerprint === OPERATION_CATALOG_FINGERPRINT
    ) {
      await validateCopilotzSchema(transaction, schema);
      await validateOperationCatalog(joined, schema);
      return;
    }
    if (![5, 6, 7].includes(Number(marker?.version))) {
      throw new Error(
        "Action lifecycle upgrade requires a v5, v6 or v7 baseline.",
      );
    }
    const outstanding = (await transaction.query<
      { deliveries: boolean; streams: boolean; operations: boolean }
    >(
      `SELECT EXISTS (SELECT 1 FROM ${core.event_deliveries} WHERE status IN ('pending','leased','retry_wait')) AS deliveries,
        EXISTS (SELECT 1 FROM ${catalog.operationStreams} WHERE state IN ('open','terminating')) AS streams,
        EXISTS (SELECT 1 FROM ${catalog.operations} WHERE state IN ('accepted','running')) AS operations`,
    )).rows[0];
    if (
      outstanding?.deliveries || outstanding?.streams || outstanding?.operations
    ) {
      throw new Error(
        "Drain existing deliveries, streams and operations on the old runtime before upgrading Action lifecycle.",
      );
    }
    if (Number(marker?.version) !== 5) {
      const open = await transaction.query(
        `SELECT 1 FROM ${core.open_actions} LIMIT 1`,
      );
      if (open.rows.length) {
        throw new Error("Drain existing Action obligations before upgrading.");
      }
      await transaction.query(`DROP TABLE ${core.open_actions}`);
    } else {
      await transaction.query(
        `ALTER TABLE ${core.event_deliveries} ADD COLUMN action_scope_id TEXT`,
      );
    }
    for (const statement of createActionObligationStatements(schema)) {
      await transaction.query(statement);
    }
    await upgradeOperationCatalog(joined, schema);
    await transaction.query(
      `UPDATE ${core.copilotz_schema_metadata} SET version = $1 WHERE singleton`,
      [EVENT_SCHEMA_VERSION],
    );
    await validateCopilotzSchema(transaction, schema);
    await validateOperationCatalog(joined, schema);
  });
}
