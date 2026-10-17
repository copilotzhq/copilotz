/** Internal draft ordinary projection descriptor. No public barrel export.
 * This is prepared for a behavior-preserving reducer extraction; until the
 * reducer is rewired and its duplicate implementation removed, equivalence is
 * a separate review gate. It grants no validation, authority or readiness.
 */
import type { CollectionDefinition } from "./definition.ts";

export type CollectionOrdinaryProjectionDefinition = Pick<
  CollectionDefinition,
  "name" | "timestamps" | "search" | "identity" | "relations"
>;

function requireText(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${name} must be non-empty.`);
  return normalized;
}

export function searchContent(
  definition: CollectionOrdinaryProjectionDefinition,
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
  definition: CollectionOrdinaryProjectionDefinition,
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
  definition: CollectionOrdinaryProjectionDefinition,
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

export type CollectionOrdinaryRelationTarget = Readonly<{
  ord: number;
  relation: string;
  related_type: string;
  related_id: string;
}>;

export type CollectionOrdinaryRelationEdge = Readonly<{
  id: string;
  source_id: string;
  target_id: string;
  edge_type: string;
}>;

export type CollectionOrdinaryRelationKey = Readonly<{
  edge_type: string;
  related_type: string;
  self_is_source: boolean;
}>;

export type CollectionOrdinaryProjection = Readonly<{
  node: Readonly<{
    name: string;
    content: string | null;
    data: string;
    sourceType: string | null;
    sourceId: string | null;
    createdAt: string | null;
    updatedAt: string | null;
  }>;
  targets: readonly CollectionOrdinaryRelationTarget[];
  keys: readonly CollectionOrdinaryRelationKey[];
  edges: readonly CollectionOrdinaryRelationEdge[];
}>;

/** Describe only ordinary node/relation projection; callers validate their own
 * accepted input subset first. This preserves current reducer coercion/default,
 * inactive inverse declaration and last-wins semantics, rather than validating
 * them or silently declaring overlapping relation writers safe.
 */
export function describeCollectionOrdinaryProjection(
  definition: CollectionOrdinaryProjectionDefinition,
  value: Record<string, unknown> & { id: string; namespace: string },
): CollectionOrdinaryProjection {
  const namespace = value.namespace;
  const id = value.id;
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

  const targets: CollectionOrdinaryRelationTarget[] = [];
  // Relations that share an edge type, direction, and related Collection
  // resolve to the edge set of the last one, as sequential syncing did.
  const edgeSets = new Map<
    string,
    Readonly<
      {
        key: CollectionOrdinaryRelationKey;
        edges: readonly CollectionOrdinaryRelationEdge[];
      }
    >
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
    const edges = new Map<string, CollectionOrdinaryRelationEdge>();
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

  const edges = new Map(
    [...edgeSets.values()].flatMap((set) => set.edges).map((edge) => [
      edge.id,
      edge,
    ]),
  );
  return {
    node,
    targets,
    keys: [...edgeSets.values()].map((set) => set.key),
    edges: [...edges.values()],
  };
}
