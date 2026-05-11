import type { ToolExecutionContext } from "@/resources/processors/tool_call/index.ts";
import { createRagDataServices } from "@/runtime/collections/native.ts";

interface DeleteDocumentParams {
  documentId?: string;
  sourceUri?: string;
}

interface DocumentRecord {
  id: string;
  title?: string | null;
  sourceUri?: string | null;
  namespace: string;
}

export default {
  key: "delete_document",
  name: "Delete Document",
  description:
    "Remove a document and its chunks from the tenant knowledge graph. Can delete by document ID or by source URI.",
  inputSchema: {
    type: "object",
    properties: {
      documentId: {
        type: "string",
        description: "The unique ID of the document to delete.",
      },
      sourceUri: {
        type: "string",
        description: "The source URI of the document to delete.",
      },
    },
  },
  execute: async (
    { documentId, sourceUri }: DeleteDocumentParams,
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

    if (!documentId && !sourceUri) {
      throw new Error("Either documentId or sourceUri must be provided");
    }
    const namespace = context?.namespace;
    if (!namespace) {
      throw new Error("Tenant namespace not available in context");
    }

    let docToDelete: DocumentRecord | undefined;

    if (documentId) {
      docToDelete = await ragData.getDocumentById(documentId, namespace) as
        | DocumentRecord
        | undefined;
    } else if (sourceUri) {
      const docs = await ops.getNodesByNamespace(namespace);
      const match = docs.find((
        n: { type: string; data?: Record<string, unknown> | null },
      ) =>
        n.type === "document" &&
        (n.data as Record<string, unknown> | null)?.sourceUri === sourceUri
      );
      if (match) {
        docToDelete = await ragData.getDocumentById(
          match.id as string,
          namespace,
        ) as DocumentRecord | undefined;
      }
    }

    if (!docToDelete) {
      return {
        success: false,
        message: documentId
          ? `Document with ID "${documentId}" not found.`
          : `Document with source "${sourceUri}" not found.`,
      };
    }

    const docId = docToDelete.id;
    const docTitle = docToDelete.title || docToDelete.sourceUri || docId;
    const docNamespace = docToDelete.namespace;

    await ragData.deleteDocument(docId, docNamespace);

    return {
      success: true,
      message: `Document "${docTitle}" deleted.`,
      documentId: docId,
      title: docTitle,
      namespace: docNamespace,
    };
  },
};
