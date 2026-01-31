import type { ToolExecutionContext } from "../index.ts";

interface DeleteDocumentParams {
  documentId?: string;
  sourceUri?: string;
  namespace?: string;
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
  description: "Remove a document and its chunks from the knowledge base. Can delete by document ID or by source URI and namespace.",
  inputSchema: {
    type: "object",
    properties: {
      documentId: {
        type: "string",
        description: "The unique ID of the document to delete.",
      },
      sourceUri: {
        type: "string",
        description: "The source URI of the document to delete (used with namespace).",
      },
      namespace: {
        type: "string",
        description: "The namespace of the document (required when using sourceUri).",
        default: "default",
      },
    },
  },
  execute: async (
    { documentId, sourceUri, namespace = "default" }: DeleteDocumentParams,
    context?: ToolExecutionContext,
  ) => {
    const ops = context?.db?.ops;
    if (!ops) {
      throw new Error("Database operations not available in context");
    }

    if (!documentId && !sourceUri) {
      throw new Error("Either documentId or sourceUri must be provided");
    }

    let docToDelete: DocumentRecord | undefined;

    if (documentId) {
      docToDelete = await ops.getDocumentById(documentId) as DocumentRecord | undefined;
    } else if (sourceUri) {
      // Find document by source URI and namespace using crud
      const docs = await ops.crud.documents.find({
        sourceUri,
        namespace,
      });
      docToDelete = docs[0] as DocumentRecord | undefined;
    }

    if (!docToDelete) {
      return {
        success: false,
        message: documentId
          ? `Document with ID "${documentId}" not found.`
          : `Document with source "${sourceUri}" in namespace "${namespace}" not found.`,
      };
    }

    const docId = docToDelete.id;
    const docTitle = docToDelete.title || docToDelete.sourceUri || docId;
    const docNamespace = docToDelete.namespace;

    await ops.deleteDocument(docId);

    return {
      success: true,
      message: `Document "${docTitle}" deleted from namespace "${docNamespace}".`,
      documentId: docId,
      title: docTitle,
      namespace: docNamespace,
    };
  },
};

