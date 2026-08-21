import type { SqlExecutor } from "../events/index.ts";
import type { CollectionDefinition } from "./definition.ts";
import { loadCollectionRecord, mapNode, type NodeRow } from "./reducer.ts";
import type { CollectionQuery, CollectionRecord } from "./types.ts";

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
