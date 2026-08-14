import type { SqlExecutor } from "./session.ts";

export const EVENT_SCHEMA_VERSION = 3;

export type CoreTableName =
  | "nodes"
  | "edges"
  | "events"
  | "event_deliveries";

export function validateEventSchemaName(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new TypeError(`Invalid PostgreSQL schema name '${value}'.`);
  }
  return value;
}

export function quoteEventIdentifier(value: string): string {
  return `"${validateEventSchemaName(value).replaceAll('"', '""')}"`;
}

export function createCoreTableNames(schemaName = "public"): Readonly<
  Record<CoreTableName, string>
> {
  const schema = quoteEventIdentifier(schemaName);
  const table = (name: CoreTableName) =>
    `${schema}.${quoteEventIdentifier(name)}`;
  return Object.freeze({
    nodes: table("nodes"),
    edges: table("edges"),
    events: table("events"),
    event_deliveries: table("event_deliveries"),
  });
}

const CORE_SCHEMA_COLUMNS = Object.freeze(
  {
    nodes: Object.freeze([
      "id",
      "namespace",
      "type",
      "name",
      "content",
      "data",
      "embedding",
      "source_type",
      "source_id",
      "created_at",
      "updated_at",
    ]),
    edges: Object.freeze([
      "id",
      "namespace",
      "source_node_id",
      "target_node_id",
      "type",
      "data",
      "weight",
      "created_at",
    ]),
    events: Object.freeze([
      "position",
      "id",
      "schema_version",
      "type",
      "namespace",
      "thread_id",
      "subject_type",
      "subject_id",
      "payload",
      "delta",
      "routing",
      "visibility",
      "metadata",
      "causation_id",
      "correlation_id",
      "deduplication_id",
      "created_at",
    ]),
    event_deliveries: Object.freeze([
      "id",
      "event_id",
      "consumer_id",
      "settlement_scope_id",
      "status",
      "attempts",
      "max_attempts",
      "priority",
      "available_at",
      "lease_owner",
      "lease_expires_at",
      "last_error",
      "created_at",
      "updated_at",
      "settled_at",
    ]),
  } satisfies Readonly<Record<CoreTableName, readonly string[]>>,
);

export type CoreSchemaValidation = Readonly<{
  schema: string;
  version: typeof EVENT_SCHEMA_VERSION;
}>;

/**
 * Performs a read-only structural check for the clean event-native baseline.
 * Runtime scope selection uses this path so an ordinary request never runs DDL.
 */
export async function validateCopilotzSchema(
  executor: SqlExecutor,
  schemaName = "public",
): Promise<CoreSchemaValidation> {
  const schema = validateEventSchemaName(schemaName);
  const result = await executor.query<{
    table_name: string;
    column_name: string;
  }>(
    `SELECT table_name, column_name
       FROM information_schema.columns
      WHERE table_schema = $1
        AND table_name IN ('nodes', 'edges', 'events', 'event_deliveries')`,
    [schema],
  );
  const actual = new Map<string, Set<string>>();
  for (const row of result.rows) {
    const columns = actual.get(row.table_name) ?? new Set<string>();
    columns.add(row.column_name);
    actual.set(row.table_name, columns);
  }
  const missing = Object.entries(CORE_SCHEMA_COLUMNS).flatMap(
    ([table, columns]) =>
      columns
        .filter((column) => !actual.get(table)?.has(column))
        .map((column) => `${table}.${column}`),
  );
  if (missing.length > 0) {
    const error = new Error(
      `Copilotz database schema '${schema}' is not provisioned for v${EVENT_SCHEMA_VERSION}; missing ${
        missing.join(
          ", ",
        )
      }. Run the schema provisioning or migration operation before serving requests.`,
    );
    Object.assign(error, {
      name: "CopilotzSchemaError",
      code: "copilotz_schema_not_provisioned",
      schema,
      version: EVENT_SCHEMA_VERSION,
      missing: Object.freeze(missing),
    });
    throw error;
  }
  return Object.freeze({ schema, version: EVENT_SCHEMA_VERSION });
}

/** Explicit lifecycle operation for creating or upgrading a Copilotz schema. */
export async function provisionCopilotzSchema(
  executor: SqlExecutor,
  schemaName = "public",
): Promise<CoreSchemaValidation> {
  for (const statement of createCoreSchemaStatements(schemaName)) {
    await executor.query(statement);
  }
  return await validateCopilotzSchema(executor, schemaName);
}

/** Clean v3 baseline. The v1 upgrader is deliberately isolated elsewhere. */
export function createCoreSchemaStatements(
  schemaName = "public",
): readonly string[] {
  const schemaId = validateEventSchemaName(schemaName);
  const schema = quoteEventIdentifier(schemaId);
  const tables = createCoreTableNames(schemaId);
  const immutableFunction = `${schema}."copilotz_reject_event_update"`;

  return [
    `CREATE SCHEMA IF NOT EXISTS ${schema}`,
    `CREATE TABLE IF NOT EXISTS ${tables.nodes} (
      id TEXT PRIMARY KEY,
      namespace TEXT NOT NULL,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      content TEXT,
      data JSONB,
      embedding JSONB,
      source_type TEXT,
      source_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS "nodes_namespace_type_created_idx"
      ON ${tables.nodes} (namespace, type, created_at, id)`,
    `CREATE INDEX IF NOT EXISTS "nodes_namespace_source_idx"
      ON ${tables.nodes} (namespace, source_type, source_id)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "nodes_participant_external_unique_idx"
      ON ${tables.nodes} (namespace, source_id)
      WHERE type = 'participant'
        AND source_type = 'participant_external_id'
        AND source_id IS NOT NULL`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "nodes_thread_external_unique_idx"
      ON ${tables.nodes} (namespace, source_id)
      WHERE type = 'thread'
        AND source_type = 'thread_external_id'
        AND source_id IS NOT NULL`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "nodes_asset_idempotency_unique_idx"
      ON ${tables.nodes} (namespace, source_id)
      WHERE type = 'asset'
        AND source_type = 'asset_idempotency'
        AND source_id IS NOT NULL`,
    `DROP INDEX IF EXISTS ${schema}."nodes_tool_call_unique_idx"`,
    `CREATE INDEX IF NOT EXISTS "nodes_tool_call_idx"
      ON ${tables.nodes} (namespace, source_id)
      WHERE type = 'tool_execution'
        AND source_type = 'tool_call'
        AND source_id IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS "nodes_data_gin_idx"
      ON ${tables.nodes} USING GIN (data)`,
    `CREATE TABLE IF NOT EXISTS ${tables.edges} (
      id TEXT PRIMARY KEY,
      namespace TEXT NOT NULL,
      source_node_id TEXT NOT NULL REFERENCES ${tables.nodes}(id) ON DELETE CASCADE,
      target_node_id TEXT NOT NULL REFERENCES ${tables.nodes}(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      data JSONB,
      weight DOUBLE PRECISION,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS "edges_source_type_idx"
      ON ${tables.edges} (namespace, source_node_id, type)`,
    `CREATE INDEX IF NOT EXISTS "edges_target_type_idx"
      ON ${tables.edges} (namespace, target_node_id, type)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "edges_participation_unique_idx"
      ON ${tables.edges} (namespace, source_node_id, target_node_id, type)
      WHERE type = 'participates_in'`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "edges_asset_link_unique_idx"
      ON ${tables.edges} (namespace, source_node_id, target_node_id, type)
      WHERE type = 'has_asset'`,
    `CREATE TABLE IF NOT EXISTS ${tables.events} (
      position BIGSERIAL PRIMARY KEY,
      id TEXT NOT NULL UNIQUE,
      schema_version INTEGER NOT NULL,
      type TEXT NOT NULL,
      namespace TEXT NOT NULL,
      thread_id TEXT,
      subject_type TEXT,
      subject_id TEXT,
      payload JSONB NOT NULL,
      delta JSONB,
      routing JSONB NOT NULL DEFAULT '{}'::jsonb,
      visibility JSONB NOT NULL DEFAULT '{"kind":"public"}'::jsonb,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      causation_id TEXT,
      correlation_id TEXT NOT NULL,
      deduplication_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK ((subject_type IS NULL) = (subject_id IS NULL))
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "events_namespace_dedup_idx"
      ON ${tables.events} (namespace, deduplication_id)
      WHERE deduplication_id IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS "events_thread_position_idx"
      ON ${tables.events} (namespace, thread_id, position)`,
    `CREATE INDEX IF NOT EXISTS "events_correlation_position_idx"
      ON ${tables.events} (namespace, correlation_id, position)`,
    `CREATE INDEX IF NOT EXISTS "events_causation_idx"
      ON ${tables.events} (namespace, causation_id, position)`,
    `CREATE TABLE IF NOT EXISTS ${tables.event_deliveries} (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL REFERENCES ${tables.events}(id) ON DELETE CASCADE,
      consumer_id TEXT NOT NULL,
      settlement_scope_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN (
        'pending', 'leased', 'retry_wait', 'succeeded', 'cancelled', 'dead_letter'
      )),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
      priority INTEGER NOT NULL DEFAULT 0,
      available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      lease_owner TEXT,
      lease_expires_at TIMESTAMPTZ,
      last_error JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      settled_at TIMESTAMPTZ,
      UNIQUE (event_id, consumer_id)
    )`,
    `ALTER TABLE ${tables.event_deliveries}
      ADD COLUMN IF NOT EXISTS settlement_scope_id TEXT`,
    `WITH RECURSIVE ancestry AS (
       SELECT event.id AS event_id,
              event.namespace,
              event.id AS ancestor_id,
              event.causation_id,
              ARRAY[event.id]::text[] AS path
       FROM ${tables.events} AS event
       UNION ALL
       SELECT ancestry.event_id,
              ancestry.namespace,
              parent.id AS ancestor_id,
              parent.causation_id,
              ancestry.path || parent.id
       FROM ancestry
       JOIN ${tables.events} AS parent
         ON parent.namespace = ancestry.namespace
        AND parent.id = ancestry.causation_id
       WHERE ancestry.causation_id IS NOT NULL
         AND NOT parent.id = ANY(ancestry.path)
     ), roots AS (
       SELECT DISTINCT ON (event_id) event_id, ancestor_id
       FROM ancestry
       ORDER BY event_id, cardinality(path) DESC
     )
     UPDATE ${tables.event_deliveries} AS delivery
     SET settlement_scope_id = roots.ancestor_id
     FROM roots
     WHERE delivery.event_id = roots.event_id
       AND delivery.settlement_scope_id IS NULL`,
    `UPDATE ${tables.event_deliveries}
      SET settlement_scope_id = event_id
      WHERE settlement_scope_id IS NULL`,
    `ALTER TABLE ${tables.event_deliveries}
      ALTER COLUMN settlement_scope_id SET NOT NULL`,
    `CREATE INDEX IF NOT EXISTS "deliveries_available_idx"
      ON ${tables.event_deliveries}
        (status, available_at, priority DESC, created_at, id)
      WHERE status IN ('pending', 'retry_wait', 'leased')`,
    `CREATE INDEX IF NOT EXISTS "deliveries_event_idx"
      ON ${tables.event_deliveries} (event_id)`,
    `CREATE INDEX IF NOT EXISTS "deliveries_settlement_scope_idx"
      ON ${tables.event_deliveries} (settlement_scope_id, status)`,
    `CREATE OR REPLACE FUNCTION ${immutableFunction}()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'Copilotz semantic events are immutable';
      END;
      $$ LANGUAGE plpgsql`,
    `DROP TRIGGER IF EXISTS "copilotz_events_immutable" ON ${tables.events}`,
    `CREATE TRIGGER "copilotz_events_immutable"
      BEFORE UPDATE ON ${tables.events}
      FOR EACH ROW EXECUTE FUNCTION ${immutableFunction}()`,
  ];
}
