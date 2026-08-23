import type { EventMutationContext, SqlExecutor } from "../events/index.ts";
import type { CollectionDefinition } from "./definition.ts";
import type { CollectionEventBody, CollectionRecord } from "./types.ts";
import type { AssetManifestEntry, ContentRef } from "../content/index.ts";
import { assetNodeData } from "../content/asset-node.ts";
import { sameValue } from "./equal.ts";

export type NodeRow = Record<string, unknown> & {
  id: string;
  namespace: string;
  type: string;
  name: string;
  content: string | null;
  data: unknown;
  source_type?: string | null;
  source_id?: string | null;
};

function requireText(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${name} must be non-empty.`);
  return normalized;
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

export function mapNode(row: NodeRow): CollectionRecord {
  const data = record(row.data);
  return Object.freeze({
    ...data,
    id: row.id,
    namespace: row.namespace,
  }) as CollectionRecord;
}

export function searchContent(
  definition: CollectionDefinition,
  value: Record<string, unknown>,
): string | null {
  if (!definition.search?.enabled) return null;
  const parts = definition.search.fields.map((field) => value[field]).filter(
    (item) => typeof item === "string" && item.trim(),
  );
  return parts.length ? parts.join("\n") : null;
}

export function edgeId(
  namespace: string,
  type: string,
  sourceId: string,
  targetId: string,
): string {
  return `relation:${JSON.stringify([namespace, type, sourceId, targetId])}`;
}

export function identitySource(
  definition: CollectionDefinition,
  record: Record<string, unknown>,
): Readonly<{ sourceType: string | null; sourceId: string | null }> {
  const identity = definition.identity;
  if (!identity) return { sourceType: null, sourceId: null };
  const raw = record[identity.sourceField];
  const sourceId = typeof raw === "string" && raw.trim() ? raw.trim() : null;
  if (!sourceId) return { sourceType: null, sourceId: null };
  return { sourceType: identity.sourceType, sourceId };
}

function recordTimestamp(
  definition: CollectionDefinition,
  value: Record<string, unknown>,
  timestamp: "createdAt" | "updatedAt",
): string | null {
  const field = definition.timestamps?.[timestamp] ?? timestamp;
  const raw = value[field];
  if (raw === undefined || raw === null || raw === "") return null;
  if (
    typeof raw !== "string" ||
    !raw.trim() ||
    Number.isNaN(new Date(raw).getTime())
  ) {
    throw new TypeError(
      `Collection '${definition.name}' timestamp field '${field}' must be a valid timestamp.`,
    );
  }
  return raw;
}

function relatedIds(
  value: Record<string, unknown>,
  foreignKey: string,
  relationName: string,
): string[] {
  const raw = value[foreignKey];
  if (raw === null || raw === undefined || raw === "") return [];
  const values = Array.isArray(raw) ? raw : [raw];
  return values.map((item, index) =>
    requireText(
      String(item),
      `Relation '${relationName}' foreign key${
        Array.isArray(raw) ? ` [${index}]` : ""
      }`,
    )
  );
}

async function insertRelationEdge(
  context: EventMutationContext,
  namespace: string,
  type: string,
  sourceId: string,
  targetId: string,
  relatedCollection: string,
  relatedId: string,
  relationName: string,
): Promise<void> {
  const related = await context.transaction.query<{ id: string }>(
    `SELECT id FROM ${context.tables.nodes}
     WHERE namespace = $1 AND id = $2 AND type = $3 LIMIT 1`,
    [namespace, relatedId, relatedCollection],
  );
  if (!related.rows[0]) {
    throw new Error(
      `Relation '${relationName}' references missing ${relatedCollection} '${relatedId}'.`,
    );
  }
  await context.transaction.query(
    `INSERT INTO ${context.tables.edges} (
       id, namespace, source_node_id, target_node_id, type, data, weight
     ) VALUES ($1, $2, $3, $4, $5, '{}'::jsonb, 1)
     ON CONFLICT (id) DO NOTHING`,
    [
      edgeId(namespace, type, sourceId, targetId),
      namespace,
      sourceId,
      targetId,
      type,
    ],
  );
}

export async function synchronizeRelations(
  context: EventMutationContext,
  definition: CollectionDefinition,
  namespace: string,
  selfId: string,
  value: Record<string, unknown>,
): Promise<void> {
  for (
    const [relationName, relation] of Object.entries(definition.relations ?? {})
  ) {
    const invert = relation.edge === "child-to-parent";
    const type = relation.edgeType ?? (
      relation.type === "belongsTo"
        ? `has_${definition.name}`
        : `has_${relation.collection}`
    );
    if (relation.type === "belongsTo") {
      await context.transaction.query(
        `DELETE FROM ${context.tables.edges} edge
         USING ${context.tables.nodes} related
         WHERE edge.namespace = $1
           AND edge.type = $2
           AND related.namespace = $1
           AND related.type = $3
           AND related.id = ${
          invert ? "edge.target_node_id" : "edge.source_node_id"
        }
           AND ${invert ? "edge.source_node_id" : "edge.target_node_id"} = $4`,
        [namespace, type, relation.collection, selfId],
      );
      const [parentId] = relatedIds(value, relation.foreignKey, relationName);
      if (!parentId) continue;
      await insertRelationEdge(
        context,
        namespace,
        type,
        invert ? selfId : parentId,
        invert ? parentId : selfId,
        relation.collection,
        parentId,
        relationName,
      );
      continue;
    }
    if (relation.type !== "hasMany" && relation.type !== "hasOne") continue;
    if (
      !Array.isArray(value[relation.foreignKey]) && relation.type === "hasMany"
    ) {
      continue;
    }
    if (relation.type === "hasOne" && !(relation.foreignKey in value)) continue;
    await context.transaction.query(
      `DELETE FROM ${context.tables.edges} edge
       USING ${context.tables.nodes} related
       WHERE edge.namespace = $1
         AND edge.type = $2
         AND related.namespace = $1
         AND related.type = $3
         AND related.id = ${
        invert ? "edge.source_node_id" : "edge.target_node_id"
      }
         AND ${invert ? "edge.target_node_id" : "edge.source_node_id"} = $4`,
      [namespace, type, relation.collection, selfId],
    );
    for (
      const relatedId of relatedIds(value, relation.foreignKey, relationName)
    ) {
      await insertRelationEdge(
        context,
        namespace,
        type,
        invert ? relatedId : selfId,
        invert ? selfId : relatedId,
        relation.collection,
        relatedId,
        relationName,
      );
    }
  }
}

function contentRefs(value: unknown): readonly ContentRef[] {
  return Array.isArray(value) ? value as ContentRef[] : [];
}

function declaredContentRefs(
  definition: CollectionDefinition,
  value: Record<string, unknown>,
): ReadonlyMap<string, ContentRef> {
  const refs = new Map<string, ContentRef>();
  for (const field of definition.content?.fields ?? []) {
    const raw = getPath(value, field);
    for (const ref of contentRefs(raw)) {
      if (typeof ref.assetId === "string" && ref.assetId.trim()) {
        const assetId = ref.assetId.trim();
        const existing = refs.get(assetId);
        if (existing && existing.mediaType !== ref.mediaType) {
          throw new Error(
            `Content refs for Asset '${assetId}' disagree on media type.`,
          );
        }
        refs.set(assetId, ref);
      }
    }
  }
  return refs;
}

function getPath(
  value: Record<string, unknown>,
  path: string,
): unknown {
  let current: unknown = value;
  for (const part of path.split(".").filter(Boolean)) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

async function synchronizeContentAssetEdges(
  context: EventMutationContext,
  definition: CollectionDefinition,
  namespace: string,
  ownerId: string,
  value: Record<string, unknown>,
): Promise<void> {
  if (!definition.content?.fields.length) return;
  const refs = declaredContentRefs(definition, value);
  const assetIds = [...refs.keys()].sort();
  if (assetIds.length > 0) {
    const locked = await context.transaction.query<NodeRow>(
      `SELECT * FROM ${context.tables.nodes}
       WHERE namespace = $1 AND type = 'asset' AND id = ANY($2::text[])
       ORDER BY id FOR UPDATE`,
      [namespace, assetIds],
    );
    const assets = new Map(locked.rows.map((row) => [row.id, row]));
    for (const assetId of assetIds) {
      const asset = assets.get(assetId);
      if (!asset) {
        throw new Error(
          `Declared content references missing Asset '${assetId}'.`,
        );
      }
      const data = record(asset.data);
      if (data.state !== "ready") {
        throw new Error(
          `Declared content references non-ready Asset '${assetId}'.`,
        );
      }
      const mediaType = refs.get(assetId)!.mediaType;
      if (data.mediaType !== mediaType || asset.name !== mediaType) {
        throw new Error(
          `Declared content media type does not match Asset '${assetId}'.`,
        );
      }
    }
  }
  await context.transaction.query(
    `DELETE FROM ${context.tables.edges}
      WHERE namespace = $1
        AND source_node_id = $2
        AND type = 'has_asset'
        AND NOT (target_node_id = ANY($3::text[]))`,
    [namespace, ownerId, assetIds],
  );
  for (const assetId of assetIds) {
    await context.transaction.query(
      `INSERT INTO ${context.tables.edges} (
         id, namespace, source_node_id, target_node_id, type, data, weight
       ) VALUES ($1, $2, $3, $4, 'has_asset', '{}'::jsonb, 1)
       ON CONFLICT DO NOTHING`,
      [
        edgeId(namespace, "has_asset", ownerId, assetId),
        namespace,
        ownerId,
        assetId,
      ],
    );
  }
}

export async function projectAssetManifestEntry(
  context: EventMutationContext,
  namespace: string,
  entry: AssetManifestEntry,
): Promise<void> {
  const data = JSON.stringify(assetNodeData({
    id: entry.assetId,
    namespace,
    mediaType: entry.mediaType,
    byteLength: entry.byteLength,
    digest: entry.digest,
    state: "ready",
    location: entry.location,
    ...(entry.origin ? { origin: structuredClone(entry.origin) } : {}),
    createdAt: entry.createdAt,
    readyAt: entry.readyAt ?? entry.createdAt,
    ...(entry.metadata ? { metadata: structuredClone(entry.metadata) } : {}),
  }, entry.bodyId));
  const existing = await context.transaction.query<NodeRow>(
    `SELECT * FROM ${context.tables.nodes}
     WHERE id = $1 LIMIT 1`,
    [entry.assetId],
  );
  const row = existing.rows[0];
  if (row && (row.namespace !== namespace || row.type !== "asset")) {
    throw new Error(
      `Asset manifest id conflicts with a non-Asset node: ${entry.assetId}`,
    );
  }
  const sourceType = entry.idempotencyKey ? "asset_idempotency" : null;
  const sourceId = entry.idempotencyKey ?? null;
  if (
    row &&
    (row.name !== entry.mediaType ||
      !sameValue(record(row.data), JSON.parse(data)) ||
      (row.source_type ?? null) !== sourceType ||
      (row.source_id ?? null) !== sourceId)
  ) {
    throw new Error(
      `Asset manifest conflicts with an existing Asset: ${entry.assetId}`,
    );
  }
  if (!row) {
    await context.transaction.query(
      `INSERT INTO ${context.tables.nodes} (
         id, namespace, type, name, data, source_type, source_id,
         created_at, updated_at
       ) VALUES ($1, $2, 'asset', $3, $4::jsonb, $5, $6, $7, $7)`,
      [
        entry.assetId,
        namespace,
        entry.mediaType,
        data,
        sourceType,
        sourceId,
        entry.createdAt,
      ],
    );
  }
}

async function projectAssetManifest(
  context: EventMutationContext,
  namespace: string,
  assets: readonly AssetManifestEntry[],
): Promise<void> {
  for (const entry of assets) {
    await projectAssetManifestEntry(context, namespace, entry);
  }
}

export async function projectCollectionEvent(
  context: EventMutationContext,
  definition: CollectionDefinition,
  body: CollectionEventBody<CollectionRecord>,
): Promise<CollectionRecord> {
  const namespace = body.record.namespace;
  const id = body.record.id;
  await projectAssetManifest(context, namespace, body.assets);
  if (body.operation === "delete") {
    await context.transaction.query(
      `DELETE FROM ${context.tables.edges}
       WHERE namespace = $1 AND (source_node_id = $2 OR target_node_id = $2)`,
      [namespace, id],
    );
    await context.transaction.query(
      `DELETE FROM ${context.tables.nodes}
       WHERE namespace = $1 AND id = $2 AND type = $3`,
      [namespace, id, definition.name],
    );
    return body.record;
  }
  const content = searchContent(definition, body.record);
  const identity = identitySource(definition, body.record);
  const createdAt = recordTimestamp(
    definition,
    body.record,
    "createdAt",
  );
  const updatedAt = recordTimestamp(
    definition,
    body.record,
    "updatedAt",
  );
  const existing = await context.transaction.query<NodeRow>(
    `SELECT * FROM ${context.tables.nodes}
     WHERE namespace = $1 AND id = $2 AND type = $3 LIMIT 1`,
    [namespace, id, definition.name],
  );
  if (body.operation === "create" && existing.rows[0]) {
    throw new Error(
      `Collection '${definition.name}' '${id}' already exists.`,
    );
  }
  if (body.operation === "update" && !existing.rows[0]) {
    throw new Error(`Unknown ${definition.name} '${id}'.`);
  }
  if (body.operation === "update") {
    await context.transaction.query(
      `UPDATE ${context.tables.nodes}
       SET name = $4, content = $5, data = $6::jsonb,
           source_type = $7, source_id = $8,
           created_at = COALESCE($9::timestamptz, created_at),
           updated_at = COALESCE(
             $10::timestamptz,
             $9::timestamptz,
             updated_at
           )
       WHERE namespace = $1 AND id = $2 AND type = $3`,
      [
        namespace,
        id,
        definition.name,
        String(body.record.name ?? id),
        content,
        JSON.stringify(body.record),
        identity.sourceType,
        identity.sourceId,
        createdAt,
        updatedAt,
      ],
    );
  } else {
    await context.transaction.query(
      `INSERT INTO ${context.tables.nodes} (
         id, namespace, type, name, content, data, source_type, source_id,
         created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6::jsonb, $7, $8,
         COALESCE($9::timestamptz, $10::timestamptz, NOW()),
         COALESCE($10::timestamptz, $9::timestamptz, NOW())
       )`,
      [
        id,
        namespace,
        definition.name,
        String(body.record.name ?? id),
        content,
        JSON.stringify(body.record),
        identity.sourceType,
        identity.sourceId,
        createdAt,
        updatedAt,
      ],
    );
  }
  await synchronizeRelations(context, definition, namespace, id, body.record);
  await synchronizeContentAssetEdges(
    context,
    definition,
    namespace,
    id,
    body.record,
  );
  return body.record;
}

export async function loadCollectionRecord(
  executor: SqlExecutor,
  tables: { nodes: string },
  namespace: string,
  name: string,
  id: string,
  lock = false,
): Promise<CollectionRecord | null> {
  const result = await executor.query<NodeRow>(
    `SELECT * FROM ${tables.nodes}
     WHERE namespace = $1 AND id = $2 AND type = $3
     LIMIT 1${lock ? " FOR UPDATE" : ""}`,
    [namespace, id, name],
  );
  return result.rows[0] ? mapNode(result.rows[0]) : null;
}
