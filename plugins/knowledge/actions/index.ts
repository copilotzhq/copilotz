/** Public Knowledge Action definitions. @module */

import type { ActionCaller } from "@copilotz/copilotz/actions";
import type { IndexKnowledgeDocumentAction } from "./index-document/index.ts";
import type { SearchKnowledgeAction } from "./search-knowledge/index.ts";
import type { ingestKnowledgeDocumentAction } from "./ingest-document/index.ts";
import type { deleteKnowledgeDocumentAction } from "./delete-document/index.ts";

export {
  createIndexKnowledgeDocumentAction,
  type CreateIndexKnowledgeDocumentActionOptions,
  INDEX_KNOWLEDGE_DOCUMENT_ACTION_ID,
  type IndexKnowledgeDocumentAction,
  type IndexKnowledgeDocumentInput,
} from "./index-document/index.ts";
export {
  INGEST_KNOWLEDGE_DOCUMENT_ACTION_ID,
  ingestKnowledgeDocumentAction,
  type IngestKnowledgeDocumentInput,
  type IngestKnowledgeDocumentResult,
} from "./ingest-document/index.ts";
export {
  createSearchKnowledgeAction,
  SEARCH_KNOWLEDGE_ACTION_ID,
  type SearchKnowledgeAction,
  type SearchKnowledgeActionInput,
  type SearchKnowledgeActionResult,
} from "./search-knowledge/index.ts";
export {
  DELETE_KNOWLEDGE_DOCUMENT_ACTION_ID,
  deleteKnowledgeDocumentAction,
  type DeleteKnowledgeDocumentInput,
  type DeleteKnowledgeDocumentResult,
} from "./delete-document/index.ts";
export type { KnowledgeActionContext } from "./internal/operations.ts";

export type KnowledgeIndexActionCallers = Readonly<{
  indexKnowledgeDocument: ActionCaller<IndexKnowledgeDocumentAction>;
}>;

/** Default aliases exposed when generated Knowledge Tool resources are enabled. */
export type KnowledgeActionCallers =
  & KnowledgeIndexActionCallers
  & Readonly<{
    ingest_document: ActionCaller<typeof ingestKnowledgeDocumentAction>;
    search_knowledge: ActionCaller<SearchKnowledgeAction>;
    delete_document: ActionCaller<typeof deleteKnowledgeDocumentAction>;
  }>;
