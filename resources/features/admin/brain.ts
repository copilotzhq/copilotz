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

type SearchMode = "keyword" | "semantic" | "hybrid";

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

interface BrainMatch {
  keyword?: boolean;
  similarity?: number;
  relationDistance?: number;
  reasons: string[];
}

interface BrainNode {
  id: string;
  namespace: string;
  name: string;
  content: string;
  layer: string;
  kind: string;
  status: string;
  memorySpaceId: string | null;
  checkpointId: string | null;
  agentId: string | null;
  threadId: string | null;
  confidence: number | null;
  sourceMessageIds: string[];
  sourceField: string | null;
  sourceType: string | null;
  sourceId: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  data: Record<string, unknown>;
  clusterId: string;
  x: number;
  y: number;
}

interface BrainEdge {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  type: string;
  weight: number | null;
  createdAt: string | null;
  data: Record<string, unknown> | null;
}

interface RelatedBrainNode {
  node: BrainNode;
  edge: BrainEdge;
  direction: "in" | "out";
}

interface SimilarBrainNode {
  node: BrainNode;
  similarity: number;
}

interface ScoredBrainNode {
  node: BrainNode;
  score: number;
  match: BrainMatch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeExactFilter(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function normalizeBool(value: unknown): boolean {
  return value === true || value === "true" || value === "1";
}

function normalizeSearchMode(value: unknown): SearchMode {
  return value === "semantic" || value === "hybrid" || value === "keyword"
    ? value
    : "keyword";
}

function normalizeMinSimilarity(value: unknown): number {
  const parsed = typeof value === "string" || typeof value === "number"
    ? Number(value)
    : Number.NaN;
  if (!Number.isFinite(parsed)) return 0.2;
  return Math.min(0.99, Math.max(-1, parsed));
}

function normalizeRelationTypes(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
    ? value.split(",")
    : [];
  const types = raw
    .map((item) => String(item).trim())
    .filter((item) => RELATION_EDGE_TYPES.has(item));
  return types.length > 0 ? [...new Set(types)] : [...RELATION_EDGE_TYPES];
}

function pushBrainNodeFilters(
  params: unknown[],
  query: Record<string, unknown>,
  alias = "n",
): string[] {
  const filters = [`${alias}."type" = 'brain_node'`];
  const exact = [
    { queryKey: "namespace", sql: `${alias}."namespace"` },
    { queryKey: "memorySpaceId", sql: `${alias}."data"->>'memorySpaceId'` },
    { queryKey: "checkpointId", sql: `${alias}."data"->>'checkpointId'` },
    { queryKey: "agentId", sql: `${alias}."data"->>'createdByAgentId'` },
    { queryKey: "threadId", sql: `${alias}."data"->>'originThreadId'` },
    {
      queryKey: "layer",
      sql: `COALESCE(${alias}."data"->>'layer', 'knowledge')`,
    },
    { queryKey: "kind", sql: `${alias}."data"->>'kind'` },
    {
      queryKey: "status",
      sql: `COALESCE(${alias}."data"->>'status', 'active')`,
    },
  ];

  for (const filter of exact) {
    const value = normalizeExactFilter(query[filter.queryKey]);
    if (!value || value === "all") continue;
    params.push(value);
    filters.push(`${filter.sql} = $${params.length}`);
  }

  return filters;
}

function pushKeywordFilter(
  params: unknown[],
  filters: string[],
  query: Record<string, unknown>,
  alias = "n",
): boolean {
  const search = normalizeSearch(query.search as string | undefined);
  if (!search) return false;
  params.push(search);
  filters.push(
    `(LOWER(${alias}."id"::text) LIKE $${params.length}
      OR LOWER(${alias}."name") LIKE $${params.length}
      OR LOWER(COALESCE(${alias}."content", '')) LIKE $${params.length}
      OR LOWER(COALESCE(${alias}."data"->>'kind', '')) LIKE $${params.length}
      OR LOWER(COALESCE(${alias}."data"->>'sourceField', '')) LIKE $${params.length})`,
  );
  return true;
}

function semanticDataFilters(
  query: Record<string, unknown>,
): Record<string, string> {
  const pairs = [
    ["memorySpaceId", "memorySpaceId"],
    ["checkpointId", "checkpointId"],
    ["agentId", "createdByAgentId"],
    ["threadId", "originThreadId"],
    ["layer", "layer"],
    ["kind", "kind"],
    ["status", "status"],
  ] as const;
  const filters: Record<string, string> = {};
  for (const [queryKey, dataKey] of pairs) {
    const value = normalizeExactFilter(query[queryKey]);
    if (!value || value === "all") continue;
    filters[dataKey] = value;
  }
  return filters;
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

function hashUnit(value: string, salt: number): number {
  let hash = 2166136261 ^ salt;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 0xffffffff;
}

function rowToBrainNode(row: BrainNodeRow): BrainNode {
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
    sourceField: typeof data.sourceField === "string" ? data.sourceField : null,
    sourceType: row.sourceType ?? null,
    sourceId: row.sourceId ?? null,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
    data,
    clusterId: clusterIdForNode({ layer, kind }),
    x: 0,
    y: 0,
  };
}

function graphNodeToBrainNode(node: Record<string, unknown>): BrainNode {
  return rowToBrainNode({
    id: String(node.id),
    namespace: String(node.namespace ?? ""),
    name: String(node.name ?? ""),
    content: typeof node.content === "string" ? node.content : null,
    data: isRecord(node.data) ? node.data : null,
    sourceType: typeof node.sourceType === "string" ? node.sourceType : null,
    sourceId: typeof node.sourceId === "string" ? node.sourceId : null,
    createdAt:
      typeof node.createdAt === "string" || node.createdAt instanceof Date
        ? node.createdAt
        : null,
    updatedAt:
      typeof node.updatedAt === "string" || node.updatedAt instanceof Date
        ? node.updatedAt
        : null,
  });
}

function rowToBrainEdge(row: BrainEdgeRow): BrainEdge {
  return {
    id: row.id,
    sourceNodeId: row.sourceNodeId,
    targetNodeId: row.targetNodeId,
    type: row.type,
    weight: row.weight === null || row.weight === undefined
      ? null
      : toNum(row.weight),
    createdAt: toIso(row.createdAt),
    data: row.data ?? null,
  };
}

function addReason(match: BrainMatch, reason: string) {
  if (!match.reasons.includes(reason)) match.reasons.push(reason);
}

function mergeCandidate(
  candidates: Map<string, ScoredBrainNode>,
  node: BrainNode,
  score: number,
  patch: Partial<BrainMatch>,
) {
  const current = candidates.get(node.id);
  const match: BrainMatch = current?.match ?? { reasons: [] };
  if (patch.keyword) match.keyword = true;
  if (typeof patch.similarity === "number") {
    match.similarity = Math.max(
      match.similarity ?? -Infinity,
      patch.similarity,
    );
  }
  if (typeof patch.relationDistance === "number") {
    match.relationDistance = Math.min(
      match.relationDistance ?? Number.POSITIVE_INFINITY,
      patch.relationDistance,
    );
  }
  for (const reason of patch.reasons ?? []) addReason(match, reason);
  if (node.status === "active") addReason(match, "active");

  candidates.set(node.id, {
    node,
    match,
    score: Math.max(current?.score ?? -Infinity, score),
  });
}

function formatSimilarity(value: number): string {
  return value.toFixed(2);
}

function nodeSelect(alias = "n") {
  return `
    ${alias}."id"::text AS "id",
    ${alias}."namespace",
    ${alias}."name",
    ${alias}."content",
    ${alias}."data",
    ${alias}."source_type" AS "sourceType",
    ${alias}."source_id" AS "sourceId",
    ${alias}."created_at" AS "createdAt",
    ${alias}."updated_at" AS "updatedAt"`;
}

function relatedNodeSelect(alias = "other") {
  return `
    ${alias}."id"::text AS "nodeId",
    ${alias}."namespace" AS "nodeNamespace",
    ${alias}."name" AS "nodeName",
    ${alias}."content" AS "nodeContent",
    ${alias}."data" AS "nodeData",
    ${alias}."source_type" AS "nodeSourceType",
    ${alias}."source_id" AS "nodeSourceId",
    ${alias}."created_at" AS "nodeCreatedAt",
    ${alias}."updated_at" AS "nodeUpdatedAt"`;
}

function rowToRelatedNode(row: Record<string, unknown>): BrainNode {
  return rowToBrainNode({
    id: String(row.nodeId),
    namespace: String(row.nodeNamespace ?? ""),
    name: String(row.nodeName ?? ""),
    content: typeof row.nodeContent === "string" ? row.nodeContent : null,
    data: isRecord(row.nodeData) ? row.nodeData : null,
    sourceType: typeof row.nodeSourceType === "string"
      ? row.nodeSourceType
      : null,
    sourceId: typeof row.nodeSourceId === "string" ? row.nodeSourceId : null,
    createdAt: typeof row.nodeCreatedAt === "string" ||
        row.nodeCreatedAt instanceof Date
      ? row.nodeCreatedAt
      : null,
    updatedAt: typeof row.nodeUpdatedAt === "string" ||
        row.nodeUpdatedAt instanceof Date
      ? row.nodeUpdatedAt
      : null,
  });
}

async function loadSqlNodes(args: {
  copilotz: Copilotz;
  query: Record<string, unknown>;
  includeKeyword: boolean;
  limit: number;
  offset: number;
}): Promise<BrainNode[]> {
  const params: unknown[] = [];
  const filters = pushBrainNodeFilters(params, args.query);
  if (args.includeKeyword) {
    pushKeywordFilter(params, filters, args.query);
  }
  const whereClause = `WHERE ${filters.join(" AND ")}`;
  params.push(args.limit);
  const limitIndex = params.length;
  params.push(args.offset);
  const offsetIndex = params.length;
  const result = await args.copilotz.ops.query<BrainNodeRow>(
    `SELECT ${nodeSelect("n")}
     FROM "nodes" AS n
     ${whereClause}
     ORDER BY n."updated_at" DESC, n."created_at" DESC, n."id" DESC
     LIMIT $${limitIndex} OFFSET $${offsetIndex}`,
    params,
  );
  return result.rows.map(rowToBrainNode);
}

async function loadNodeById(args: {
  copilotz: Copilotz;
  query: Record<string, unknown>;
  id: string;
}): Promise<BrainNode | null> {
  const params: unknown[] = [args.id];
  const filters = [
    `n."id"::text = $1`,
    ...pushBrainNodeFilters(params, args.query),
  ];
  const result = await args.copilotz.ops.query<BrainNodeRow>(
    `SELECT ${nodeSelect("n")}
     FROM "nodes" AS n
     WHERE ${filters.join(" AND ")}
     LIMIT 1`,
    params,
  );
  return result.rows[0] ? rowToBrainNode(result.rows[0]) : null;
}

async function loadSemanticNodes(args: {
  copilotz: Copilotz;
  query: Record<string, unknown>;
  searchText: string;
  limit: number;
  minSimilarity: number;
}): Promise<{ nodes: SimilarBrainNode[]; error: string | null }> {
  if (!args.searchText) return { nodes: [], error: null };
  try {
    const embeddingResult = await args.copilotz.embeddings.embed([
      args.searchText,
    ]);
    const embedding = embeddingResult.embeddings[0];
    if (!Array.isArray(embedding) || embedding.length === 0) {
      return { nodes: [], error: "Embedding provider returned no vector." };
    }
    const namespace = normalizeExactFilter(args.query.namespace);
    const results = await args.copilotz.ops.unsafeGraph.searchNodes({
      embedding,
      namespaces: namespace && namespace !== "all" ? [namespace] : undefined,
      nodeTypes: ["brain_node"],
      dataFilters: semanticDataFilters(args.query),
      limit: args.limit,
      minSimilarity: args.minSimilarity,
    });
    return {
      nodes: results.map((result) => ({
        node: graphNodeToBrainNode(
          result.node as unknown as Record<string, unknown>,
        ),
        similarity: result.similarity ?? 0,
      })),
      error: null,
    };
  } catch (error) {
    return {
      nodes: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function loadRelatedNodes(args: {
  copilotz: Copilotz;
  query: Record<string, unknown>;
  focusNodeId: string;
  relationTypes: string[];
  limit: number;
}): Promise<RelatedBrainNode[]> {
  const params: unknown[] = [args.focusNodeId, args.relationTypes];
  const filters = pushBrainNodeFilters(params, args.query, "other");
  const result = await args.copilotz.ops.query<
    BrainEdgeRow & Record<string, unknown>
  >(
    `SELECT
       e."id"::text AS "id",
       e."source_node_id"::text AS "sourceNodeId",
       e."target_node_id"::text AS "targetNodeId",
       e."type",
       e."data",
       e."weight",
       e."created_at" AS "createdAt",
       ${relatedNodeSelect("other")}
     FROM "edges" AS e
     INNER JOIN "nodes" AS other
       ON other."id" = CASE
         WHEN e."source_node_id"::text = $1 THEN e."target_node_id"
         ELSE e."source_node_id"
       END
     WHERE (e."source_node_id"::text = $1 OR e."target_node_id"::text = $1)
       AND e."type" = ANY($2)
       AND ${filters.join(" AND ")}
     ORDER BY e."created_at" DESC, e."id" DESC
     LIMIT ${Math.max(1, Math.min(args.limit, 100))}`,
    params,
  );
  return result.rows
    .filter((row) => RELATION_EDGE_TYPES.has(row.type))
    .map((row) => {
      const edge = rowToBrainEdge(row);
      return {
        node: rowToRelatedNode(row),
        edge,
        direction: edge.sourceNodeId === args.focusNodeId ? "out" : "in",
      };
    });
}

async function loadSimilarToFocus(args: {
  copilotz: Copilotz;
  query: Record<string, unknown>;
  focusNodeId: string;
  limit: number;
  minSimilarity: number;
}): Promise<SimilarBrainNode[]> {
  const params: unknown[] = [args.focusNodeId];
  const filters = [
    `n."id"::text <> $1`,
    ...pushBrainNodeFilters(params, args.query, "n"),
  ];
  params.push(args.minSimilarity);
  const minIndex = params.length;
  const result = await args.copilotz.ops.query<
    BrainNodeRow & {
      similarity: number;
    }
  >(
    `SELECT ${nodeSelect("n")},
       1 - (n."embedding" <=> focus."embedding") AS "similarity"
     FROM "nodes" AS focus
     INNER JOIN "nodes" AS n
       ON n."embedding" IS NOT NULL
      AND focus."embedding" IS NOT NULL
     WHERE focus."id"::text = $1
       AND focus."type" = 'brain_node'
       AND ${filters.join(" AND ")}
       AND 1 - (n."embedding" <=> focus."embedding") > $${minIndex}
     ORDER BY n."embedding" <=> focus."embedding"
     LIMIT ${Math.max(1, Math.min(args.limit, 100))}`,
    params,
  );
  return result.rows.map((row) => ({
    node: rowToBrainNode(row),
    similarity: toNum(row.similarity),
  }));
}

function buildClusters(nodes: BrainNode[]) {
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
  return clusters;
}

function buildStats(nodes: BrainNode[]) {
  const stats = {
    total: nodes.length,
    byLayer: {} as Record<string, number>,
    byKind: {} as Record<string, number>,
    byStatus: {} as Record<string, number>,
  };
  for (const node of nodes) {
    stats.byLayer[node.layer] = (stats.byLayer[node.layer] ?? 0) + 1;
    stats.byKind[node.kind] = (stats.byKind[node.kind] ?? 0) + 1;
    stats.byStatus[node.status] = (stats.byStatus[node.status] ?? 0) + 1;
  }
  return stats;
}

async function loadEdgesForNodes(
  copilotz: Copilotz,
  nodes: BrainNode[],
): Promise<BrainEdge[]> {
  const nodeIds = nodes.map((node) => node.id);
  if (nodeIds.length === 0) return [];
  const placeholders = nodeIds.map((_, index) => `$${index + 1}`).join(", ");
  const edgeResult = await copilotz.ops.query<BrainEdgeRow>(
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
  return edgeResult.rows
    .filter((edge) => RELATION_EDGE_TYPES.has(edge.type))
    .map(rowToBrainEdge);
}

export default async function (
  request: { query?: Record<string, unknown> },
  copilotz: Copilotz,
) {
  const { query = {} } = request;
  const searchText = typeof query.search === "string"
    ? query.search.trim()
    : "";
  const searchMode = normalizeSearchMode(query.searchMode);
  const wantsKeyword = !searchText || searchMode === "keyword" ||
    searchMode === "hybrid";
  const wantsSemantic = Boolean(searchText) &&
    (searchMode === "semantic" || searchMode === "hybrid");
  const focusNodeId = normalizeExactFilter(query.focusNodeId);
  const includeRelated = normalizeBool(query.includeRelated);
  const includeSimilar = normalizeBool(query.includeSimilar);
  const limit = Math.min(
    normalizeLimit(query.limit ? Number(query.limit) : undefined, 120),
    500,
  );
  const offset = normalizeOffset(
    query.offset ? Number(query.offset) : undefined,
  );
  const candidateLimit = Math.min(500, Math.max(limit + offset, limit));
  const similarLimit = Math.min(
    normalizeLimit(
      query.similarLimit ? Number(query.similarLimit) : undefined,
      20,
    ),
    100,
  );
  const minSimilarity = normalizeMinSimilarity(query.minSimilarity);
  const relationTypes = normalizeRelationTypes(query.relationTypes);
  const candidates = new Map<string, ScoredBrainNode>();
  let semanticError: string | null = null;

  if (wantsKeyword) {
    const keywordNodes = await loadSqlNodes({
      copilotz,
      query,
      includeKeyword: Boolean(searchText),
      limit: searchMode === "keyword" ? limit : candidateLimit,
      offset: searchMode === "keyword" ? offset : 0,
    });
    for (const node of keywordNodes) {
      mergeCandidate(candidates, node, searchText ? 0.35 : 0, {
        keyword: Boolean(searchText),
        reasons: searchText ? [`keyword "${searchText}"`] : [],
      });
    }
  }

  let semanticNodes: SimilarBrainNode[] = [];
  if (wantsSemantic) {
    const semantic = await loadSemanticNodes({
      copilotz,
      query,
      searchText,
      limit: candidateLimit,
      minSimilarity,
    });
    semanticNodes = semantic.nodes;
    semanticError = semantic.error;
    for (const item of semanticNodes) {
      mergeCandidate(candidates, item.node, item.similarity, {
        similarity: item.similarity,
        reasons: [`semantic ${formatSimilarity(item.similarity)}`],
      });
    }
  }

  if (focusNodeId) {
    const focusNode = await loadNodeById({ copilotz, query, id: focusNodeId });
    if (focusNode) {
      mergeCandidate(candidates, focusNode, 1.5, {
        reasons: ["selected"],
      });
    }
  }

  let related: RelatedBrainNode[] = [];
  if (focusNodeId && includeRelated) {
    related = await loadRelatedNodes({
      copilotz,
      query,
      focusNodeId,
      relationTypes,
      limit: similarLimit,
    });
    for (const item of related) {
      const relationReason = `${
        item.direction === "out" ? "related by" : "related via"
      } ${item.edge.type}`;
      mergeCandidate(candidates, item.node, 0.7, {
        relationDistance: 1,
        reasons: [relationReason],
      });
    }
  }

  let similar: SimilarBrainNode[] = [];
  if (focusNodeId && includeSimilar) {
    similar = await loadSimilarToFocus({
      copilotz,
      query,
      focusNodeId,
      limit: similarLimit,
      minSimilarity,
    });
    for (const item of similar) {
      mergeCandidate(candidates, item.node, item.similarity, {
        similarity: item.similarity,
        reasons: [`similar ${formatSimilarity(item.similarity)}`],
      });
    }
  }

  const scored = [...candidates.values()].sort((left, right) => {
    const byScore = right.score - left.score;
    if (byScore !== 0) return byScore;
    const leftUpdated = left.node.updatedAt
      ? Date.parse(left.node.updatedAt)
      : 0;
    const rightUpdated = right.node.updatedAt
      ? Date.parse(right.node.updatedAt)
      : 0;
    return rightUpdated - leftUpdated ||
      left.node.id.localeCompare(right.node.id);
  });
  const sliced = searchMode === "keyword" && wantsKeyword
    ? scored
    : scored.slice(offset, offset + limit);
  const nodes = sliced.map((entry) => entry.node);
  const clusters = buildClusters(nodes);
  const edges = await loadEdgesForNodes(copilotz, nodes);
  const stats = buildStats(nodes);
  const matches = Object.fromEntries(
    sliced
      .filter((entry) => entry.match.reasons.length > 0)
      .map((entry) => [entry.node.id, entry.match]),
  );

  return {
    status: 200,
    data: {
      nodes,
      edges,
      clusters,
      stats,
      matches,
      related,
      similar,
      semantic: {
        requested: wantsSemantic,
        available: wantsSemantic ? semanticError === null : false,
        error: semanticError,
      },
      pageInfo: {
        limit,
        offset,
        returned: nodes.length,
      },
    },
  };
}
