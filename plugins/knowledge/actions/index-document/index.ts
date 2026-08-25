/** Defines the configured document-indexing workflow. @module */

import {
  type ActionDefinition,
  defineAction,
} from "@copilotz/copilotz/actions";
import {
  type CreateIndexKnowledgeDocumentActionOptions,
  INDEX_KNOWLEDGE_DOCUMENT_ACTION_ID,
  indexDocument,
  type IndexKnowledgeDocumentInput,
  indexKnowledgeDocumentInputSchema,
  type KnowledgeActionContext,
} from "../internal/operations.ts";
import type { KnowledgeDocument } from "../../internal/types.ts";

export { INDEX_KNOWLEDGE_DOCUMENT_ACTION_ID };
export type {
  CreateIndexKnowledgeDocumentActionOptions,
  IndexKnowledgeDocumentInput,
};

/** Defines one durable action for indexing a queued Knowledge document. */
export function createIndexKnowledgeDocumentAction(
  options: CreateIndexKnowledgeDocumentActionOptions,
): ActionDefinition<
  IndexKnowledgeDocumentInput,
  KnowledgeDocument,
  KnowledgeActionContext,
  typeof indexKnowledgeDocumentInputSchema,
  undefined
> {
  return defineAction<
    IndexKnowledgeDocumentInput,
    KnowledgeDocument,
    KnowledgeActionContext,
    typeof indexKnowledgeDocumentInputSchema
  >({
    id: INDEX_KNOWLEDGE_DOCUMENT_ACTION_ID,
    inputSchema: indexKnowledgeDocumentInputSchema,
    async execute(input, context: KnowledgeActionContext) {
      return await indexDocument(input, context, options);
    },
  });
}

export type IndexKnowledgeDocumentAction = ReturnType<
  typeof createIndexKnowledgeDocumentAction
>;
