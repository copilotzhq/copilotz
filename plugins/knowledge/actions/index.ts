/** Public Knowledge Action definitions. @module */

import type { ActionCaller } from "@copilotz/copilotz/actions";
import type { IndexKnowledgeDocumentAction } from "./index-document/index.ts";
import type { SearchKnowledgeAction } from "./search-knowledge/index.ts";
import type { ingestKnowledgeDocumentAction } from "./ingest-document/index.ts";
import type { deleteKnowledgeDocumentAction } from "./delete-document/index.ts";

export {
  INDEX_KNOWLEDGE_DOCUMENT_ACTION_ID,
  type IndexKnowledgeDocumentAction,
  indexKnowledgeDocumentAction,
  type IndexKnowledgeDocumentInput,
} from "./index-document/index.ts";
export {
  INGEST_KNOWLEDGE_DOCUMENT_ACTION_ID,
  ingestKnowledgeDocumentAction,
  type IngestKnowledgeDocumentInput,
  type IngestKnowledgeDocumentResult,
} from "./ingest-document/index.ts";
export {
  SEARCH_KNOWLEDGE_ACTION_ID,
  type SearchKnowledgeAction,
  searchKnowledgeAction,
  type SearchKnowledgeActionInput,
  type SearchKnowledgeActionResult,
} from "./search-knowledge/index.ts";
export {
  DELETE_KNOWLEDGE_DOCUMENT_ACTION_ID,
  deleteKnowledgeDocumentAction,
  type DeleteKnowledgeDocumentInput,
  type DeleteKnowledgeDocumentResult,
} from "./delete-document/index.ts";
export type { KnowledgeActionContext } from "../shared/context.ts";

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
