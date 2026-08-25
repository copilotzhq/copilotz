/** Public API for the first-party Knowledge plugin. @module */

export {
  KNOWLEDGE_CHUNK_COLLECTION,
  KNOWLEDGE_DERIVED_FROM_EDGE,
  KNOWLEDGE_DOCUMENT_COLLECTION,
  KNOWLEDGE_EVENT_TYPES,
  KNOWLEDGE_HAS_CHUNK_EDGE,
  knowledgeChunkCollection,
  knowledgeDocumentCollection,
} from "./collections/index.ts";
export type { KnowledgeEventType } from "./collections/index.ts";
export {
  createIndexKnowledgeDocumentAction,
  createSearchKnowledgeAction,
  DELETE_KNOWLEDGE_DOCUMENT_ACTION_ID,
  deleteKnowledgeDocumentAction,
  INDEX_KNOWLEDGE_DOCUMENT_ACTION_ID,
  INGEST_KNOWLEDGE_DOCUMENT_ACTION_ID,
  ingestKnowledgeDocumentAction,
  SEARCH_KNOWLEDGE_ACTION_ID,
} from "./actions/index.ts";
export type {
  CreateIndexKnowledgeDocumentActionOptions,
  DeleteKnowledgeDocumentInput,
  DeleteKnowledgeDocumentResult,
  IndexKnowledgeDocumentAction,
  IndexKnowledgeDocumentInput,
  IngestKnowledgeDocumentInput,
  IngestKnowledgeDocumentResult,
  KnowledgeActionCallers,
  KnowledgeActionContext,
  KnowledgeIndexActionCallers,
  SearchKnowledgeAction,
  SearchKnowledgeActionInput,
  SearchKnowledgeActionResult,
} from "./actions/index.ts";
export { createKnowledgePlugin } from "./plugin.ts";
export type { KnowledgePlugin } from "./plugin.ts";
export {
  defineKnowledgeEmbeddingProvider,
  embedKnowledgeTexts,
  isKnowledgeEmbeddingProvider,
} from "./resources/index.ts";
export {
  createDefaultKnowledgeSourceLoader,
  createDefaultKnowledgeTextExtractor,
  createKnowledgeActionResources,
} from "./authoring/index.ts";
export type {
  KnowledgeActionResourcesContribution,
  KnowledgeToolAliases,
} from "./authoring/index.ts";
export type {
  CompleteKnowledgeDocumentInput,
  CreateKnowledgeDocumentInput,
  CreateKnowledgePluginOptions,
  FailKnowledgeDocumentInput,
  KnowledgeChunk,
  KnowledgeChunkingConfig,
  KnowledgeDocument,
  KnowledgeDocumentSourceInput,
  KnowledgeDocumentSourceType,
  KnowledgeDocumentStatus,
  KnowledgeEmbeddingConfig,
  KnowledgeEmbeddingProviderResource,
  KnowledgeEmbeddingRequest,
  KnowledgeEmbeddingResponse,
  KnowledgeSearchInput,
  KnowledgeSearchResult,
  KnowledgeSearchScope,
  KnowledgeSourceLoader,
  KnowledgeTextExtractor,
  LoadedKnowledgeSource,
  MarkKnowledgeDocumentDuplicateInput,
} from "./internal/types.ts";
