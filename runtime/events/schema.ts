import {
  CONTENT_CATALOG_COLUMNS,
  contentCatalogStatements,
} from "../content/catalog-schema.ts";
import type { SqlExecutor, SqlSession } from "./session.ts";

export const EVENT_SCHEMA_VERSION = 11;

export type CoreTableName =
  | "action_effects"
  | keyof typeof CONTENT_CATALOG_COLUMNS
  | "owner_epochs"
  | "owner_receipts"
  | "owner_alarms"
  | "owner_deadlines"
  | "owner_body_retirements"
  | "nodes"
  | "edges"
  | "events"
  | "event_bodies"
  | "open_actions"
  | "event_deliveries"
  | "copilotz_schema_metadata";

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
  return ({
    action_effects: table("action_effects"),
    content_logical_bodies: table("content_logical_bodies"),
    content_copies: table("content_copies"),
    pending_content: table("pending_content"),
    content_adoptions: table("content_adoptions"),
    owner_epochs: table("owner_epochs"),
    owner_receipts: table("owner_receipts"),
    owner_alarms: table("owner_alarms"),
    owner_deadlines: table("owner_deadlines"),
    owner_body_retirements: table("owner_body_retirements"),
    nodes: table("nodes"),
    edges: table("edges"),
    events: table("events"),
    event_bodies: table("event_bodies"),
    event_deliveries: table("event_deliveries"),
    open_actions: table("open_actions"),
    copilotz_schema_metadata: table("copilotz_schema_metadata"),
  } as const);
}

const CORE_SCHEMA_COLUMNS = {
  action_effects: [
    "namespace",
    "action_run_id",
    "step",
    "status",
    "outcome",
    "evidence",
  ],
  ...CONTENT_CATALOG_COLUMNS,
  owner_epochs: ["owner", "epoch", "holder", "last_seq"],
  owner_receipts: [
    "owner",
    "domain",
    "key",
    "principal",
    "readers",
    "kind",
    "intent",
    "result",
  ],
  owner_alarms: ["owner", "name", "due_at"],
  owner_deadlines: [
    "owner",
    "source",
    "key",
    "namespace",
    "due_at",
    "payload",
    "revision",
  ],
  owner_body_retirements: [
    "owner",
    "backend_kind",
    "backend_id",
    "body_id",
    "token",
    "completed",
  ],
  nodes: [
    "id",
    "namespace",
    "type",
    "name",
    "content",
    "data",
    "source_type",
    "source_id",
    "created_at",
    "updated_at",
  ] as const,
  edges: [
    "id",
    "namespace",
    "source_node_id",
    "target_node_id",
    "type",
    "data",
    "weight",
    "created_at",
  ] as const,
  events: [
    "position",
    "seq",
    "id",
    "schema_version",
    "type",
    "namespace",
    "subject_type",
    "subject_id",
    "payload",
    "delta",
    "metadata",
    "owner_ingress",
    "causation_id",
    "correlation_id",
    "deduplication_id",
    "created_at",
  ] as const,
  event_bodies: [
    "namespace",
    "event_body_id",
    "schema_version",
    "body",
    "digest",
    "created_at",
  ] as const,
  open_actions: [
    "namespace",
    "action_run_id",
    "action_id",
    "scope_id",
    "invoked_event_id",
    "state",
    "owner_delivery_id",
    "action_scope_id",
    "await_event_id",
    "child_operation_id",
  ],
  event_deliveries: [
    "id",
    "event_id",
    "consumer_id",
    "settlement_scope_id",
    "action_scope_id",
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
  ] as const,
  copilotz_schema_metadata: ["singleton", "version"] as const,
} satisfies Readonly<Record<CoreTableName, readonly string[]>>;

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
        AND table_name IN (
          'action_effects',
          'content_logical_bodies', 'content_copies', 'pending_content', 'content_adoptions',
          'owner_epochs', 'owner_receipts', 'owner_alarms', 'owner_deadlines', 'owner_body_retirements',
          'nodes',
          'edges',
          'events',
          'event_bodies',
          'event_deliveries',
          'open_actions',
          'copilotz_schema_metadata'
        )`,
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
      }. Provision a fresh schema before serving requests.`,
    );
    Object.assign(error, {
      name: "CopilotzSchemaError",
      code: "copilotz_schema_not_provisioned",
      schema,
      version: EVENT_SCHEMA_VERSION,
      missing: missing,
    });
    throw error;
  }
  const marker = await executor.query<{ version: string | number }>(
    `SELECT version FROM ${
      createCoreTableNames(schema).copilotz_schema_metadata
    }
      WHERE singleton = TRUE LIMIT 1`,
  );
  if (Number(marker.rows[0]?.version) !== EVENT_SCHEMA_VERSION) {
    const error = new Error(
      `Copilotz database schema '${schema}' is not marked as v${EVENT_SCHEMA_VERSION}. Use a fresh schema for this release.`,
    );
    Object.assign(error, {
      name: "CopilotzSchemaError",
      code: "copilotz_schema_incompatible",
      schema,
      version: EVENT_SCHEMA_VERSION,
    });
    throw error;
  }
  return ({ schema, version: EVENT_SCHEMA_VERSION } as const);
}

type SchemaClassification = "fresh" | "current" | "incompatible";

async function classifySchema(
  executor: SqlExecutor,
  schemaName: string,
): Promise<SchemaClassification> {
  const schema = validateEventSchemaName(schemaName);
  const result = await executor.query<{ table_name: string }>(
    `SELECT table_name
       FROM information_schema.tables
      WHERE table_schema = $1
        AND table_name IN (
          'nodes', 'edges', 'events', 'event_bodies', 'event_deliveries',
          'copilotz_schema_metadata'
        )`,
    [schema],
  );
  const tables = new Set(result.rows.map((row) => row.table_name));
  if (tables.size === 0) return "fresh";
  if (!tables.has("copilotz_schema_metadata")) {
    return "incompatible";
  }
  const marker = await executor.query<{ version: string | number }>(
    `SELECT version FROM ${
      createCoreTableNames(schema).copilotz_schema_metadata
    }
      WHERE singleton = TRUE LIMIT 1`,
  );
  if (Number(marker.rows[0]?.version) !== EVENT_SCHEMA_VERSION) {
    return "incompatible";
  }
  return "current";
}

function incompatibleSchema(schemaName: string): Error {
  const schema = validateEventSchemaName(schemaName);
  const error = new Error(
    `Copilotz database schema '${schema}' is incompatible with this release; run the explicit offline retained-data upgrade or provision a new schema. Existing data is never modified by provisioning.`,
  );
  Object.assign(error, {
    name: "CopilotzSchemaError",
    code: "copilotz_schema_incompatible",
    schema,
    version: EVENT_SCHEMA_VERSION,
  });
  return error;
}

/** Installs an absent schema only. Retained data requires the offline upgrade. */
export async function provisionCopilotzSchema(
  session: SqlSession,
  schemaName = "public",
): Promise<CoreSchemaValidation> {
  const schema = validateEventSchemaName(schemaName);
  const classification = await classifySchema(session, schema);
  if (classification === "current") {
    return await validateCopilotzSchema(session, schema);
  }
  if (classification === "incompatible") throw incompatibleSchema(schema);
  return await session.transaction(async (transaction) => {
    for (const statement of createCoreSchemaStatements(schema)) {
      await transaction.query(statement);
    }
    await transaction.query(
      `INSERT INTO ${createCoreTableNames(schema).copilotz_schema_metadata}
         (singleton, version) VALUES (TRUE, $1)
       ON CONFLICT (singleton) DO UPDATE SET version = EXCLUDED.version`,
      [EVENT_SCHEMA_VERSION],
    );
    return await validateCopilotzSchema(transaction, schema);
  });
}

/** Additive owner upgrade: semantic events and open obligations remain untouched. */
export function createOwnerSchemaStatements(
  schemaName: string,
): readonly string[] {
  const tables = createCoreTableNames(schemaName);
  return [
    ...createEffectSchemaStatements(schemaName),
    ...contentCatalogStatements(validateEventSchemaName(schemaName)),
    `CREATE TABLE IF NOT EXISTS ${tables.owner_epochs} (
      owner TEXT PRIMARY KEY,
      epoch BIGINT NOT NULL CHECK (epoch >= 0),
      holder TEXT NOT NULL,
      last_seq BIGINT NOT NULL DEFAULT 0 CHECK (last_seq >= 0)
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "owner_epochs_singleton_idx"
      ON ${tables.owner_epochs} ((TRUE))`,
    `CREATE TABLE IF NOT EXISTS ${tables.owner_receipts} (
      owner TEXT NOT NULL REFERENCES ${tables.owner_epochs}(owner),
      domain TEXT NOT NULL CHECK (domain IN ('logical', 'incarnation', 'occurrence')),
      key TEXT NOT NULL,
      principal TEXT NOT NULL,
      readers TEXT[] NOT NULL DEFAULT '{}',
      kind TEXT NOT NULL,
      intent JSONB NOT NULL,
      result JSONB NOT NULL,
      PRIMARY KEY (owner, domain, key)
    )`,
    `CREATE TABLE IF NOT EXISTS ${tables.owner_alarms} (
      owner TEXT NOT NULL REFERENCES ${tables.owner_epochs}(owner),
      name TEXT NOT NULL,
      due_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (owner, name)
    )`,
    `CREATE TABLE IF NOT EXISTS ${tables.owner_deadlines} (
      owner TEXT NOT NULL REFERENCES ${tables.owner_epochs}(owner),
      source TEXT NOT NULL,
      key TEXT NOT NULL,
      namespace TEXT,
      due_at TIMESTAMPTZ NOT NULL,
      payload JSONB NOT NULL DEFAULT 'null',
      revision BIGSERIAL NOT NULL,
      PRIMARY KEY (owner, source, key)
    )`,
    `CREATE INDEX IF NOT EXISTS "owner_deadlines_due_idx" ON ${tables.owner_deadlines} (owner,due_at,source,key)`,
    `INSERT INTO ${tables.owner_deadlines} (owner,source,key,due_at)
      SELECT owner,'reconciliation',name,due_at FROM ${tables.owner_alarms} WHERE name <> 'wake'
      ON CONFLICT DO NOTHING`,
    `DELETE FROM ${tables.owner_alarms} WHERE name <> 'wake'`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "owner_alarms_owner_idx" ON ${tables.owner_alarms} (owner)`,
    `CREATE TABLE IF NOT EXISTS ${tables.owner_body_retirements} (
      owner TEXT NOT NULL REFERENCES ${tables.owner_epochs}(owner),
      backend_kind TEXT NOT NULL,
      backend_id TEXT NOT NULL,
      body_id TEXT NOT NULL,
      token TEXT NOT NULL,
      completed BOOLEAN NOT NULL DEFAULT FALSE,
      PRIMARY KEY (owner, backend_kind, backend_id, body_id)
    )`,
    `INSERT INTO ${tables.owner_epochs} (owner,epoch,holder) VALUES ('schema',0,'') ON CONFLICT DO NOTHING`,
    `ALTER TABLE ${tables.event_deliveries} ADD COLUMN IF NOT EXISTS owner_epoch BIGINT NOT NULL DEFAULT 0 CHECK (owner_epoch >= 0)`,
  ];
}

/** Shared DDL for fresh provisioning and the explicit offline lifecycle upgrade. */
export function createActionObligationStatements(
  schemaName: string,
): readonly string[] {
  const tables = createCoreTableNames(schemaName);
  return [
    `CREATE TABLE IF NOT EXISTS ${tables.open_actions} (
      namespace TEXT NOT NULL,
      action_run_id TEXT NOT NULL,
      action_id TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      invoked_event_id TEXT NOT NULL REFERENCES ${tables.events}(id),
      state TEXT NOT NULL CHECK (state IN ('invoked', 'awaiting')),
      owner_delivery_id TEXT,
      action_scope_id TEXT,
      await_event_id TEXT REFERENCES ${tables.events}(id),
      child_operation_id TEXT,
      PRIMARY KEY (namespace, action_run_id)
    )`,
    `CREATE INDEX IF NOT EXISTS "event_deliveries_action_scope_idx"
      ON ${tables.event_deliveries} (settlement_scope_id, action_scope_id, status) WHERE action_scope_id IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS "open_actions_group_idx"
      ON ${tables.open_actions} (namespace, action_scope_id) WHERE action_scope_id IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS "open_actions_awaiting_idx"
      ON ${tables.open_actions} (namespace, scope_id, action_run_id) WHERE state = 'awaiting'`,
    `CREATE INDEX IF NOT EXISTS "open_actions_scope_idx"
      ON ${tables.open_actions} (namespace, scope_id)`,
    `CREATE INDEX IF NOT EXISTS "open_actions_delivery_idx"
      ON ${tables.open_actions} (owner_delivery_id) WHERE owner_delivery_id IS NOT NULL`,
  ];
}

/** Fresh runtime tables. Only atomic provisioning writes the ready marker. */
export function createCoreSchemaStatements(
  schemaName = "public",
  options: Readonly<{ marker?: boolean }> = {},
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
      source_type TEXT,
      source_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS "nodes_namespace_type_created_idx"
      ON ${tables.nodes} (namespace, type, created_at, id)`,
    `CREATE INDEX IF NOT EXISTS "nodes_namespace_source_idx"
      ON ${tables.nodes} (namespace, source_type, source_id)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "nodes_identity_unique_idx"
      ON ${tables.nodes} (namespace, type, source_type, source_id)
      WHERE source_type IS NOT NULL AND source_id IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS "nodes_ready_asset_body_idx"
      ON ${tables.nodes} (namespace, (data ->> 'bodyId'))
      WHERE type = 'asset' AND data ->> 'state' = 'ready'`,
    `CREATE INDEX IF NOT EXISTS "nodes_ready_content_body_idx"
      ON ${tables.nodes} ((data ->> 'bodyId'))
      WHERE type IN ('asset','protected_value') AND data ->> 'state' = 'ready'`,
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
    `CREATE UNIQUE INDEX IF NOT EXISTS "edges_asset_link_unique_idx"
      ON ${tables.edges} (namespace, source_node_id, target_node_id, type)
      WHERE type = 'has_asset'`,
    `CREATE TABLE IF NOT EXISTS ${tables.events} (
      position BIGSERIAL PRIMARY KEY,
      seq BIGINT NOT NULL UNIQUE CHECK (seq > 0),
      id TEXT NOT NULL UNIQUE,
      schema_version INTEGER NOT NULL,
      type TEXT NOT NULL,
      namespace TEXT NOT NULL,
      subject_type TEXT,
      subject_id TEXT,
      payload JSONB NOT NULL,
      delta JSONB,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      owner_ingress JSONB,
      causation_id TEXT,
      correlation_id TEXT NOT NULL,
      deduplication_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK ((subject_type IS NULL) = (subject_id IS NULL))
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "events_namespace_dedup_idx"
      ON ${tables.events} (namespace, deduplication_id)
      WHERE deduplication_id IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS "events_metadata_idx" ON ${tables.events} USING GIN (metadata jsonb_path_ops)`,
    `CREATE INDEX IF NOT EXISTS "events_namespace_position_idx" ON ${tables.events} (namespace, position)`,
    `CREATE INDEX IF NOT EXISTS "events_correlation_position_idx"
      ON ${tables.events} (namespace, correlation_id, position)`,
    `CREATE INDEX IF NOT EXISTS "events_causation_idx"
      ON ${tables.events} (namespace, causation_id, position)`,
    `CREATE TABLE IF NOT EXISTS ${tables.event_bodies} (
      namespace TEXT NOT NULL,
      event_body_id TEXT NOT NULL,
      schema_version INTEGER NOT NULL,
      body JSONB NOT NULL,
      digest TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (namespace, event_body_id)
    )`,
    `CREATE TABLE IF NOT EXISTS ${tables.copilotz_schema_metadata} (
      singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
      version INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS ${tables.event_deliveries} (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL REFERENCES ${tables.events}(id) ON DELETE CASCADE,
      consumer_id TEXT NOT NULL,
      settlement_scope_id TEXT NOT NULL,
      action_scope_id TEXT,
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
       SELECT delivery.id AS delivery_id,
              event.namespace,
              event.id AS ancestor_id,
              event.causation_id,
              ARRAY[event.id]::text[] AS path
       FROM ${tables.event_deliveries} AS delivery
       JOIN ${tables.events} AS event ON event.id = delivery.event_id
       WHERE delivery.settlement_scope_id IS NULL
       UNION ALL
       SELECT ancestry.delivery_id,
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
       SELECT DISTINCT ON (delivery_id) delivery_id, ancestor_id
       FROM ancestry
       ORDER BY delivery_id, cardinality(path) DESC
     )
     UPDATE ${tables.event_deliveries} AS delivery
     SET settlement_scope_id = roots.ancestor_id
     FROM roots
     WHERE delivery.id = roots.delivery_id
       AND delivery.settlement_scope_id IS NULL`,
    `UPDATE ${tables.event_deliveries}
      SET settlement_scope_id = event_id
      WHERE settlement_scope_id IS NULL`,
    `ALTER TABLE ${tables.event_deliveries}
      ALTER COLUMN settlement_scope_id SET NOT NULL`,
    ...createActionObligationStatements(schemaId),
    ...createOwnerSchemaStatements(schemaId),
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
    ...(options.marker === true
      ? [
        `INSERT INTO ${tables.copilotz_schema_metadata} (singleton, version)
          VALUES (TRUE, ${EVENT_SCHEMA_VERSION})
          ON CONFLICT (singleton) DO UPDATE SET version = EXCLUDED.version`,
      ]
      : []),
  ];
}

/** Additive v10 effect state; old invoked receipts do not acquire replay safety. */
export function createEffectSchemaStatements(
  schemaName: string,
): readonly string[] {
  const tables = createCoreTableNames(schemaName);
  return [`CREATE TABLE IF NOT EXISTS ${tables.action_effects} (
    namespace TEXT NOT NULL, action_run_id TEXT NOT NULL, step TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('begun','confirmed','not_started')),
    outcome JSONB, evidence JSONB,
    PRIMARY KEY (namespace, action_run_id, step),
    CHECK ((status='confirmed') = (outcome IS NOT NULL)),
    CHECK ((status='not_started') = (evidence IS NOT NULL))
  )`];
}

/** Number retained history in its original order before enabling owner push. */
export function createOwnerSequenceStatements(
  schemaName: string,
): readonly string[] {
  const tables = createCoreTableNames(schemaName);
  return [
    `ALTER TABLE ${tables.events} ADD COLUMN IF NOT EXISTS seq BIGINT`,
    `ALTER TABLE ${tables.events} DISABLE TRIGGER copilotz_events_immutable`,
    `WITH numbered AS (SELECT id, row_number() OVER (ORDER BY position) AS seq FROM ${tables.events})
     UPDATE ${tables.events} AS event SET seq=numbered.seq FROM numbered WHERE event.id=numbered.id`,
    `ALTER TABLE ${tables.events} ENABLE TRIGGER copilotz_events_immutable`,
    `ALTER TABLE ${tables.events} ALTER COLUMN seq SET NOT NULL`,
    `CREATE UNIQUE INDEX IF NOT EXISTS events_owner_seq_idx ON ${tables.events} (seq)`,
    `UPDATE ${tables.owner_epochs} SET last_seq=COALESCE((SELECT MAX(seq) FROM ${tables.events}),0) WHERE owner='schema'`,
  ];
}
