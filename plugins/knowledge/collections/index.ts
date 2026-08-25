/** Public Knowledge Collection definitions. @module */

export {
  KNOWLEDGE_CHUNK_COLLECTION,
  KNOWLEDGE_DERIVED_FROM_EDGE,
  KNOWLEDGE_DOCUMENT_COLLECTION,
  KNOWLEDGE_EVENT_TYPES,
  KNOWLEDGE_HAS_CHUNK_EDGE,
} from "./internal/contracts.ts";
export type { KnowledgeEventType } from "./internal/contracts.ts";
export { knowledgeDocumentCollection } from "./document/index.ts";
export { knowledgeChunkCollection } from "./chunk/index.ts";
