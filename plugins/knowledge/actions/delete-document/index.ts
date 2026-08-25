/** Defines the Knowledge document deletion action. @module */

import {
  type ActionDefinition,
  defineAction,
} from "@copilotz/copilotz/actions";
import {
  DELETE_KNOWLEDGE_DOCUMENT_ACTION_ID,
  deleteDocument,
  deleteDocumentInputSchema,
  deleteDocumentOutputSchema,
  type DeleteKnowledgeDocumentInput,
  type DeleteKnowledgeDocumentResult,
  type KnowledgeActionContext,
} from "../internal/operations.ts";

export { DELETE_KNOWLEDGE_DOCUMENT_ACTION_ID };
export type { DeleteKnowledgeDocumentInput, DeleteKnowledgeDocumentResult };

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
  execute: deleteDocument,
});
