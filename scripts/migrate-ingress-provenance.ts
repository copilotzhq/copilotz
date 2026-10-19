/** Offline v10 -> v11 migration. Run with all owners stopped. */
import { createCoreTableNames } from "../runtime/events/schema.ts";
import type { SqlSession } from "../runtime/events/session.ts";
import {
  durableActionMetadata,
  sameActionValue,
} from "../runtime/actions/value.ts";
import { digestContent } from "../runtime/content/digest.ts";

export function migrateIngressProvenance(
  session: SqlSession,
  schema: string,
): Promise<void> {
  const tables = createCoreTableNames(schema);
  return session.transaction(async (transaction) => {
    const version = (await transaction.query<{ version: number }>(
      `SELECT version FROM ${tables.copilotz_schema_metadata} WHERE singleton=TRUE FOR UPDATE`,
    )).rows[0]?.version;
    if (Number(version) !== 10) {
      throw new Error("Ingress migration requires schema v10.");
    }
    const receipts = (await transaction.query<{
      id: string;
      namespace: string;
      type: string;
      payload: unknown;
      metadata: unknown;
      body: unknown;
      intent: unknown;
      result: { ingress: unknown };
    }>(
      `SELECT event.id,event.namespace,event.type,event.payload,event.metadata,body.body,receipt.intent,receipt.result
      FROM ${tables.owner_receipts} receipt
      JOIN ${tables.events} event ON event.id=receipt.intent->>'eventId' AND event.namespace=receipt.intent->>'namespace'
      JOIN ${tables.event_bodies} body ON body.namespace=event.namespace AND body.event_body_id=event.payload->'dataRef'->>'eventBodyId'
      WHERE receipt.owner='schema' AND receipt.domain='logical' AND receipt.kind='owner.ingress'`,
    )).rows;
    const count = (await transaction.query<{ count: string }>(
      `SELECT count(*) AS count FROM ${tables.owner_receipts} WHERE owner='schema' AND domain='logical' AND kind='owner.ingress'`,
    )).rows[0];
    if (Number(count.count) !== receipts.length) {
      throw new Error("An ingress receipt has no retained event body.");
    }
    for (const row of receipts) {
      const binding = {
        databaseSchema: schema,
        namespace: row.namespace,
        eventId: row.id,
        digest: await digestContent(
          new TextEncoder().encode(
            JSON.stringify(
              durableActionMetadata({
                type: row.type,
                payload: row.payload,
                metadata: row.metadata ?? {},
                body: row.body,
              }),
            ),
          ),
        ),
      };
      if (!sameActionValue(binding, row.intent) || !row.result?.ingress) {
        throw new Error("Owner ingress binding is invalid.");
      }
    }
    await transaction.query(
      `ALTER TABLE ${tables.events} ADD COLUMN owner_ingress JSONB`,
    );
    await transaction.query(
      `ALTER TABLE ${tables.events} DISABLE TRIGGER copilotz_events_immutable`,
    );
    await transaction.query(
      `UPDATE ${tables.events} event SET owner_ingress=receipt.result->'ingress' FROM ${tables.owner_receipts} receipt WHERE receipt.owner='schema' AND receipt.domain='logical' AND receipt.kind='owner.ingress' AND event.id=receipt.intent->>'eventId' AND event.namespace=receipt.intent->>'namespace'`,
    );
    await transaction.query(
      `ALTER TABLE ${tables.events} ENABLE TRIGGER copilotz_events_immutable`,
    );
    await transaction.query(
      `DELETE FROM ${tables.owner_receipts} WHERE owner='schema' AND domain='logical' AND kind='owner.ingress'`,
    );
    await transaction.query(
      `UPDATE ${tables.copilotz_schema_metadata} SET version=11 WHERE singleton=TRUE`,
    );
  });
}
/** Offline migration of immutable owner ingress receipts into accepted events. */
import { openManagedOminipgDatabase } from "../runtime/persistence/ominipg.ts";
if (import.meta.main) {
  const schema = Deno.args.find((arg) => arg.startsWith("--schema="))?.slice(9);
  const url = Deno.env.get("COPILOTZ_MIGRATION_DATABASE_URL");
  if (!schema || !url || !Deno.args.includes("--apply")) {
    throw new Error(
      "Stop all owners, then set COPILOTZ_MIGRATION_DATABASE_URL and pass --schema=SCHEMA --apply.",
    );
  }
  const database = await openManagedOminipgDatabase({ url });
  try {
    await migrateIngressProvenance(database.session, schema);
  } finally {
    await database.close();
  }
}
