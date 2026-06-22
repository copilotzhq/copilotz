/**
 * Framework-independent knowledge graph helpers.
 *
 * This surface is intended for lower-level graph inspection and admin/debug
 * workflows. For application data, prefer collections when possible.
 *
 * @module
 */

import type { Copilotz } from "@/index.ts";
import type {
  GraphMutationOptions,
  GraphQueryResult,
  TraversalResult,
} from "@/database/operations/index.ts";
import type {
  KnowledgeEdge,
  KnowledgeNode,
  NewKnowledgeNode,
} from "@/database/schemas/index.ts";

/** Search options for querying the Copilotz knowledge graph. */
export interface GraphSearchOptions {
  query?: string;
  embedding?: number[];
  /** Tenant/application namespace to search within. */
  namespace?: string;
  nodeTypes?: string[];
  limit?: number;
  minSimilarity?: number;
}

/** Handlers returned by {@link createGraphHandlers}. */
export interface GraphHandlers {
  getNodeById: (id: string) => Promise<KnowledgeNode | undefined>;
  listNodes: (
    namespace: string,
    options?: { type?: string },
  ) => Promise<KnowledgeNode[]>;
  getEdges: (
    nodeId: string,
    options?: { direction?: "in" | "out" | "both"; types?: string[] },
  ) => Promise<KnowledgeEdge[]>;
  traverse: (
    nodeId: string,
    options?: { edgeTypes?: string[]; depth?: number },
  ) => Promise<TraversalResult>;
  findRelated: (
    nodeId: string,
    options?: { depth?: number },
  ) => Promise<KnowledgeNode[]>;
  search: (options: GraphSearchOptions) => Promise<GraphQueryResult[]>;
  updateNode: (
    id: string,
    updates: Partial<NewKnowledgeNode>,
    options: GraphMutationOptions,
  ) => Promise<KnowledgeNode | undefined>;
  deleteNode: (id: string, options: GraphMutationOptions) => Promise<void>;
}

async function resolveSearchEmbedding(
  copilotz: Copilotz,
  options: GraphSearchOptions,
): Promise<number[] | undefined> {
  if (Array.isArray(options.embedding) && options.embedding.length > 0) {
    return options.embedding;
  }

  if (typeof options.query !== "string" || options.query.trim().length === 0) {
    return undefined;
  }

  const embeddingConfig = copilotz.config.rag?.embedding;
  if (!embeddingConfig) {
    throw new Error(
      "Graph search with query text requires rag.embedding configuration or an explicit embedding vector.",
    );
  }

  const { embedOne } = await import("@/runtime/embeddings/index.ts");
  return await embedOne(options.query, embeddingConfig);
}

/** Creates framework-independent handlers for knowledge graph operations. */
export function createGraphHandlers(copilotz: Copilotz): GraphHandlers {
  const unsafeGraph = copilotz.ops.unsafeGraph ?? copilotz.ops;
  const graphMutations = copilotz.ops.mutate?.graph;

  return {
    getNodeById: (id) => unsafeGraph.getNodeById(id),

    listNodes: (namespace, options) =>
      unsafeGraph.getNodesByNamespace(namespace, options?.type),

    getEdges: (nodeId, options) =>
      unsafeGraph.getEdgesForNode(
        nodeId,
        options?.direction ?? "both",
        options?.types,
      ),

    traverse: (nodeId, options) =>
      unsafeGraph.traverseGraph(
        nodeId,
        options?.edgeTypes,
        options?.depth,
      ),

    findRelated: (nodeId, options) =>
      unsafeGraph.findRelatedNodes(nodeId, options?.depth),

    search: async (options) => {
      const embedding = await resolveSearchEmbedding(copilotz, options);
      if (!embedding || embedding.length === 0) return [];

      return unsafeGraph.searchNodes({
        embedding,
        namespaces: options.namespace ? [options.namespace] : undefined,
        nodeTypes: options.nodeTypes,
        limit: options.limit,
        minSimilarity: options.minSimilarity,
      });
    },

    updateNode: (id, updates, options) =>
      graphMutations?.updateNode
        ? graphMutations.updateNode(id, updates, options)
        : unsafeGraph.updateNode(id, updates),

    deleteNode: (id, options) =>
      graphMutations?.deleteNode
        ? graphMutations.deleteNode(id, options)
        : unsafeGraph.deleteNode(id),
  };
}
