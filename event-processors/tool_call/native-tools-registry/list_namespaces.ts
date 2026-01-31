import type { ToolExecutionContext } from "../index.ts";

export default {
  key: "list_namespaces",
  name: "List Knowledge Namespaces",
  description: "List all available knowledge base namespaces with document and chunk counts.",
  inputSchema: {
    type: "object",
    properties: {},
  },
  execute: async (_params: Record<string, never>, context?: ToolExecutionContext) => {
    const ops = context?.db?.ops;
    if (!ops) {
      throw new Error("Database operations not available in context");
    }

    const stats = await ops.getNamespaceStats();

    if (stats.length === 0) {
      return {
        namespaces: [],
        message: "No knowledge namespaces found. Use ingest_document to add documents.",
      };
    }

    return {
      namespaces: stats.map((s) => ({
        namespace: s.namespace,
        documents: s.documentCount,
        chunks: s.chunkCount,
        lastUpdated: s.lastUpdated?.toISOString() ?? null,
      })),
      totalNamespaces: stats.length,
      totalDocuments: stats.reduce((sum, s) => sum + s.documentCount, 0),
      totalChunks: stats.reduce((sum, s) => sum + s.chunkCount, 0),
    };
  },
};

