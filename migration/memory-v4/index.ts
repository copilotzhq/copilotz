/**
 * Explicit, one-way upgrade from the v3 mixed brain-node memory model to the
 * v4 semantic memory ontology. This module is intentionally excluded from the
 * normal runtime graph and must be invoked during controlled maintenance.
 */
import {
  quoteEventIdentifier,
  validateEventSchemaName,
} from "../../runtime/events/schema.ts";
import type { SqlExecutor, SqlSession } from "../../runtime/events/session.ts";
import type { MemoryForm } from "../../runtime/memory/ontology.ts";

type NodeRow = Readonly<{
  id: string;
  namespace: string;
  type: string;
  name: string;
  content: string | null;
  data: unknown;
  embedding: unknown;
  created_at: string | Date;
  updated_at: string | Date;
}>;

type KindMapping = Readonly<{
  form: MemoryForm;
  kind: string;
}>;

const KIND_MAP: Readonly<Record<string, KindMapping>> = Object.freeze({
  entity: { form: "entity", kind: "entity.concept" },
  fact: { form: "assertion", kind: "assertion.observation" },
  claim: { form: "assertion", kind: "assertion.observation" },
  decision: { form: "intent", kind: "intent.decision" },
  preference: { form: "assertion", kind: "assertion.preference" },
  task: { form: "intent", kind: "intent.action" },
  event: { form: "occurrence", kind: "occurrence.event" },
  constraint: { form: "assertion", kind: "assertion.constraint" },
  challenge: { form: "assertion", kind: "assertion.risk" },
  purpose: { form: "intent", kind: "intent.purpose" },
  desired_outcome: { form: "intent", kind: "intent.objective" },
  success_criterion: { form: "assertion", kind: "assertion.criterion" },
  decision_criterion: { form: "assertion", kind: "assertion.criterion" },
  current_state: { form: "assertion", kind: "assertion.state" },
  active_approach: { form: "intent", kind: "intent.plan" },
  risk: { form: "assertion", kind: "assertion.risk" },
  open_question: { form: "inquiry", kind: "inquiry.question" },
  next_action: { form: "intent", kind: "intent.action" },
});

const CONTINUITY_KIND: Readonly<Record<string, KindMapping>> = Object.freeze({
  "intent.challenge": { form: "assertion", kind: "assertion.risk" },
  "intent.purpose": { form: "intent", kind: "intent.purpose" },
  "intent.desiredOutcome": { form: "intent", kind: "intent.objective" },
  "intent.successCriteria": {
    form: "assertion",
    kind: "assertion.criterion",
  },
  "intent.decisionCriteria": {
    form: "assertion",
    kind: "assertion.criterion",
  },
  "intent.constraints": {
    form: "assertion",
    kind: "assertion.constraint",
  },
  "state.currentState": { form: "assertion", kind: "assertion.state" },
  "state.activeApproach": { form: "intent", kind: "intent.plan" },
  "state.risksAndBlockers": { form: "assertion", kind: "assertion.risk" },
  "state.openQuestions": { form: "inquiry", kind: "inquiry.question" },
  "state.nextActions": { form: "intent", kind: "intent.action" },
});

export type UpgradeMemoryV4SchemaResult = Readonly<{
  schema: string;
  recordsMigrated: number;
  checkpointsMigrated: number;
  relationsMigrated: number;
  alreadyUpgraded: boolean;
}>;

export type UpgradeMemoryV4SchemasOptions = Readonly<{
  schemas?: readonly string[];
}>;

function q(schema: string, table: string): string {
  return `${quoteEventIdentifier(schema)}.${quoteEventIdentifier(table)}`;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      return record(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function strings(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? [
      ...new Set(
        value.filter((item): item is string =>
          typeof item === "string" && item.trim().length > 0
        ).map((item) => item.trim()),
      ),
    ]
    : [];
}

function iso(value: string | Date): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

function mapping(kind: string): KindMapping {
  return KIND_MAP[kind] ?? {
    form: "assertion",
    kind: "assertion.lesson",
  };
}

function status(form: MemoryForm, legacy: string): string {
  const inactive = legacy === "superseded" || legacy === "archived";
  switch (form) {
    case "assertion":
      return legacy === "superseded"
        ? "superseded"
        : inactive
        ? "retracted"
        : "current";
    case "occurrence":
      return inactive ? "cancelled" : "happened";
    case "intent":
      return legacy === "superseded"
        ? "superseded"
        : inactive
        ? "cancelled"
        : "active";
    case "inquiry":
      return inactive ? "obsolete" : "open";
    case "procedure":
      return inactive ? "deprecated" : "active";
    case "entity":
      return inactive ? "archived" : "active";
  }
}

function semanticData(
  form: MemoryForm,
  legacyKind: string,
  name: string,
  content: string,
  sourceField?: string,
): Record<string, unknown> {
  const migrated = {
    legacyKind,
    legacyName: name,
    ...(sourceField ? { continuityField: sourceField } : {}),
  };
  switch (form) {
    case "entity":
      return { name, aliases: [], migrated };
    case "assertion":
      return {
        subject: { type: "legacy_context", id: sourceField ?? "conversation" },
        predicate: legacyKind,
        object: { value: content },
        migrated,
      };
    case "intent":
      return { migrated };
    case "inquiry":
      return { question: content, migrated };
    case "procedure":
      return { steps: [content], migrated };
    case "occurrence":
      return { migrated };
  }
}

function migratedRecord(row: NodeRow): Record<string, unknown> {
  const legacy = record(row.data);
  const legacyKind = text(legacy.kind) ?? "unknown";
  const target = mapping(legacyKind);
  const summary = text(legacy.content) ?? text(row.content) ??
    text(legacy.name) ?? row.name;
  const consolidationId = text(legacy.checkpointId) ??
    `legacy-memory:${row.id}`;
  const sourceMessageIds = strings(legacy.sourceMessageIds);
  const confidence = typeof legacy.confidence === "number" &&
      Number.isFinite(legacy.confidence)
    ? Math.max(0, Math.min(1, legacy.confidence))
    : undefined;
  return {
    id: row.id,
    memorySpaceId: text(legacy.memorySpaceId) ?? "legacy-memory-space",
    consolidationId,
    createdByAgentId: text(legacy.createdByAgentId) ?? "legacy-agent",
    originThreadId: text(legacy.originThreadId) ?? "legacy-thread",
    form: target.form,
    kind: target.kind,
    summary,
    content: null,
    status: status(target.form, text(legacy.status) ?? "active"),
    temporal: {
      recordedAt: iso(row.created_at),
      ...((legacy.status === "superseded" || legacy.status === "archived")
        ? { invalidatedAt: iso(row.updated_at) }
        : {}),
    },
    ...(target.form === "assertion"
      ? {
        epistemic: {
          basis: "inferred",
          stance: confidence !== undefined && confidence < 0.5
            ? "tentative"
            : "affirmed",
        },
      }
      : { epistemic: null }),
    provenance: {
      sources: sourceMessageIds.map((id) => ({ type: "message", id })),
      recordedBy: {
        type: "agent",
        id: text(legacy.createdByAgentId) ?? "legacy-agent",
      },
      consolidationId,
      ...(text(legacy.supersedesNodeId)
        ? { derivedFromMemoryIds: [text(legacy.supersedesNodeId)] }
        : {}),
    },
    data: semanticData(
      target.form,
      legacyKind,
      text(legacy.name) ?? row.name,
      summary,
      text(legacy.sourceField),
    ),
    embedding: Array.isArray(legacy.embedding)
      ? structuredClone(legacy.embedding)
      : Array.isArray(row.embedding)
      ? structuredClone(row.embedding)
      : null,
    metadata: {
      ...record(legacy.metadata),
      migratedFromMemoryV3: {
        layer: legacy.layer ?? null,
        kind: legacyKind,
        status: legacy.status ?? null,
        confidence: confidence ?? null,
        sourceField: legacy.sourceField ?? null,
      },
    },
  };
}

function continuityValues(value: unknown): readonly Readonly<{
  summary: string;
  sourceMessageIds: readonly string[];
}>[] {
  const sourced = record(value);
  const sources = strings(sourced.sourceMessageIds);
  const raw = sourced.value;
  if (typeof raw === "string" && raw.trim()) {
    return [{ summary: raw.trim(), sourceMessageIds: sources }];
  }
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) =>
    typeof item === "string" && item.trim()
      ? [{ summary: item.trim(), sourceMessageIds: sources }]
      : []
  );
}

function continuityEntries(value: unknown) {
  const continuity = record(value);
  const entries: Array<
    Readonly<{
      field: string;
      target: KindMapping;
      summary: string;
      sourceMessageIds: readonly string[];
    }>
  > = [];
  for (const section of ["intent", "state"] as const) {
    for (const [name, sourced] of Object.entries(record(continuity[section]))) {
      const field = `${section}.${name}`;
      const target = CONTINUITY_KIND[field];
      if (!target) continue;
      for (const value of continuityValues(sourced)) {
        entries.push({ field, target, ...value });
      }
    }
  }
  return entries;
}

async function insertEdge(
  transaction: SqlExecutor,
  schema: string,
  input: Readonly<{
    id: string;
    namespace: string;
    sourceId: string;
    targetId: string;
    type: string;
  }>,
): Promise<number> {
  const result = await transaction.query<{ id: string }>(
    `INSERT INTO ${q(schema, "edges")} (
       id, namespace, source_node_id, target_node_id, type, data, weight
     ) VALUES ($1, $2, $3, $4, $5, '{}'::jsonb, 1)
     ON CONFLICT (id) DO NOTHING RETURNING id`,
    [
      input.id,
      input.namespace,
      input.sourceId,
      input.targetId,
      input.type,
    ],
  );
  return result.rows.length;
}

async function migrateContinuity(
  transaction: SqlExecutor,
  schema: string,
  checkpoint: NodeRow,
  existingFields: ReadonlySet<string>,
): Promise<Readonly<{ records: number; relations: number }>> {
  const data = record(checkpoint.data);
  const metadata = record(data.metadata);
  const entries = continuityEntries(metadata.continuity).filter((entry) =>
    !existingFields.has(`${checkpoint.id}\0${entry.field}`)
  );
  let records = 0;
  let relations = 0;
  for (const [index, entry] of entries.entries()) {
    const id = `${checkpoint.id}:continuity:${
      encodeURIComponent(entry.field)
    }:${index}`;
    const consolidationId = checkpoint.id;
    const memorySpaceId = text(data.defaultWriteMemorySpaceId) ??
      text(data.memorySpaceId) ?? "legacy-memory-space";
    const agentId = text(data.agentId) ?? "legacy-agent";
    const threadId = text(data.threadId) ?? "legacy-thread";
    const semantic = {
      id,
      memorySpaceId,
      consolidationId,
      createdByAgentId: agentId,
      originThreadId: threadId,
      form: entry.target.form,
      kind: entry.target.kind,
      summary: entry.summary,
      content: null,
      status: status(entry.target.form, "active"),
      temporal: { recordedAt: iso(checkpoint.created_at) },
      ...(entry.target.form === "assertion"
        ? {
          epistemic: { basis: "inferred", stance: "affirmed" },
        }
        : { epistemic: null }),
      provenance: {
        sources: entry.sourceMessageIds.map((sourceId) => ({
          type: "message",
          id: sourceId,
        })),
        recordedBy: { type: "agent", id: agentId },
        consolidationId,
      },
      data: semanticData(
        entry.target.form,
        entry.target.kind,
        entry.summary,
        entry.summary,
        entry.field,
      ),
      embedding: null,
      metadata: {
        migratedFromMemoryV3: {
          layer: "working",
          sourceField: entry.field,
          continuityOnly: true,
        },
      },
    };
    const inserted = await transaction.query<{ id: string }>(
      `INSERT INTO ${q(schema, "nodes")} (
         id, namespace, type, name, content, data, embedding,
         created_at, updated_at
       ) VALUES ($1, $2, 'memory_record', $3, $3, $4::jsonb, NULL,
         $5::timestamptz, $5::timestamptz)
       ON CONFLICT (id) DO NOTHING RETURNING id`,
      [
        id,
        checkpoint.namespace,
        entry.summary,
        JSON.stringify(semantic),
        iso(checkpoint.created_at),
      ],
    );
    if (!inserted.rows.length) continue;
    records++;
    relations += await insertEdge(transaction, schema, {
      id: `memory-v4-edge:${encodeURIComponent(`${memorySpaceId}:${id}`)}`,
      namespace: checkpoint.namespace,
      sourceId: memorySpaceId,
      targetId: id,
      type: "has_memory_record",
    });
    relations += await insertEdge(transaction, schema, {
      id: `memory-v4-edge:${encodeURIComponent(`${checkpoint.id}:${id}`)}`,
      namespace: checkpoint.namespace,
      sourceId: checkpoint.id,
      targetId: id,
      type: "includes_memory_record",
    });
  }
  return Object.freeze({ records, relations });
}

async function count(
  executor: SqlExecutor,
  schema: string,
  type: string,
): Promise<number> {
  const result = await executor.query<{ count: string | number }>(
    `SELECT COUNT(*) AS count FROM ${q(schema, "nodes")} WHERE type = $1`,
    [type],
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function assertNoPendingCheckpoint(
  executor: SqlExecutor,
  schema: string,
): Promise<void> {
  const result = await executor.query<{ id: string }>(
    `SELECT id FROM ${q(schema, "nodes")}
     WHERE type = 'long_term_memory' AND data ->> 'status' = 'pending'
     LIMIT 1`,
  );
  if (result.rows[0]) {
    throw new Error(
      `Memory v4 migration requires pending checkpoint '${
        result.rows[0].id
      }' to settle or be discarded.`,
    );
  }
}

/** Upgrades one already event-native physical schema in a single transaction. */
export async function upgradeMemoryV4Schema(
  session: SqlSession,
  schemaName = "public",
): Promise<UpgradeMemoryV4SchemaResult> {
  const schema = validateEventSchemaName(schemaName);
  return await session.transaction(async (transaction) => {
    // Keep the safety check in the same transaction as the rewrite so a
    // pending checkpoint can never be observed and then migrated around.
    await assertNoPendingCheckpoint(transaction, schema);
    const legacyCount = await count(transaction, schema, "brain_node");
    const legacyCheckpoints = await transaction.query<
      { count: string | number }
    >(
      `SELECT COUNT(*) AS count FROM ${q(schema, "nodes")}
       WHERE type = 'long_term_memory'
         AND COALESCE(data ->> 'schemaVersion', '') <> '4'`,
    );
    const checkpointCount = Number(legacyCheckpoints.rows[0]?.count ?? 0);
    if (legacyCount === 0 && checkpointCount === 0) {
      return Object.freeze({
        schema,
        recordsMigrated: 0,
        checkpointsMigrated: 0,
        relationsMigrated: 0,
        alreadyUpgraded: true,
      });
    }

    const rows = await transaction.query<NodeRow>(
      `SELECT id, namespace, type, name, content, data, embedding,
         created_at, updated_at
       FROM ${q(schema, "nodes")} WHERE type = 'brain_node'
       ORDER BY created_at, id`,
    );
    for (const row of rows.rows) {
      const data = migratedRecord(row);
      await transaction.query(
        `UPDATE ${q(schema, "nodes")}
         SET type = 'memory_record', name = $3, content = $4,
           data = $5::jsonb, embedding = $6::jsonb
         WHERE namespace = $1 AND id = $2 AND type = 'brain_node'`,
        [
          row.namespace,
          row.id,
          String(data.summary),
          String(data.summary),
          JSON.stringify(data),
          JSON.stringify(data.embedding),
        ],
      );
    }

    const memoryIds = rows.rows.map((row) => row.id);
    const relations = await transaction.query<{ count: string | number }>(
      `WITH changed AS (
         UPDATE ${q(schema, "edges")}
         SET type = CASE type
           WHEN 'has_brain_node' THEN 'has_memory_record'
           WHEN 'includes_brain_node' THEN 'includes_memory_record'
           WHEN 'mentions' THEN 'about'
           WHEN 'related_to' THEN 'about'
           ELSE type
         END,
         data = jsonb_set(
           jsonb_set(
             COALESCE(data, '{}'::jsonb),
             '{sourceType}',
             to_jsonb(CASE
               WHEN source_node_id = ANY($1::text[]) THEN 'memory_record'
               ELSE COALESCE(data ->> 'sourceType', 'node')
             END),
             true
           ),
           '{targetType}',
           to_jsonb(CASE
             WHEN target_node_id = ANY($1::text[]) THEN 'memory_record'
             ELSE COALESCE(data ->> 'targetType', 'node')
           END),
           true
         )
         WHERE type IN ('has_brain_node', 'includes_brain_node')
            OR (type IN ('mentions', 'related_to') AND (
              source_node_id = ANY($1::text[])
              OR target_node_id = ANY($1::text[])
            ))
         RETURNING id
       ) SELECT COUNT(*) AS count FROM changed`,
      [memoryIds],
    );

    const checkpoints = await transaction.query<NodeRow>(
      `SELECT id, namespace, type, name, content, data, embedding,
         created_at, updated_at
       FROM ${q(schema, "nodes")}
       WHERE type = 'long_term_memory'
         AND COALESCE(data ->> 'schemaVersion', '') <> '4'`,
    );
    const existingContinuityFields = new Set(
      rows.rows.flatMap((row) => {
        const data = record(row.data);
        const checkpointId = text(data.checkpointId);
        const sourceField = text(data.sourceField);
        return checkpointId && sourceField
          ? [`${checkpointId}\0${sourceField}`]
          : [];
      }),
    );
    let continuityRecords = 0;
    let continuityRelations = 0;
    for (const checkpoint of checkpoints.rows) {
      const data = record(checkpoint.data);
      const metadata = record(data.metadata);
      const continuity = metadata.continuity;
      const migrated = await migrateContinuity(
        transaction,
        schema,
        checkpoint,
        existingContinuityFields,
      );
      continuityRecords += migrated.records;
      continuityRelations += migrated.relations;
      delete metadata.continuity;
      delete metadata.continuityVersion;
      await transaction.query(
        `UPDATE ${q(schema, "nodes")}
         SET data = $3::jsonb
         WHERE namespace = $1 AND id = $2 AND type = 'long_term_memory'`,
        [
          checkpoint.namespace,
          checkpoint.id,
          JSON.stringify({
            ...data,
            schemaVersion: "4",
            strategy: "semantic_graph",
            contextSnapshotContent: data.contextSnapshotContent ?? null,
            contextSnapshot: data.contextSnapshot ?? null,
            metadata: {
              ...metadata,
              processorVersion: "v4",
              memoryOntologyVersion: "1",
              migratedFromMemoryV3: {
                continuityWasDerived: continuity !== undefined,
              },
            },
          }),
        ],
      );
    }

    return Object.freeze({
      schema,
      recordsMigrated: rows.rows.length + continuityRecords,
      checkpointsMigrated: checkpoints.rows.length,
      relationsMigrated: Number(relations.rows[0]?.count ?? 0) +
        continuityRelations,
      alreadyUpgraded: false,
    });
  });
}

/** Discovers event-native schemas that still contain v3 brain nodes. */
export async function discoverMemoryV4Schemas(
  session: SqlSession,
): Promise<readonly string[]> {
  const result = await session.query<{ table_schema: string }>(
    `SELECT DISTINCT table_schema
     FROM information_schema.tables
     WHERE table_name = 'nodes'
       AND table_schema NOT IN ('pg_catalog', 'information_schema')
       AND table_schema NOT LIKE 'pg_toast%'
     ORDER BY table_schema`,
  );
  const schemas: string[] = [];
  for (const row of result.rows) {
    const schema = validateEventSchemaName(row.table_schema);
    const legacy = await count(session, schema, "brain_node");
    if (legacy > 0) schemas.push(schema);
  }
  return Object.freeze(schemas);
}

/** Upgrades selected schemas independently. */
export async function upgradeMemoryV4Schemas(
  session: SqlSession,
  options: UpgradeMemoryV4SchemasOptions = {},
): Promise<readonly UpgradeMemoryV4SchemaResult[]> {
  const schemas = options.schemas?.map(validateEventSchemaName) ??
    await discoverMemoryV4Schemas(session);
  const results: UpgradeMemoryV4SchemaResult[] = [];
  for (const schema of schemas) {
    results.push(await upgradeMemoryV4Schema(session, schema));
  }
  return Object.freeze(results);
}
