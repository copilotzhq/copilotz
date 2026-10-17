/** Explicit, fresh-schema-only provisioning for one internal owner per SQL schema. */
import {
  quoteEventIdentifier,
  validateEventSchemaName,
} from "../events/schema.ts";
import type { SqlExecutor, SqlSession } from "../events/session.ts";

export type OwnerTableNames = Readonly<{
  epochs: string;
  receipts: string;
  receiptReaders: string;
  alarms: string;
  events: string;
}>;

export function ownerTableNames(schema: string): OwnerTableNames {
  const prefix = quoteEventIdentifier(schema);
  return {
    epochs: `${prefix}."owner_epochs"`,
    receipts: `${prefix}."owner_receipts"`,
    receiptReaders: `${prefix}."owner_receipt_readers"`,
    alarms: `${prefix}."owner_alarms"`,
    events: `${prefix}."events"`,
  };
}

export async function validateOwnerCommandSchema(
  tx: SqlExecutor,
  schema: string,
  ownerId?: string,
): Promise<void> {
  validateEventSchemaName(schema);
  const { rows } = await tx.query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = $1 AND table_name IN ('owner_epochs','owner_receipts','owner_receipt_readers','owner_alarms','events')`,
    [schema],
  );
  const actual = new Set(
    rows.map((row) => `${row.table_name}.${row.column_name}`),
  );
  const required = [
    "owner_epochs.owner",
    "owner_epochs.epoch",
    "owner_epochs.holder",
    "owner_epochs.last_seq",
    "owner_receipts.owner",
    "owner_receipts.worker_id",
    "owner_receipts.domain",
    "owner_receipts.key",
    "owner_receipts.kind",
    "owner_receipts.intent",
    "owner_receipts.result",
    "owner_receipt_readers.owner",
    "owner_receipt_readers.domain",
    "owner_receipt_readers.key",
    "owner_receipt_readers.worker_id",
    "owner_alarms.owner",
    "owner_alarms.name",
    "owner_alarms.due_at",
    "events.owner_id",
    "events.seq",
  ];
  const constraint = await tx.query<{ constraint_name: string }>(
    `SELECT constraint_name FROM information_schema.table_constraints
     WHERE table_schema=$1 AND table_name='events' AND constraint_name='copilotz_owner_events_required' AND constraint_type='CHECK'`,
    [schema],
  );
  const singleton = await tx.query(
    `SELECT 1 FROM pg_catalog.pg_index i
     JOIN pg_catalog.pg_class idx ON idx.oid=i.indexrelid
     JOIN pg_catalog.pg_class tab ON tab.oid=i.indrelid
     JOIN pg_catalog.pg_namespace ns ON ns.oid=tab.relnamespace
     WHERE ns.nspname=$1 AND tab.relname='owner_epochs'
       AND idx.relname='owner_epochs_single_owner_idx'
       AND i.indisunique AND i.indisvalid AND i.indpred IS NULL
       AND i.indnatts=1 AND pg_catalog.pg_get_expr(i.indexprs,i.indrelid)='true'`,
    [schema],
  );
  if (
    required.some((name) => !actual.has(name)) || !constraint.rows.length ||
    !singleton.rows.length
  ) {
    throw Object.assign(
      new Error(`Schema '${schema}' is not provisioned for owner commands.`),
      { code: "owner_schema_not_provisioned" },
    );
  }
  const keys = await tx.query<
    {
      table_name: string;
      kind: string;
      columns: string[];
      target: string | null;
      target_schema: string | null;
      target_columns: string[];
    }
  >(
    `SELECT tab.relname AS table_name, c.contype AS kind,
      ARRAY(SELECT att.attname::text FROM unnest(c.conkey) WITH ORDINALITY AS k(num,ord)
        JOIN pg_catalog.pg_attribute att ON att.attrelid=c.conrelid AND att.attnum=k.num ORDER BY k.ord) AS columns,
      target.relname AS target, targetns.nspname AS target_schema,
      ARRAY(SELECT att.attname::text FROM unnest(c.confkey) WITH ORDINALITY AS k(num,ord)
        JOIN pg_catalog.pg_attribute att ON att.attrelid=c.confrelid AND att.attnum=k.num ORDER BY k.ord) AS target_columns
     FROM pg_catalog.pg_constraint c
     JOIN pg_catalog.pg_class tab ON tab.oid=c.conrelid
     JOIN pg_catalog.pg_namespace ns ON ns.oid=tab.relnamespace
     LEFT JOIN pg_catalog.pg_class target ON target.oid=c.confrelid
     LEFT JOIN pg_catalog.pg_namespace targetns ON targetns.oid=target.relnamespace
     WHERE ns.nspname=$1 AND tab.relname IN ('owner_receipts','owner_receipt_readers') AND c.contype IN ('p','f')`,
    [schema],
  );
  const has = (table: string, kind: string, columns: string[]) =>
    keys.rows.some((row) =>
      row.table_name === table && row.kind === kind &&
      JSON.stringify(row.columns) === JSON.stringify(columns)
    );
  if (
    !has("owner_receipts", "p", ["owner", "domain", "key"]) ||
    !has("owner_receipt_readers", "p", [
      "owner",
      "domain",
      "key",
      "worker_id",
    ]) ||
    !keys.rows.some((row) =>
      row.table_name === "owner_receipt_readers" && row.kind === "f" &&
      row.target === "owner_receipts" && row.target_schema === schema &&
      JSON.stringify(row.columns) ===
        JSON.stringify(["owner", "domain", "key"]) &&
      JSON.stringify(row.target_columns) ===
        JSON.stringify(["owner", "domain", "key"])
    )
  ) {
    throw Object.assign(
      new Error(
        "Owner receipt identity schema is incompatible; use a fresh schema.",
      ),
      { code: "owner_schema_not_provisioned" },
    );
  }
  if (ownerId !== undefined) {
    const conflicting = await tx.query(
      `SELECT 1 FROM ${ownerTableNames(schema).epochs} WHERE owner<>$1 LIMIT 1`,
      [ownerId],
    );
    if (conflicting.rows.length) {
      throw Object.assign(
        new Error(
          "This internal owner schema is assigned to a different owner ID.",
        ),
        { code: "owner_schema_owner_conflict" },
      );
    }
  }
}

/**
 * Opt-in extension for an empty, already provisioned core schema. This is not a
 * migration, activation/recovery routine, or a replacement for normal v7 provisioning.
 * The existing semantic-event immutability trigger is never changed.
 * This internal slice supports exactly one owner ID per schema; multiple holders
 * may take over that same owner's epoch. Cross-owner shared event dedup is unsupported.
 */
export async function provisionOwnerCommandSchema(
  session: SqlSession,
  schema: string,
): Promise<void> {
  validateEventSchemaName(schema);
  const tables = ownerTableNames(schema);
  await session.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [
      schema,
      "copilotz-owner-schema",
    ]);
    const existing = await tx.query(`SELECT 1 FROM ${tables.events} LIMIT 1`);
    if (existing.rows.length) {
      throw Object.assign(
        new Error(
          "Owner schema provisioning requires empty events; migration is not implemented.",
        ),
        { code: "owner_schema_requires_empty_events" },
      );
    }
    await tx.query(`CREATE TABLE IF NOT EXISTS ${tables.epochs} (
      owner TEXT PRIMARY KEY, epoch BIGINT NOT NULL DEFAULT 0 CHECK(epoch >= 0),
      holder TEXT NOT NULL, last_seq BIGINT NOT NULL DEFAULT 0 CHECK(last_seq >= 0)
    )`);
    await tx.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "owner_epochs_single_owner_idx" ON ${tables.epochs}((true))`,
    );
    await tx.query(`CREATE TABLE IF NOT EXISTS ${tables.receipts} (
      owner TEXT NOT NULL REFERENCES ${tables.epochs}(owner), worker_id TEXT NOT NULL,
      domain TEXT NOT NULL CHECK(domain IN ('logical','incarnation','occurrence')),
      key TEXT NOT NULL, kind TEXT NOT NULL, intent JSONB NOT NULL, result JSONB NOT NULL,
      PRIMARY KEY(owner,domain,key)
    )`);
    await tx.query(`CREATE TABLE IF NOT EXISTS ${tables.receiptReaders} (
      owner TEXT NOT NULL, domain TEXT NOT NULL, key TEXT NOT NULL, worker_id TEXT NOT NULL,
      PRIMARY KEY(owner,domain,key,worker_id),
      FOREIGN KEY(owner,domain,key) REFERENCES ${tables.receipts}(owner,domain,key) ON DELETE CASCADE
    )`);
    await tx.query(`CREATE TABLE IF NOT EXISTS ${tables.alarms} (
      owner TEXT NOT NULL REFERENCES ${tables.epochs}(owner), name TEXT NOT NULL,
      due_at TIMESTAMPTZ NOT NULL, PRIMARY KEY(owner,name)
    )`);
    await tx.query(
      `ALTER TABLE ${tables.events} ADD COLUMN IF NOT EXISTS owner_id TEXT`,
    );
    await tx.query(
      `ALTER TABLE ${tables.events} ADD COLUMN IF NOT EXISTS seq BIGINT`,
    );
    const constraint = await tx.query<{ constraint_name: string }>(
      `SELECT constraint_name FROM information_schema.table_constraints
       WHERE table_schema=$1 AND table_name='events' AND constraint_name='copilotz_owner_events_required'`,
      [schema],
    );
    if (!constraint.rows.length) {
      await tx.query(
        `ALTER TABLE ${tables.events} ADD CONSTRAINT "copilotz_owner_events_required"
        CHECK(owner_id IS NOT NULL AND seq IS NOT NULL AND seq > 0)`,
      );
    }
    await tx.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "events_owner_seq_unique_idx" ON ${tables.events}(owner_id,seq)`,
    );
    await validateOwnerCommandSchema(tx, schema);
  });
}
