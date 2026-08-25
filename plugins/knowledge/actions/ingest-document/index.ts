/** Defines the document-ingestion action. @module */

import {
  type ActionContext,
  type ActionDefinition,
  defineAction,
} from "@copilotz/copilotz/actions";
import {
  INGEST_KNOWLEDGE_DOCUMENT_ACTION_ID,
  ingestDocument,
  ingestDocumentInputSchema,
  ingestDocumentOutputSchema,
  type IngestKnowledgeDocumentInput,
  type IngestKnowledgeDocumentResult,
} from "../internal/operations.ts";

export { INGEST_KNOWLEDGE_DOCUMENT_ACTION_ID };
export type { IngestKnowledgeDocumentInput, IngestKnowledgeDocumentResult };

/** Accepts a source and creates a pending document for durable indexing. */
export const ingestKnowledgeDocumentAction: ActionDefinition<
  IngestKnowledgeDocumentInput,
  IngestKnowledgeDocumentResult,
  ActionContext,
  typeof ingestDocumentInputSchema,
  typeof ingestDocumentOutputSchema
> = defineAction<
  IngestKnowledgeDocumentInput,
  IngestKnowledgeDocumentResult,
  ActionContext,
  typeof ingestDocumentInputSchema,
  typeof ingestDocumentOutputSchema
>({
  id: INGEST_KNOWLEDGE_DOCUMENT_ACTION_ID,
  inputSchema: ingestDocumentInputSchema,
  outputSchema: ingestDocumentOutputSchema,
  execute: ingestDocument,
});
