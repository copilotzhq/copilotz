import type { Copilotz } from "@/index.ts";
import {
  normalizeLimit,
  normalizeOffset,
  normalizeSearch,
  toIso,
  toNum,
} from "./_helpers.ts";

const RELATION_EDGE_TYPES = new Set([
  "related_to",
  "supports",
  "contradicts",
  "depends_on",
  "supersedes",
]);

interface BrainNodeRow extends Record<string, unknown> {
  id: string;
  namespace: string;
  name: string;
  content: string | null;
  data: Record<string, unknown> | null;
  sourceType: string | null;
  sourceId: string | null;
  createdAt: Date | string | null;
  updatedAt: Date | string | null;
}

interface BrainEdgeRow extends Record<string, unknown> {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  type: string;
  data: Record<string, unknown> | null;
  weight: number | null;
  createdAt: Date | string | null;
}

interface BrainStatsRow extends Record<string, unknown> {
  layer: string;
  kind: string;
  status: string;
  count: number;
}

function normalizeExactFilter(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function pushBrainNodeFilters(
  params: unknown[],
  query: Record<string, unknown>,
): string[] {
  const filters = [`n."type" = 'brain_node'`];
  const exact = [
    { queryKey: "namespace", sql: `n."namespace"` },
    { queryKey: "memorySpaceId", sql: `n."data"->>'memorySpaceId'` },
    { queryKey: "checkpointId", sql: `n."data"->>'checkpointId'` },
    { queryKey: "agentId", sql: `n."data"->>'createdByAgentId'` },
    { queryKey: "threadId", sql: `n."data"->>'originThreadId'` },
    { queryKey: "layer", sql: `COALESCE(n."data"->>'layer', 'knowledge')` },
    { queryKey: "kind", sql: `n."data"->>'kind'` },
    { queryKey: "status", sql: `COALESCE(n."data"->>'status', 'active')` },
  ];

  for (const filter of exact) {
    const value = normalizeExactFilter(query[filter.queryKey]);
    if (!value || value === "all") continue;
    params.push(value);
    filters.push(`${filter.sql} = $${params.length}`);
  }

  const search = normalizeSearch(query.search as string | undefined);
  if (search) {
    params.push(search);
    filters.push(
      `(LOWER(n."id") LIKE $${params.length}
        OR LOWER(n."name") LIKE $${params.length}
        OR LOWER(COALESCE(n."content", '')) LIKE $${params.length}
        OR LOWER(COALESCE(n."data"->>'kind', '')) LIKE $${params.length}
        OR LOWER(COALESCE(n."data"->>'sourceField', '')) LIKE $${params.length})`,
    );
  }

  return filters;
}

function hashUnit(value: string, salt: number): number {
  let hash = 2166136261 ^ salt;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 0xffffffff;
}

function clusterIdForNode(node: { layer: string; kind: string }) {
  return `${node.layer}:${node.kind}`;
}

function clusterLabel(layer: string, kind: string) {
  const label = kind.replaceAll("_", " ");
  return layer === "working" ? `Working ${label}` : label;
}

function projectNode(
  id: string,
  cluster: { x: number; y: number },
): { x: number; y: number } {
  const radius = 0.055;
  return {
    x: Math.min(
      0.98,
      Math.max(0.02, cluster.x + (hashUnit(id, 1) - 0.5) * radius),
    ),
    y: Math.min(
      0.98,
      Math.max(0.02, cluster.y + (hashUnit(id, 2) - 0.5) * radius),
    ),
  };
}

export default async function (
  request: { query?: Record<string, unknown> },
  copilotz: Copilotz,
) {
  const { query = {} } = request;
  const q = copilotz.ops.query;

  const params: unknown[] = [];
  const filters = pushBrainNodeFilters(params, query);
  const whereClause = `WHERE ${filters.join(" AND ")}`;
  const limit = Math.min(
    normalizeLimit(query.limit ? Number(query.limit) : undefined, 120),
    500,
  );
  const offset = normalizeOffset(
    query.offset ? Number(query.offset) : undefined,
  );
  params.push(limit);
  const limitIndex = params.length;
  params.push(offset);
  const offsetIndex = params.length;

  const nodeResult = await q<BrainNodeRow>(
    `SELECT
       n."id"::text AS "id",
       n."namespace",
       n."name",
       n."content",
       n."data",
       n."source_type" AS "sourceType",
       n."source_id" AS "sourceId",
       n."created_at" AS "createdAt",
       n."updated_at" AS "updatedAt"
     FROM "nodes" AS n
     ${whereClause}
     ORDER BY n."updated_at" DESC, n."created_at" DESC, n."id" DESC
     LIMIT $${limitIndex} OFFSET $${offsetIndex}`,
    params,
  );

  const statsParams: unknown[] = [];
  const statsFilters = pushBrainNodeFilters(statsParams, query);
  const statsResult = await q<BrainStatsRow>(
    `SELECT
       COALESCE(n."data"->>'layer', 'knowledge') AS "layer",
       COALESCE(n."data"->>'kind', 'unknown') AS "kind",
       COALESCE(n."data"->>'status', 'active') AS "status",
       COUNT(*)::int AS "count"
     FROM "nodes" AS n
     WHERE ${statsFilters.join(" AND ")}
     GROUP BY 1, 2, 3
     ORDER BY 1, 2, 3`,
    statsParams,
  );

  const nodes = nodeResult.rows.map((row) => {
    const data = row.data ?? {};
    const layer = typeof data.layer === "string" ? data.layer : "knowledge";
    const kind = typeof data.kind === "string" ? data.kind : "unknown";
    const status = typeof data.status === "string" ? data.status : "active";
    return {
      id: row.id,
      namespace: row.namespace,
      name: row.name,
      content: row.content ?? "",
      layer,
      kind,
      status,
      memorySpaceId: typeof data.memorySpaceId === "string"
        ? data.memorySpaceId
        : null,
      checkpointId: typeof data.checkpointId === "string"
        ? data.checkpointId
        : null,
      agentId: typeof data.createdByAgentId === "string"
        ? data.createdByAgentId
        : null,
      threadId: typeof data.originThreadId === "string"
        ? data.originThreadId
        : null,
      confidence: typeof data.confidence === "number" ? data.confidence : null,
      sourceMessageIds: Array.isArray(data.sourceMessageIds)
        ? data.sourceMessageIds.filter((id): id is string =>
          typeof id === "string"
        )
        : [],
      sourceField: typeof data.sourceField === "string"
        ? data.sourceField
        : null,
      sourceType: row.sourceType ?? null,
      sourceId: row.sourceId ?? null,
      createdAt: toIso(row.createdAt),
      updatedAt: toIso(row.updatedAt),
      data,
      clusterId: clusterIdForNode({ layer, kind }),
      x: 0,
      y: 0,
    };
  });

  const clusterMap = new Map<
    string,
    {
      id: string;
      label: string;
      layer: string;
      kind: string;
      count: number;
      x: number;
      y: number;
    }
  >();
  for (const node of nodes) {
    if (!clusterMap.has(node.clusterId)) {
      clusterMap.set(node.clusterId, {
        id: node.clusterId,
        label: clusterLabel(node.layer, node.kind),
        layer: node.layer,
        kind: node.kind,
        count: 0,
        x: 0.12 + hashUnit(node.clusterId, 10) * 0.76,
        y: 0.14 + hashUnit(node.clusterId, 11) * 0.72,
      });
    }
    clusterMap.get(node.clusterId)!.count += 1;
  }
  const clusters = [...clusterMap.values()];
  for (const node of nodes) {
    const cluster = clusterMap.get(node.clusterId);
    if (!cluster) continue;
    const projected = projectNode(node.id, cluster);
    node.x = projected.x;
    node.y = projected.y;
  }

  let edges: Array<{
    id: string;
    sourceNodeId: string;
    targetNodeId: string;
    type: string;
    weight: number | null;
    createdAt: string | null;
    data: Record<string, unknown> | null;
  }> = [];
  const nodeIds = nodes.map((node) => node.id);
  if (nodeIds.length > 0) {
    const placeholders = nodeIds.map((_, index) => `$${index + 1}`).join(", ");
    const edgeResult = await q<BrainEdgeRow>(
      `SELECT
         e."id"::text AS "id",
         e."source_node_id"::text AS "sourceNodeId",
         e."target_node_id"::text AS "targetNodeId",
         e."type",
         e."data",
         e."weight",
         e."created_at" AS "createdAt"
       FROM "edges" AS e
       WHERE e."source_node_id"::text IN (${placeholders})
         AND e."target_node_id"::text IN (${placeholders})
         AND e."type" IN ('related_to', 'supports', 'contradicts', 'depends_on', 'supersedes')
       ORDER BY e."created_at" DESC, e."id" DESC`,
      nodeIds,
    );
    edges = edgeResult.rows
      .filter((edge) => RELATION_EDGE_TYPES.has(edge.type))
      .map((edge) => ({
        id: edge.id,
        sourceNodeId: edge.sourceNodeId,
        targetNodeId: edge.targetNodeId,
        type: edge.type,
        weight: edge.weight === null || edge.weight === undefined
          ? null
          : toNum(edge.weight),
        createdAt: toIso(edge.createdAt),
        data: edge.data ?? null,
      }));
  }

  const stats = {
    total: statsResult.rows.reduce((total, row) => total + toNum(row.count), 0),
    byLayer: {} as Record<string, number>,
    byKind: {} as Record<string, number>,
    byStatus: {} as Record<string, number>,
  };
  for (const row of statsResult.rows) {
    const count = toNum(row.count);
    stats.byLayer[row.layer] = (stats.byLayer[row.layer] ?? 0) + count;
    stats.byKind[row.kind] = (stats.byKind[row.kind] ?? 0) + count;
    stats.byStatus[row.status] = (stats.byStatus[row.status] ?? 0) + count;
  }

  return {
    status: 200,
    data: {
      nodes,
      edges,
      clusters,
      stats,
      pageInfo: {
        limit,
        offset,
        returned: nodes.length,
      },
    },
  };
}
