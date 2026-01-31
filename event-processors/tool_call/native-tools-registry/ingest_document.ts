import type { ToolExecutionContext } from "../index.ts";

interface IngestDocumentParams {
  source: string;
  title?: string;
  namespace?: string;
  metadata?: Record<string, unknown>;
}

export default {
  key: "ingest_document",
  name: "Ingest Document",
  description: "Add a document to the knowledge base for RAG retrieval. Supports URLs, file paths, or raw text (prefix with 'text:'). The document will be chunked, embedded, and stored for semantic search.",
  inputSchema: {
    type: "object",
    properties: {
      source: {
        type: "string",
        description: "URL (http/https), file path, or raw text (prefix with 'text:'). Examples: 'https://docs.example.com/guide', './docs/readme.md', 'text:This is the content to index.'",
      },
      title: {
        type: "string",
        description: "Optional title for the document. If not provided, will be inferred from source.",
      },
      namespace: {
        type: "string",
        description: "Target namespace for the document. If not provided, uses agent's ingestNamespace or 'default'.",
      },
      metadata: {
        type: "object",
        description: "Optional metadata to attach to the document.",
      },
    },
    required: ["source"],
  },
  execute: async (
    { source, title, namespace, metadata }: IngestDocumentParams,
    context?: ToolExecutionContext,
  ) => {
    const ops = context?.db?.ops;
    if (!ops) {
      throw new Error("Database operations not available in context");
    }

    // Get thread ID for queueing the event
    const threadId = context?.threadId;
    if (!threadId) {
      throw new Error("Thread ID not available in context");
    }

    // Determine namespace
    let targetNamespace = namespace;
    if (!targetNamespace) {
      const agentName = context?.senderId;
      const agent = context?.agents?.find((a) => a.name === agentName || a.id === agentName);
      const agentRagOptions = agent?.ragOptions as { ingestNamespace?: string } | undefined;
      targetNamespace = agentRagOptions?.ingestNamespace ?? "default";
    }

    // Infer title if not provided
    let docTitle = title;
    if (!docTitle) {
      if (source.startsWith("text:")) {
        docTitle = "Text Document";
      } else if (source.startsWith("http://") || source.startsWith("https://")) {
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

    // Queue the RAG_INGEST event for async processing
    await ops.addToQueue(threadId, {
      eventType: "RAG_INGEST",
      payload: {
        source,
        title: docTitle,
        namespace: targetNamespace,
        metadata: metadata ?? null,
      },
    });

    return {
      status: "queued",
      message: `Document "${docTitle}" queued for ingestion into namespace "${targetNamespace}".`,
      source,
      title: docTitle,
      namespace: targetNamespace,
    };
  },
};

