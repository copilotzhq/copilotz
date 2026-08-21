import type { EventMutationContext, SqlExecutor } from "../events/index.ts";
import type { CollectionDefinition } from "./definition.ts";
import type { CollectionEventBody, CollectionRecord } from "./types.ts";
import { ASSET_BODY_OWNER_KIND } from "../content/index.ts";
import type { AssetManifestEntry, ContentRef } from "../content/index.ts";

export type NodeRow = Record<string, unknown> & {
  id: string;
  namespace: string;
  type: string;
  name: string;
  content: string | null;
  data: unknown;
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

function bodyReferenceIds(
  definition: CollectionDefinition,
  value: Record<string, unknown>,
): readonly string[] {
  const ids = new Set<string>();
  for (const field of definition.bodyRefs?.fields ?? []) {
    const raw = value[field];
    const values = Array.isArray(raw) ? raw : [raw];
    for (const candidate of values) {
      if (typeof candidate === "string" && candidate.trim()) {
        ids.add(candidate.trim());
      }
    }
  }
  return Object.freeze([...ids]);
}

function contentRefs(value: unknown): readonly ContentRef[] {
  return Array.isArray(value) ? value as ContentRef[] : [];
}

function declaredContentAssetIds(
  definition: CollectionDefinition,
  value: Record<string, unknown>,
): readonly string[] {
  const ids = new Set<string>();
  for (const field of definition.content?.fields ?? []) {
    const raw = getPath(value, field);
    for (const ref of contentRefs(raw)) {
      if (typeof ref.assetId === "string" && ref.assetId.trim()) {
        ids.add(ref.assetId.trim());
      }
    }
  }
  return Object.freeze([...ids]);
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
  const assetIds = declaredContentAssetIds(definition, value);
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

async function projectAssetManifestEntry(
  context: EventMutationContext,
  namespace: string,
  entry: AssetManifestEntry,
): Promise<void> {
  const data = JSON.stringify({
    mediaType: entry.mediaType,
    byteLength: entry.byteLength,
    digest: entry.digest,
    state: "ready",
    bodyId: entry.bodyId,
    // Transitional runtime metadata: current Asset readers still expect a
    // location object. The event manifest remains locator-free; final BodyStore
    // readers consume bodyId directly.
    location: { kind: "database", key: entry.bodyId },
    readyAt: entry.createdAt,
    ...(entry.origin ? { origin: structuredClone(entry.origin) } : {}),
    metadata: structuredClone(entry.metadata ?? {}),
  });
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
  if (!row) {
    await context.transaction.query(
      `INSERT INTO ${context.tables.nodes} (
         id, namespace, type, name, data, source_type, source_id
       ) VALUES ($1, $2, 'asset', $3, $4::jsonb, NULL, NULL)`,
      [entry.assetId, namespace, entry.mediaType, data],
    );
  }
  await context.transaction.query(
    `INSERT INTO ${context.tables.body_references} (
       namespace, body_id, owner_kind, owner_id
     ) VALUES ($1, $2, $3, $4)
     ON CONFLICT DO NOTHING`,
    [namespace, entry.bodyId, ASSET_BODY_OWNER_KIND, entry.assetId],
  );
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

export async function synchronizeBodyReferences(
  context: EventMutationContext,
  definition: CollectionDefinition,
  namespace: string,
  ownerId: string,
  value: Record<string, unknown>,
): Promise<void> {
  if (!definition.bodyRefs?.fields.length) return;
  const bodyIds = bodyReferenceIds(definition, value);
  await context.transaction.query(
    `DELETE FROM ${context.tables.body_references}
      WHERE namespace = $1
        AND owner_kind = $2
        AND owner_id = $3
        AND NOT (body_id = ANY($4::text[]))`,
    [namespace, definition.name, ownerId, bodyIds],
  );
  for (const bodyId of bodyIds) {
    await context.transaction.query(
      `INSERT INTO ${context.tables.body_references} (
         namespace, body_id, owner_kind, owner_id
       ) VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING`,
      [namespace, bodyId, definition.name, ownerId],
    );
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
    if (definition.bodyRefs?.fields.length) {
      await context.transaction.query(
        `DELETE FROM ${context.tables.body_references}
          WHERE namespace = $1 AND owner_kind = $2 AND owner_id = $3`,
        [namespace, definition.name, id],
      );
    }
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
  const existing = await context.transaction.query<NodeRow>(
    `SELECT * FROM ${context.tables.nodes}
     WHERE namespace = $1 AND id = $2 AND type = $3 LIMIT 1`,
    [namespace, id, definition.name],
  );
  if (existing.rows[0]) {
    await context.transaction.query(
      `UPDATE ${context.tables.nodes}
       SET name = $4, content = $5, data = $6::jsonb,
           source_type = $7, source_id = $8, updated_at = NOW()
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
      ],
    );
  } else {
    await context.transaction.query(
      `INSERT INTO ${context.tables.nodes} (
         id, namespace, type, name, content, data, source_type, source_id
       ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)`,
      [
        id,
        namespace,
        definition.name,
        String(body.record.name ?? id),
        content,
        JSON.stringify(body.record),
        identity.sourceType,
        identity.sourceId,
      ],
    );
  }
  await synchronizeRelations(context, definition, namespace, id, body.record);
  await synchronizeBodyReferences(
    context,
    definition,
    namespace,
    id,
    body.record,
  );
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
