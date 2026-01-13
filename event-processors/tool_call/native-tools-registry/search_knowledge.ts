import type { ToolExecutionContext } from "../index.ts";
import { embed } from "@/connectors/embeddings/index.ts";

interface SearchKnowledgeParams {
  query: string;
  namespaces?: string[];
  limit?: number;
  threshold?: number;
}

export default {
  key: "search_knowledge",
  name: "Search Knowledge Base",
  description: "Search the knowledge base for relevant information using semantic similarity. Returns document chunks that are most relevant to the query.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Natural language search query to find relevant documents.",
      },
      namespaces: {
        type: "array",
        items: { type: "string" },
        description: "Knowledge namespaces to search. If not provided, uses agent's default namespaces or 'default'.",
      },
      limit: {
        type: "number",
        description: "Maximum number of results to return.",
        default: 5,
        minimum: 1,
        maximum: 20,
      },
      threshold: {
        type: "number",
        description: "Minimum similarity score (0-1) for results.",
        default: 0.5,
        minimum: 0,
        maximum: 1,
      },
    },
    required: ["query"],
  },
  execute: async (
    { query, namespaces, limit = 5, threshold = 0.5 }: SearchKnowledgeParams,
    context?: ToolExecutionContext,
  ) => {
    const ops = context?.db?.ops;
    if (!ops) {
      throw new Error("Database operations not available in context");
    }

    // Get embedding config from context
    const embeddingConfig = context?.embeddingConfig;
    if (!embeddingConfig) {
      throw new Error("Embedding configuration not available. Ensure RAG is enabled in copilotz config.");
    }

    // Get namespaces from params, agent config, or default
    let searchNamespaces = namespaces;
    if (!searchNamespaces || searchNamespaces.length === 0) {
      // Try to get from agent's ragOptions
      const agentName = context?.senderId;
      const agent = context?.agents?.find((a) => a.name === agentName || a.id === agentName);
      const agentRagOptions = agent?.ragOptions as { namespaces?: string[] } | undefined;
      searchNamespaces = agentRagOptions?.namespaces ?? ["default"];
    }

    // Generate embedding for the query
    const embeddingResponse = await embed([query], embeddingConfig);
    if (!embeddingResponse.embeddings.length) {
      throw new Error("Failed to generate embedding for query");
    }

    const queryEmbedding = embeddingResponse.embeddings[0];

    // Search for similar chunks
    const results = await ops.searchChunks({
      embedding: queryEmbedding,
      namespaces: searchNamespaces,
      limit,
      threshold,
      documentFilters: {
        status: "indexed",
      },
    });

    if (results.length === 0) {
      return {
        results: [],
        message: "No relevant documents found for the query.",
        query,
        namespaces: searchNamespaces,
      };
    }

    // Format results for the agent
    return {
      results: results.map((r) => ({
        content: r.content,
        score: Math.round(r.similarity * 100) / 100,
        source: r.document?.title || r.document?.sourceUri || "Unknown",
        namespace: r.namespace,
        documentId: r.document?.id,
        chunkIndex: r.chunkIndex,
      })),
      query,
      namespaces: searchNamespaces,
      totalResults: results.length,
    };
  },
};

