import type { ToolExecutionContext } from "@/resources/processors/tool_call/index.ts";

interface IngestDocumentParams {
  source: string;
  title?: string;
  metadata?: Record<string, unknown>;
}

export default {
  key: "ingest_document",
  name: "Ingest Document",
  description:
    "Add a document to the knowledge base for RAG retrieval. Supports URLs, file paths, or raw text (prefix with 'text:'). The document will be chunked, embedded, and stored for semantic search.",
  inputSchema: {
    type: "object",
    properties: {
      source: {
        type: "string",
        description:
          "URL (http/https), file path, or raw text (prefix with 'text:'). Examples: 'https://docs.example.com/guide', './docs/readme.md', 'text:This is the content to index.'",
      },
      title: {
        type: "string",
        description:
          "Optional title for the document. If not provided, will be inferred from source.",
      },
      metadata: {
        type: "object",
        description:
          "Optional metadata to attach to the document. Use metadata.scope to link it to graph scopes such as threadId, agentId, or knowledgeSpaceIds.",
      },
    },
    required: ["source"],
  },
  execute: async (
    { source, title, metadata }: IngestDocumentParams,
    context?: ToolExecutionContext,
  ) => {
    const ops = context?.db?.ops;
    if (!ops) {
      throw new Error("Database operations not available in context");
    }

    const threadId = context?.threadId;
    if (!threadId) {
      throw new Error("Thread ID not available in context");
    }

    const targetNamespace = context?.namespace;
    if (!targetNamespace) {
      throw new Error("Tenant namespace not available in context");
    }

    let docTitle = title;
    if (!docTitle) {
      if (source.startsWith("text:")) {
        docTitle = "Text Document";
      } else if (
        source.startsWith("http://") || source.startsWith("https://")
      ) {
        try {
          const url = new URL(source);
          docTitle = url.pathname.split("/").pop() || url.hostname;
        } catch {
          docTitle = "Web Document";
        }
      } else {
        docTitle = source.split("/").pop() || "Document";
      }
    }

    const payload = {
      source,
      title: docTitle,
      namespace: targetNamespace,
      metadata: {
        ...(metadata ?? {}),
        scope: {
          threadId,
          agentId: context?.senderId,
          ...((metadata?.scope &&
              typeof metadata.scope === "object")
            ? metadata.scope as Record<string, unknown>
            : {}),
        },
      },
    };

    await ops.mutate.graph.createNode({
      namespace: targetNamespace,
      type: "rag_ingestion",
      name: docTitle,
      content: source,
      sourceType: "thread",
      sourceId: threadId,
      data: payload,
    }, {
      threadId,
      namespace: targetNamespace,
      status: "pending",
      priority: 0,
      eventPayload: payload,
    });

    return {
      status: "queued",
      message: `Document "${docTitle}" queued for ingestion.`,
      source,
      title: docTitle,
      namespace: targetNamespace,
    };
  },
};
