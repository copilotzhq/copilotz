import { getPath } from "./content-path.ts";
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
  return ({
    ...data,
    id: row.id,
    namespace: row.namespace,
  } as const) as CollectionRecord;
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

function manifestNodeData(
  namespace: string,
  entry: AssetManifestEntry,
): Readonly<Record<string, unknown>> {
  return assetNodeData({
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
  }, entry.bodyId);
}

type ManifestAsset = Readonly<{
  ord: number;
  id: string;
  media_type: string;
  data: Readonly<Record<string, unknown>>;
  source_type: string | null;
  source_id: string | null;
  created_at: string;
}>;

type RelationTarget = Readonly<{
  ord: number;
  relation: string;
  related_type: string;
  related_id: string;
}>;

type RelationEdge = Readonly<{
  id: string;
  source_id: string;
  target_id: string;
  edge_type: string;
}>;

type RelationKey = Readonly<{
  edge_type: string;
  related_type: string;
  self_is_source: boolean;
}>;

type AssetLink = Readonly<{ id: string; media_type: string; edge_id: string }>;

/** The graph rows one Collection event body projects to. */
type CollectionProjection = Readonly<{
  namespace: string;
  id: string;
  type: string;
  operation: CollectionEventBody<CollectionRecord>["operation"];
  manifest: readonly ManifestAsset[];
  node?: Readonly<{
    name: string;
    content: string | null;
    data: string;
    sourceType: string | null;
    sourceId: string | null;
    createdAt: string | null;
    updatedAt: string | null;
  }>;
  targets: readonly RelationTarget[];
  keys: readonly RelationKey[];
  edges: readonly RelationEdge[];
  /** Declared content links, sorted by Asset id; absent without content. */
  assets?: readonly AssetLink[];
}>;

function manifestAssets(
  namespace: string,
  entries: readonly AssetManifestEntry[],
): readonly ManifestAsset[] {
  const byId = new Map<string, ManifestAsset>();
  entries.forEach((entry, ord) => {
    const asset: ManifestAsset = {
      ord,
      id: entry.assetId,
      media_type: entry.mediaType,
      data: manifestNodeData(namespace, entry),
      source_type: entry.idempotencyKey ? "asset_idempotency" : null,
      source_id: entry.idempotencyKey ?? null,
      created_at: entry.createdAt,
    };
    const earlier = byId.get(asset.id);
    if (!earlier) {
      byId.set(asset.id, asset);
      return;
    }
    const stored = (
      { media_type, data, source_type, source_id }: ManifestAsset,
    ) => ({
      media_type,
      data,
      source_type,
      source_id,
    });
    if (!sameValue(stored(earlier), stored(asset))) {
      throw new Error(
        `Asset manifest conflicts with an existing Asset: ${asset.id}`,
      );
    }
  });
  return [...byId.values()];
}

function collectionProjection(
  definition: CollectionDefinition,
  body: CollectionEventBody<CollectionRecord>,
): CollectionProjection {
  const namespace = body.record.namespace;
  const id = body.record.id;
  const base = {
    namespace,
    id,
    type: definition.name,
    operation: body.operation,
    manifest: manifestAssets(namespace, body.assets),
  } as const;
  if (body.operation === "delete") {
    return { ...base, targets: [], keys: [], edges: [] };
  }
  const value = body.record;
  const identity = identitySource(definition, value);
  const node = {
    name: String(value.name ?? id),
    content: searchContent(definition, value),
    data: JSON.stringify(value),
    sourceType: identity.sourceType,
    sourceId: identity.sourceId,
    createdAt: recordTimestamp(definition, value, "createdAt"),
    updatedAt: recordTimestamp(definition, value, "updatedAt"),
  } as const;

  const targets: RelationTarget[] = [];
  // Relations that share an edge type, direction, and related Collection
  // resolve to the edge set of the last one, as sequential syncing did.
  const edgeSets = new Map<
    string,
    Readonly<{ key: RelationKey; edges: readonly RelationEdge[] }>
  >();
  for (
    const [relationName, relation] of Object.entries(definition.relations ?? {})
  ) {
    const invert = relation.edge === "child-to-parent";
    const edgeType = relation.edgeType ?? (
      relation.type === "belongsTo"
        ? `has_${definition.name}`
        : `has_${relation.collection}`
    );
    let ids: readonly string[];
    let selfIsSource: boolean;
    if (relation.type === "belongsTo") {
      const [parentId] = relatedIds(value, relation.foreignKey, relationName);
      ids = parentId ? [parentId] : [];
      selfIsSource = invert;
    } else if (relation.type === "hasMany" || relation.type === "hasOne") {
      if (
        relation.type === "hasMany" &&
        !Array.isArray(value[relation.foreignKey])
      ) {
        continue;
      }
      if (relation.type === "hasOne" && !(relation.foreignKey in value)) {
        continue;
      }
      ids = relatedIds(value, relation.foreignKey, relationName);
      selfIsSource = !invert;
    } else {
      continue;
    }
    const key = {
      edge_type: edgeType,
      related_type: relation.collection,
      self_is_source: selfIsSource,
    } as const;
    const edges = new Map<string, RelationEdge>();
    for (const relatedId of ids) {
      targets.push({
        ord: targets.length,
        relation: relationName,
        related_type: relation.collection,
        related_id: relatedId,
      });
      const source = selfIsSource ? id : relatedId;
      const target = selfIsSource ? relatedId : id;
      const edge = edgeId(namespace, edgeType, source, target);
      edges.set(edge, {
        id: edge,
        source_id: source,
        target_id: target,
        edge_type: edgeType,
      });
    }
    edgeSets.set(JSON.stringify(key), { key, edges: [...edges.values()] });
  }

  const assets = definition.content?.fields.length
    ? [...declaredContentRefs(definition, value)].sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0
    ).map(([assetId, ref]) => ({
      id: assetId,
      media_type: ref.mediaType,
      edge_id: edgeId(namespace, "has_asset", id, assetId),
    }))
    : undefined;

  const edges = new Map(
    [...edgeSets.values()].flatMap((set) => set.edges).map((edge) => [
      edge.id,
      edge,
    ]),
  );
  return {
    ...base,
    node,
    targets,
    keys: [...edgeSets.values()].map((set) => set.key),
    edges: [...edges.values()],
    ...(assets ? { assets } : {}),
  };
}

/** The Collection state a mutation was planned against. */
export type ProjectionGuard = Readonly<{
  /** The planned-against record; null when it was absent. */
  expected: CollectionRecord | null;
  /** Refuses the mutation even while `expected` is still current. */
  refusal?: Error;
}>;

/** SQL that applies one Collection event body to the graph. */
export type ProjectionStatement = Readonly<{
  /** Read-and-lock CTEs the gate and report are computed from. */
  ctes: readonly string[];
  /** True when every check passes; nothing is written otherwise. */
  gate: string;
  /** Writes, each applied only when `source` yields a row. */
  effects(source: string): readonly string[];
  /** A jsonb expression describing the checks. */
  report: string;
  /** The error that explains a refused gate. */
  failure(report: unknown): Error | undefined;
}>;

type ProjectionReport = Readonly<{
  exists?: boolean;
  matches?: boolean;
  manifest?: readonly Readonly<{ ord: number; id: string; foreign: boolean }>[];
  relation?: Readonly<{
    relation: string;
    relatedType: string;
    relatedId: string;
  }>;
  assets?: readonly Readonly<{
    id: string;
    found: boolean;
    state: string | null;
  }>[];
}>;

/**
 * Composes the projection of `body` as CTEs. Checks become the gate and the
 * report instead of round trips; writes are set-based and keyed by the
 * deterministic edge ids, so an unchanged edge is left in place.
 */
export function composeCollectionProjection(
  tables: Readonly<{ nodes: string; edges: string }>,
  definition: CollectionDefinition,
  body: CollectionEventBody<CollectionRecord>,
  param: (value: unknown) => string,
  guard?: ProjectionGuard,
): ProjectionStatement {
  const projection = collectionProjection(definition, body);
  const namespace = param(projection.namespace);
  const id = param(projection.id);
  const type = param(projection.type);
  const ctes = [
    `projection_current AS (
       SELECT id, namespace, data FROM ${tables.nodes}
       WHERE namespace = ${namespace} AND id = ${id} AND type = ${type}
       LIMIT 1 FOR UPDATE
     )`,
  ];
  const gates: string[] = [];
  const reports = [`'exists', EXISTS (SELECT 1 FROM projection_current)`];
  const effects: ((source: string) => string)[] = [];

  if (guard) {
    const matches = guard.expected === null
      ? `NOT EXISTS (SELECT 1 FROM projection_current)`
      : `EXISTS (
           SELECT 1 FROM projection_current
           WHERE (CASE WHEN jsonb_typeof(data) = 'object'
                    THEN data ELSE '{}'::jsonb END)
                 || jsonb_build_object('id', id, 'namespace', namespace)
                 = ${param(JSON.stringify(guard.expected))}::jsonb
         )`;
    gates.push(matches);
    reports.push(`'matches', ${matches}`);
    if (guard.refusal) gates.push("FALSE");
  }

  if (projection.manifest.length) {
    ctes.push(
      `projection_manifest AS (
         SELECT * FROM jsonb_to_recordset(${
        param(JSON.stringify(projection.manifest))
      }::jsonb) AS asset(
           ord integer, id text, media_type text, data jsonb,
           source_type text, source_id text, created_at timestamptz
         )
       )`,
      `projection_manifest_found AS (
         SELECT asset.ord, asset.id,
                (node.namespace <> ${namespace} OR node.type <> 'asset')
                  AS foreign_node,
                (node.name <> asset.media_type
                  OR node.data IS DISTINCT FROM asset.data
                  OR node.source_type IS DISTINCT FROM asset.source_type
                  OR node.source_id IS DISTINCT FROM asset.source_id) AS differs
         FROM projection_manifest asset
         JOIN ${tables.nodes} node ON node.id = asset.id
       )`,
    );
    gates.push(
      `NOT EXISTS (
         SELECT 1 FROM projection_manifest_found WHERE foreign_node OR differs
       )`,
    );
    reports.push(
      `'manifest', (
         SELECT jsonb_agg(jsonb_build_object(
           'ord', ord, 'id', id, 'foreign', foreign_node
         ))
         FROM projection_manifest_found WHERE foreign_node OR differs
       )`,
    );
    effects.push((source) =>
      `projection_manifest_inserted AS (
         INSERT INTO ${tables.nodes} (
           id, namespace, type, name, data, source_type, source_id,
           created_at, updated_at
         )
         SELECT asset.id, ${namespace}, 'asset', asset.media_type, asset.data,
                asset.source_type, asset.source_id,
                asset.created_at, asset.created_at
         FROM projection_manifest asset, ${source}
         WHERE NOT EXISTS (
           SELECT 1 FROM projection_manifest_found found
           WHERE found.id = asset.id
         )
       )`
    );
  }

  if (projection.operation === "delete") {
    effects.push(
      (source) =>
        `projection_edges_removed AS (
           DELETE FROM ${tables.edges}
           WHERE namespace = ${namespace}
             AND (source_node_id = ${id} OR target_node_id = ${id})
             AND EXISTS (SELECT 1 FROM ${source})
         )`,
      (source) =>
        `projection_node_removed AS (
           DELETE FROM ${tables.nodes}
           WHERE namespace = ${namespace} AND id = ${id} AND type = ${type}
             AND EXISTS (SELECT 1 FROM ${source})
         )`,
    );
  }

  const node = projection.node;
  if (node) {
    if (projection.operation === "create") {
      gates.push(`NOT EXISTS (SELECT 1 FROM projection_current)`);
    }
    if (projection.operation === "update") {
      gates.push(`EXISTS (SELECT 1 FROM projection_current)`);
    }
    const name = param(node.name);
    const content = param(node.content);
    const data = param(node.data);
    const sourceType = param(node.sourceType);
    const sourceId = param(node.sourceId);
    const createdAt = param(node.createdAt);
    const updatedAt = param(node.updatedAt);
    effects.push((source) =>
      projection.operation === "update"
        ? `projection_node AS (
             UPDATE ${tables.nodes}
             SET name = ${name}, content = ${content}, data = ${data}::jsonb,
                 source_type = ${sourceType}, source_id = ${sourceId},
                 created_at = COALESCE(${createdAt}::timestamptz, created_at),
                 updated_at = COALESCE(
                   ${updatedAt}::timestamptz,
                   ${createdAt}::timestamptz,
                   updated_at
                 )
             WHERE namespace = ${namespace} AND id = ${id} AND type = ${type}
               AND EXISTS (SELECT 1 FROM ${source})
           )`
        : `projection_node AS (
             INSERT INTO ${tables.nodes} (
               id, namespace, type, name, content, data,
               source_type, source_id, created_at, updated_at
             )
             SELECT ${id}, ${namespace}, ${type}, ${name}, ${content},
                    ${data}::jsonb, ${sourceType}, ${sourceId},
                    COALESCE(
                      ${createdAt}::timestamptz, ${updatedAt}::timestamptz, NOW()
                    ),
                    COALESCE(
                      ${updatedAt}::timestamptz, ${createdAt}::timestamptz, NOW()
                    )
             FROM ${source}
           )`
    );
  }

  if (projection.targets.length) {
    // The record itself may be a relation target; it is written by this
    // statement, so its own snapshot cannot show it yet.
    ctes.push(
      `projection_related AS (
         SELECT target.*, (
           EXISTS (
             SELECT 1 FROM ${tables.nodes} node
             WHERE node.namespace = ${namespace}
               AND node.id = target.related_id
               AND node.type = target.related_type
           ) OR (target.related_id = ${id} AND target.related_type = ${type})
         ) AS present
         FROM jsonb_to_recordset(${
        param(JSON.stringify(projection.targets))
      }::jsonb) AS target(
           ord integer, relation text, related_type text, related_id text
         )
       )`,
    );
    gates.push(
      `NOT EXISTS (SELECT 1 FROM projection_related WHERE NOT present)`,
    );
    reports.push(
      `'relation', (
         SELECT jsonb_build_object(
           'relation', relation,
           'relatedType', related_type,
           'relatedId', related_id
         )
         FROM projection_related WHERE NOT present ORDER BY ord LIMIT 1
       )`,
    );
  }

  if (projection.keys.length) {
    const keys = param(JSON.stringify(projection.keys));
    const edges = param(JSON.stringify(projection.edges));
    const wanted = param(projection.edges.map((edge) => edge.id));
    effects.push(
      (source) =>
        `projection_edges_stale AS (
           DELETE FROM ${tables.edges} edge
           USING jsonb_to_recordset(${keys}::jsonb)
             AS relation(edge_type text, related_type text, self_is_source boolean),
             ${tables.nodes} related
           WHERE edge.namespace = ${namespace}
             AND (edge.source_node_id = ${id} OR edge.target_node_id = ${id})
             AND edge.type = relation.edge_type
             AND ${id} = CASE WHEN relation.self_is_source
               THEN edge.source_node_id ELSE edge.target_node_id END
             AND related.id = CASE WHEN relation.self_is_source
               THEN edge.target_node_id ELSE edge.source_node_id END
             AND related.namespace = ${namespace}
             AND related.type = relation.related_type
             AND NOT (edge.id = ANY(${wanted}::text[]))
             AND EXISTS (SELECT 1 FROM ${source})
         )`,
      (source) =>
        `projection_edges_added AS (
           INSERT INTO ${tables.edges} (
             id, namespace, source_node_id, target_node_id, type, data, weight
           )
           SELECT wanted.id, ${namespace}, wanted.source_id, wanted.target_id,
                  wanted.edge_type, '{}'::jsonb, 1
           FROM jsonb_to_recordset(${edges}::jsonb) AS wanted(
             id text, source_id text, target_id text, edge_type text
           ), ${source}
           ON CONFLICT (id) DO NOTHING
         )`,
    );
  }

  const assets = projection.assets;
  if (assets) {
    const assetIds = param(assets.map((asset) => asset.id));
    if (assets.length) {
      const links = param(JSON.stringify(assets));
      const created = projection.manifest.length
        ? `UNION ALL
           SELECT asset.id, asset.media_type, 'ready', asset.media_type
           FROM projection_manifest asset
           WHERE NOT EXISTS (
             SELECT 1 FROM projection_manifest_found found
             WHERE found.id = asset.id
           )`
        : "";
      ctes.push(
        `projection_assets AS (
           SELECT id, name, data ->> 'state' AS state,
                  data ->> 'mediaType' AS media_type
           FROM ${tables.nodes}
           WHERE namespace = ${namespace} AND type = 'asset'
             AND id = ANY(${assetIds}::text[])
           ORDER BY id FOR UPDATE
         )`,
        `projection_asset_refused AS (
           SELECT link.id, asset.id IS NOT NULL AS found, asset.state
           FROM jsonb_to_recordset(${links}::jsonb)
             AS link(id text, media_type text)
           LEFT JOIN (
             SELECT id, name, state, media_type FROM projection_assets
             ${created}
           ) asset ON asset.id = link.id
           WHERE asset.id IS NULL
              OR asset.state IS DISTINCT FROM 'ready'
              OR asset.media_type IS DISTINCT FROM link.media_type
              OR asset.name IS DISTINCT FROM link.media_type
         )`,
      );
      gates.push(`NOT EXISTS (SELECT 1 FROM projection_asset_refused)`);
      reports.push(
        `'assets', (
           SELECT jsonb_agg(jsonb_build_object(
             'id', id, 'found', found, 'state', state
           ))
           FROM projection_asset_refused
         )`,
      );
      effects.push((source) =>
        `projection_asset_edges_added AS (
           INSERT INTO ${tables.edges} (
             id, namespace, source_node_id, target_node_id, type, data, weight
           )
           SELECT link.edge_id, ${namespace}, ${id}, link.id,
                  'has_asset', '{}'::jsonb, 1
           FROM jsonb_to_recordset(${links}::jsonb)
             AS link(id text, edge_id text), ${source}
           ON CONFLICT DO NOTHING
         )`
      );
    }
    effects.push((source) =>
      `projection_asset_edges_stale AS (
         DELETE FROM ${tables.edges}
         WHERE namespace = ${namespace} AND source_node_id = ${id}
           AND type = 'has_asset'
           AND NOT (target_node_id = ANY(${assetIds}::text[]))
           AND EXISTS (SELECT 1 FROM ${source})
       )`
    );
  }

  const label = `'${projection.type}' '${projection.id}'`;
  return {
    ctes,
    gate: gates.length
      ? gates.map((gate) => `(${gate})`).join(" AND ")
      : "TRUE",
    effects: (source) => effects.map((effect) => effect(source)),
    report: `jsonb_build_object(${reports.join(", ")})`,
    failure(raw) {
      const report = record(raw) as ProjectionReport;
      if (guard) {
        if (guard.expected === null ? report.exists : !report.exists) {
          return new Error(
            guard.expected === null
              ? `Collection ${label} was created while its mutation was prepared.`
              : `Unknown ${projection.type} '${projection.id}'.`,
          );
        }
        if (guard.expected !== null && !report.matches) {
          return new Error(
            `Collection ${label} changed while its mutation was prepared.`,
          );
        }
        if (guard.refusal) return guard.refusal;
      }
      const manifest =
        [...report.manifest ?? []].sort((left, right) =>
          left.ord - right.ord
        )[0];
      if (manifest) {
        return new Error(
          manifest.foreign
            ? `Asset manifest id conflicts with a non-Asset node: ${manifest.id}`
            : `Asset manifest conflicts with an existing Asset: ${manifest.id}`,
        );
      }
      if (projection.operation === "create" && report.exists) {
        return new Error(`Collection ${label} already exists.`);
      }
      if (projection.operation === "update" && !report.exists) {
        return new Error(`Unknown ${projection.type} '${projection.id}'.`);
      }
      if (report.relation) {
        return new Error(
          `Relation '${report.relation.relation}' references missing ${report.relation.relatedType} '${report.relation.relatedId}'.`,
        );
      }
      const refused = new Map(
        (report.assets ?? []).map((asset) => [asset.id, asset]),
      );
      const asset = assets?.map((link) => refused.get(link.id)).find(Boolean);
      if (asset) {
        return new Error(
          !asset.found
            ? `Declared content references missing Asset '${asset.id}'.`
            : asset.state !== "ready"
            ? `Declared content references non-ready Asset '${asset.id}'.`
            : `Declared content media type does not match Asset '${asset.id}'.`,
        );
      }
      return undefined;
    },
  };
}

export async function projectAssetManifestEntry(
  context: EventMutationContext,
  namespace: string,
  entry: AssetManifestEntry,
): Promise<void> {
  const data = JSON.stringify(manifestNodeData(namespace, entry));
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

/** Applies one Collection event body to the graph in a single statement. */
export async function projectCollectionEvent(
  context: EventMutationContext,
  definition: CollectionDefinition,
  body: CollectionEventBody<CollectionRecord>,
  guard?: ProjectionGuard,
): Promise<CollectionRecord> {
  const params: unknown[] = [];
  const param = (value: unknown) => `$${params.push(value)}`;
  const statement = composeCollectionProjection(
    context.tables,
    definition,
    body,
    param,
    guard,
  );
  const result = await context.transaction.query<
    { applied: boolean; report: unknown }
  >(
    `WITH ${
      [
        ...statement.ctes,
        `projection_apply AS (SELECT 1 AS applied WHERE ${statement.gate})`,
        ...statement.effects("projection_apply"),
      ].join(",\n")
    }
     SELECT EXISTS (SELECT 1 FROM projection_apply) AS applied,
            ${statement.report} AS report`,
    params,
  );
  const row = result.rows[0];
  if (!row?.applied) {
    throw statement.failure(row?.report) ??
      new Error(
        `Collection '${definition.name}' '${body.record.id}' was not projected.`,
      );
  }
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

/** Loads many records of one collection in one statement, keyed by id. */
export async function loadCollectionRecords(
  executor: SqlExecutor,
  tables: { nodes: string },
  namespace: string,
  name: string,
  ids: readonly string[],
): Promise<ReadonlyMap<string, CollectionRecord>> {
  const result = await executor.query<NodeRow>(
    `SELECT * FROM ${tables.nodes}
     WHERE namespace = $1 AND type = $2 AND id = ANY($3::text[])`,
    [namespace, name, [...new Set(ids)]],
  );
  return new Map(result.rows.map((row) => [row.id, mapNode(row)]));
}
