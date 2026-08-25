/** Shared Knowledge Collection names and event contracts. @module */

export const KNOWLEDGE_DOCUMENT_COLLECTION = "document";
export const KNOWLEDGE_CHUNK_COLLECTION = "chunk";
export const KNOWLEDGE_HAS_CHUNK_EDGE = "has_chunk";
export const KNOWLEDGE_DERIVED_FROM_EDGE = "derived_from";
export type KnowledgeEventType =
  | "document.created"
  | "document.processing"
  | "document.indexed"
  | "document.duplicate"
  | "document.failed"
  | "document.deleted"
  | "chunk.created"
  | "chunk.deleted";
export const KNOWLEDGE_EVENT_TYPES: readonly KnowledgeEventType[] = Object
  .freeze(
    [
      "document.created",
      "document.processing",
      "document.indexed",
      "document.duplicate",
      "document.failed",
      "document.deleted",
      "chunk.created",
      "chunk.deleted",
    ] as const,
  );
