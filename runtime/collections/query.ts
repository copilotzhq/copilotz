import type { SqlExecutor } from "../events/index.ts";
import type { CollectionDefinition } from "./definition.ts";
import { loadCollectionRecord, mapNode, type NodeRow } from "./reducer.ts";
import type {
  CollectionGraphRelation,
  CollectionQuery,
  CollectionRecord,
  CollectionRelationQuery,
} from "./types.ts";

function boundedLimit(value: number | undefined): number {
  if (value === undefined) return 100;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError("Query limit must be a positive integer.");
  }
  return Math.min(value, 1_000);
}

function sqlLiteral(field: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(field)) {
    throw new TypeError(`Invalid query field '${field}'.`);
  }
  return field;
}

function jsonTextPath(field: string): string {
  const parts = field.split(".").map(sqlLiteral);
  if (parts.length === 1) return `data ->> '${parts[0]}'`;
  return `data #>> '{${parts.join(",")}}'`;
}

export async function getCollectionRecord(
  executor: SqlExecutor,
  tables: { nodes: string },
  namespace: string,
  name: string,
  id: string,
): Promise<CollectionRecord | null> {
  return await loadCollectionRecord(executor, tables, namespace, name, id);
}

type EdgeRow = Readonly<{
  id: string;
  namespace: string;
  source_node_id: string;
  source_type: string;
  target_node_id: string;
  target_type: string;
  type: string;
  data: unknown;
  weight: number | string | null;
  created_at: string | Date;
}>;

function jsonRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      return jsonRecord(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function relationLimit(value: number | undefined): number {
  if (value === undefined) return 100;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError("Relation limit must be a positive integer.");
  }
  return Math.min(value, 1_000);
}

/** Lists graph edges connected to nodes of one scoped Collection. */
export async function queryCollectionRelations(
  executor: SqlExecutor,
  tables: { nodes: string; edges: string },
  namespace: string,
  collection: string,
  query: CollectionRelationQuery = {},
): Promise<readonly CollectionGraphRelation[]> {
  const direction = query.direction ?? "both";
  if (direction !== "in" && direction !== "out" && direction !== "both") {
    throw new TypeError(`Invalid relation direction '${String(direction)}'.`);
  }
  const params: unknown[] = [namespace, collection];
  const nodeId = query.id?.trim();
  const nodeParameter = nodeId ? params.push(nodeId) : undefined;
  const membership = direction === "out"
    ? [
      "source.type = $2",
      ...(nodeParameter ? [`edge.source_node_id = $${nodeParameter}`] : []),
    ].join(" AND ")
    : direction === "in"
    ? [
      "target.type = $2",
      ...(nodeParameter ? [`edge.target_node_id = $${nodeParameter}`] : []),
    ].join(" AND ")
    : nodeParameter
    ? `((source.type = $2 AND edge.source_node_id = $${nodeParameter}) OR
        (target.type = $2 AND edge.target_node_id = $${nodeParameter}))`
    : "(source.type = $2 OR target.type = $2)";
  const filters = ["edge.namespace = $1", membership];
  const types = Object.freeze(
    [
      ...new Set(
        (query.types ?? []).map((type) => type.trim()).filter(Boolean),
      ),
    ],
  );
  if (types.length) {
    filters.push(`edge.type = ANY($${params.push([...types])}::text[])`);
  }
  const result = await executor.query<EdgeRow>(
    `SELECT edge.*, source.type AS source_type, target.type AS target_type
       FROM ${tables.edges} edge
       JOIN ${tables.nodes} source
         ON source.namespace = edge.namespace
        AND source.id = edge.source_node_id
       JOIN ${tables.nodes} target
         ON target.namespace = edge.namespace
        AND target.id = edge.target_node_id
      WHERE ${filters.join(" AND ")}
      ORDER BY edge.created_at, edge.id
      LIMIT ${relationLimit(query.limit)}`,
    params,
  );
  return Object.freeze(result.rows.map((row) => {
    const data = jsonRecord(row.data);
    return Object.freeze({
      id: row.id,
      namespace: row.namespace,
      type: row.type,
      source: Object.freeze({ type: row.source_type, id: row.source_node_id }),
      target: Object.freeze({ type: row.target_type, id: row.target_node_id }),
      metadata: Object.freeze(jsonRecord(data.metadata)),
      weight: Number(row.weight ?? 1),
      createdAt: row.created_at instanceof Date
        ? row.created_at.toISOString()
        : new Date(row.created_at).toISOString(),
    });
  }));
}

export async function queryCollectionRecords(
  executor: SqlExecutor,
  tables: { nodes: string; edges: string },
  definition: CollectionDefinition,
  namespace: string,
  query: CollectionQuery = {},
): Promise<readonly CollectionRecord[]> {
  const params: unknown[] = [namespace, definition.name];
  const filters = [`namespace = $1`, `type = $2`];
  for (const [field, value] of Object.entries(query.where ?? {})) {
    const index = params.push(value);
    if (field === "id") filters.push(`id = $${index}`);
    else filters.push(`${jsonTextPath(field)} = $${index}::text`);
  }
  if (query.after?.trim()) {
    const index = params.push(query.after.trim());
    filters.push(`id > $${index}`);
  }
  if (query.text?.trim() && definition.search?.enabled) {
    const index = params.push(`%${query.text.trim()}%`);
    filters.push(`content ILIKE $${index}`);
  }
  const orderField = query.order?.field === "id" ||
      query.order?.field === "createdAt" ||
      query.order?.field === "updatedAt"
    ? query.order.field === "id"
      ? "id"
      : query.order.field === "createdAt"
      ? "created_at"
      : "updated_at"
    : "id";
  const direction = query.order?.direction === "desc" ? "DESC" : "ASC";
  const limit = boundedLimit(query.limit);
  const result = await executor.query<NodeRow>(
    `SELECT * FROM ${tables.nodes}
     WHERE ${filters.join(" AND ")}
     ORDER BY ${orderField} ${direction}, id ${direction}
     LIMIT ${limit}`,
    params,
  );
  const records = result.rows.map(mapNode);
  if (!query.include?.length) return Object.freeze(records);

  const hydrated = [];
  for (const value of records) {
    const extra: Record<string, unknown> = {};
    for (const name of query.include) {
      const relation = definition.relations?.[name];
      if (!relation) {
        throw new TypeError(
          `Unknown relation '${name}' on '${definition.name}'.`,
        );
      }
      if (relation.type === "belongsTo") {
        const parentId = value[relation.foreignKey];
        extra[name] = typeof parentId === "string"
          ? await loadCollectionRecord(
            executor,
            tables,
            namespace,
            relation.collection,
            parentId,
          )
          : null;
      } else {
        const edgeType = relation.edgeType ?? `has_${relation.collection}`;
        const invert = relation.edge === "child-to-parent";
        const edges = await executor.query<{ related_id: string }>(
          invert
            ? `SELECT source_node_id AS related_id FROM ${tables.edges}
               WHERE namespace = $1 AND target_node_id = $2 AND type = $3
               ORDER BY source_node_id`
            : `SELECT target_node_id AS related_id FROM ${tables.edges}
               WHERE namespace = $1 AND source_node_id = $2 AND type = $3
               ORDER BY target_node_id`,
          [namespace, value.id, edgeType],
        );
        extra[name] = Object.freeze(
          (await Promise.all(
            edges.rows.map((edge) =>
              loadCollectionRecord(
                executor,
                tables,
                namespace,
                relation.collection,
                edge.related_id,
              )
            ),
          )).filter((item) => item !== null),
        );
      }
    }
    hydrated.push(Object.freeze({ ...value, ...extra }));
  }
  return Object.freeze(hydrated);
}
