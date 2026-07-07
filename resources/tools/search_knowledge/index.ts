import type { ToolExecutionContext } from "@/runtime/tools/types.ts";
import { createRagDataServices } from "@/runtime/collections/native.ts";
import type { RagScope } from "@/types/index.ts";

interface SearchKnowledgeParams {
  query: string;
  scope?: RagScope;
  limit?: number;
  threshold?: number;
}

export default {
  key: "search_knowledge",
  name: "Search Knowledge Base",
  description:
    "Search the knowledge base for relevant information using semantic similarity. Returns document chunks that are most relevant to the query.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "Natural language search query to find relevant documents.",
      },
      scope: {
        type: "object",
        description:
          "Optional graph search scope. If omitted, the current thread and agent are used.",
        properties: {
          threadId: { type: "string" },
          agentId: { type: "string" },
          knowledgeSpaceIds: {
            type: "array",
            items: { type: "string" },
          },
          documentIds: {
            type: "array",
            items: { type: "string" },
          },
        },
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
    { query, scope, limit = 5, threshold = 0.5 }: SearchKnowledgeParams,
    context?: ToolExecutionContext,
  ) => {
    const ops = context?.db?.ops;
    if (!ops) {
      throw new Error("Database operations not available in context");
    }
    const ragData = createRagDataServices({
      collections: context?.collections,
      ops,
    });

    const embeddingConfig = context?.embeddingConfig;
    if (!embeddingConfig) {
      throw new Error(
        "Embedding configuration not available. Ensure RAG is enabled in copilotz config.",
      );
    }

    const namespace = context?.namespace;
    if (!namespace) {
      throw new Error("Tenant namespace not available in context");
    }
    const senderId = context?.senderId;
    const agent = context?.agents?.find((a) =>
      a.id === senderId || a.name === senderId
    );
    const agentScope = agent?.ragOptions?.scope;

    const results = await ragData.searchChunks({
      query,
      namespace,
      scope: {
        threadId: context?.threadId,
        agentId: senderId,
        ...agentScope,
        ...scope,
      },
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
        namespace,
      };
    }

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
      namespace,
      totalResults: results.length,
    };
  },
};
