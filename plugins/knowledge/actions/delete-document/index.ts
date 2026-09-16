/** Owns the delete-document Knowledge Action. @module */
import type { KnowledgeDocument } from "../../shared/types.ts";
import {
  type ActionDefinition,
  defineAction,
} from "@copilotz/copilotz/actions";
import type { KnowledgeActionContext } from "../../shared/context.ts";
import { optional, record } from "../../shared/input.ts";
import {
  documentMatchesScope,
  listDocumentChunks,
} from "../../shared/records.ts";
export const DELETE_KNOWLEDGE_DOCUMENT_ACTION_ID =
  "copilotz.knowledge.deleteDocument";

export type DeleteKnowledgeDocumentInput = Readonly<{
  documentId?: string;
  sourceUri?: string;
}>;

export type DeleteKnowledgeDocumentResult = Readonly<
  | {
    success: true;
    message: string;
    documentId: string;
    title: string;
    namespace: string;
  }
  | {
    success: false;
    message: string;
  }
>;

const deleteDocumentInputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    documentId: { type: "string" },
    sourceUri: { type: "string" },
  },
  oneOf: [{ required: ["documentId"] }, { required: ["sourceUri"] }],
} as const;

const deleteDocumentOutputSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    success: { type: "boolean" },
    message: { type: "string" },
    documentId: { type: "string" },
    title: { type: "string" },
    namespace: { type: "string" },
  },
  required: ["success", "message"],
} as const;

/** Deletes a Knowledge document and all of its derived chunks atomically. */
export const deleteKnowledgeDocumentAction: ActionDefinition<
  DeleteKnowledgeDocumentInput,
  DeleteKnowledgeDocumentResult,
  KnowledgeActionContext,
  typeof deleteDocumentInputSchema,
  typeof deleteDocumentOutputSchema
> = defineAction<
  DeleteKnowledgeDocumentInput,
  DeleteKnowledgeDocumentResult,
  KnowledgeActionContext,
  typeof deleteDocumentInputSchema,
  typeof deleteDocumentOutputSchema
>({
  id: DELETE_KNOWLEDGE_DOCUMENT_ACTION_ID,
  inputSchema: deleteDocumentInputSchema,
  outputSchema: deleteDocumentOutputSchema,
  async execute(input, context: KnowledgeActionContext) {
    const data = record(input);
    const documentId = optional(data.documentId, "Document ID");
    const sourceUri = optional(data.sourceUri, "Document source URI");
    if (Boolean(documentId) === Boolean(sourceUri)) {
      throw new TypeError("Provide exactly one of documentId or sourceUri.");
    }
    const actionMetadata = record(context.action.metadata, "Action metadata");
    const threadId = optional(actionMetadata.threadId, "Action thread ID");
    const agentId = optional(actionMetadata.agentId, "Action agent ID");
    const candidates = [];
    if (documentId) {
      const exact = await context.collections.document.get({ id: documentId });
      if (exact) candidates.push(exact);
    } else {
      let after: string | undefined;
      while (true) {
        const page = await context.collections.document.list({
          where: { sourceUri: sourceUri! },
          order: { field: "id" },
          ...(after ? { after } : {}),
          limit: 1_000,
        });
        candidates.push(...page);
        if (page.length < 1_000) break;
        after = page.at(-1)!.id;
      }
      candidates.sort((left, right) =>
        String(right.createdAt).localeCompare(String(left.createdAt)) ||
        right.id.localeCompare(left.id)
      );
    }
    const document = candidates.find((candidate) =>
      !threadId && !agentId ||
      documentMatchesScope(candidate as KnowledgeDocument, {
        ...(threadId ? { threadId } : {}),
        ...(agentId ? { agentId } : {}),
      })
    );
    if (!document) {
      return {
        success: false,
        message: documentId
          ? `Document with ID "${documentId}" not found.`
          : `Document with source "${sourceUri}" not found.`,
      };
    }
    const chunks = await listDocumentChunks(
      context.collections,
      document.id,
    );
    await context.transaction(async (tx) => {
      for (const chunk of chunks) {
        await tx.collections.chunk.delete({ id: chunk.id });
      }
      await tx.collections.document.delete({ id: document.id });
    }, { operationKey: "delete_document" });
    const title = String(document.title || document.sourceUri || document.id);
    return {
      success: true,
      message: `Document "${title}" deleted.`,
      documentId: document.id,
      title,
      namespace: document.namespace,
    };
  },
});
