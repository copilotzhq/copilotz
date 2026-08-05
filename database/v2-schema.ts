import { defineSchema } from "omnipg";

const jsonValue = {
  anyOf: [
    { type: "object" },
    { type: "array" },
    { type: "string" },
    { type: "number" },
    { type: "boolean" },
    { type: "null" },
  ],
} as const;

/** Public four-table Copilotz v2 schema. */
export const schema: ReturnType<typeof defineSchema> = defineSchema({
  nodes: {
    schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        namespace: { type: "string" },
        type: { type: "string" },
        name: { type: "string" },
        content: { type: ["string", "null"] },
        data: { type: ["object", "null"] },
        embedding: { type: ["array", "null"], items: { type: "number" } },
        sourceType: { type: ["string", "null"] },
        sourceId: { type: ["string", "null"] },
        createdAt: { type: "string", format: "date-time" },
        updatedAt: { type: "string", format: "date-time" },
      },
      required: ["id", "namespace", "type", "name", "createdAt", "updatedAt"],
    },
    keys: [{ property: "id" }],
  },
  edges: {
    schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        namespace: { type: "string" },
        sourceNodeId: { type: "string" },
        targetNodeId: { type: "string" },
        type: { type: "string" },
        data: { type: ["object", "null"] },
        weight: { type: ["number", "null"] },
        createdAt: { type: "string", format: "date-time" },
      },
      required: [
        "id",
        "namespace",
        "sourceNodeId",
        "targetNodeId",
        "type",
        "createdAt",
      ],
    },
    keys: [{ property: "id" }],
  },
  events: {
    schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        position: { type: "string" },
        schemaVersion: { type: "integer" },
        type: { type: "string" },
        namespace: { type: "string" },
        threadId: { type: ["string", "null"] },
        subjectType: { type: ["string", "null"] },
        subjectId: { type: ["string", "null"] },
        payload: jsonValue,
        delta: jsonValue,
        routing: { type: "object" },
        visibility: { type: "object" },
        metadata: { type: "object" },
        causationId: { type: ["string", "null"] },
        correlationId: { type: "string" },
        deduplicationId: { type: ["string", "null"] },
        createdAt: { type: "string", format: "date-time" },
      },
      required: [
        "id",
        "position",
        "schemaVersion",
        "type",
        "namespace",
        "payload",
        "routing",
        "visibility",
        "metadata",
        "correlationId",
        "createdAt",
      ],
    },
    keys: [{ property: "id" }],
  },
  event_deliveries: {
    schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        eventId: { type: "string" },
        consumerId: { type: "string" },
        status: { type: "string" },
        attempts: { type: "integer" },
        maxAttempts: { type: "integer" },
        priority: { type: "integer" },
        availableAt: { type: "string", format: "date-time" },
        leaseOwner: { type: ["string", "null"] },
        leaseExpiresAt: { type: ["string", "null"], format: "date-time" },
        lastError: { type: ["object", "null"] },
        createdAt: { type: "string", format: "date-time" },
        updatedAt: { type: "string", format: "date-time" },
        settledAt: { type: ["string", "null"], format: "date-time" },
      },
      required: [
        "id",
        "eventId",
        "consumerId",
        "status",
        "attempts",
        "maxAttempts",
        "priority",
        "availableAt",
        "createdAt",
        "updatedAt",
      ],
    },
    keys: [{ property: "id" }],
  },
});

export const V2_SCHEMA_VERSION = 2;

export function v2BaselineSql(schemaName = "public"): readonly string[] {
  const schema = quoteIdentifier(schemaName);
  const table = (name: string) => `${schema}.${quoteIdentifier(name)}`;
  return [
    `CREATE SCHEMA IF NOT EXISTS ${schema}`,
    `CREATE TABLE IF NOT EXISTS ${table("nodes")} (
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
    `CREATE INDEX IF NOT EXISTS nodes_namespace_type_created_idx
      ON ${table("nodes")} (namespace, type, created_at, id)`,
    `CREATE INDEX IF NOT EXISTS nodes_namespace_source_idx
      ON ${table("nodes")} (namespace, source_type, source_id)`,
    `CREATE INDEX IF NOT EXISTS nodes_data_gin_idx
      ON ${table("nodes")} USING GIN (data)`,
    `CREATE TABLE IF NOT EXISTS ${table("edges")} (
      id TEXT PRIMARY KEY,
      namespace TEXT NOT NULL,
      source_node_id TEXT NOT NULL REFERENCES ${
      table("nodes")
    }(id) ON DELETE CASCADE,
      target_node_id TEXT NOT NULL REFERENCES ${
      table("nodes")
    }(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      data JSONB,
      weight DOUBLE PRECISION,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (namespace, source_node_id, target_node_id, type)
    )`,
    `CREATE INDEX IF NOT EXISTS edges_source_type_idx
      ON ${table("edges")} (namespace, source_node_id, type)`,
    `CREATE INDEX IF NOT EXISTS edges_target_type_idx
      ON ${table("edges")} (namespace, target_node_id, type)`,
    `CREATE TABLE IF NOT EXISTS ${table("events")} (
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
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS events_namespace_dedup_idx
      ON ${table("events")} (namespace, deduplication_id)
      WHERE deduplication_id IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS events_thread_position_idx
      ON ${table("events")} (namespace, thread_id, position)`,
    `CREATE INDEX IF NOT EXISTS events_correlation_position_idx
      ON ${table("events")} (namespace, correlation_id, position)`,
    `CREATE TABLE IF NOT EXISTS ${table("event_deliveries")} (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL REFERENCES ${
      table("events")
    }(id) ON DELETE CASCADE,
      consumer_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN (
        'pending', 'leased', 'retry_wait', 'succeeded', 'cancelled', 'dead_letter'
      )),
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
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
    `CREATE INDEX IF NOT EXISTS deliveries_available_idx
      ON ${
      table("event_deliveries")
    } (status, available_at, priority DESC, created_at)
      WHERE status IN ('pending', 'retry_wait', 'leased')`,
    `CREATE INDEX IF NOT EXISTS deliveries_event_idx
      ON ${table("event_deliveries")} (event_id)`,
  ];
}

export function validateSchemaName(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new TypeError(`Invalid PostgreSQL schema name '${value}'.`);
  }
  return value;
}

export function quoteIdentifier(value: string): string {
  return `"${validateSchemaName(value).replaceAll('"', '""')}"`;
}
