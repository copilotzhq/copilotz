import { defineCollection, relation } from "../domain/index.ts";
import type { CollectionDefinition } from "../domain/index.ts";

export const KNOWLEDGE_DOCUMENT_COLLECTION = "document";
export const KNOWLEDGE_CHUNK_COLLECTION = "chunk";
export const KNOWLEDGE_HAS_CHUNK_EDGE = "has_chunk";
export const KNOWLEDGE_DERIVED_FROM_EDGE = "derived_from";

const knowledgeDocumentSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    sourceType: {
      type: "string",
      enum: ["url", "file", "text", "asset"],
    },
    sourceUri: { type: ["string", "null"] },
    title: { type: "string" },
    mediaType: { type: ["string", "null"] },
    contentHash: { type: ["string", "null"] },
    source: { type: "array" },
    status: {
      type: "string",
      enum: ["pending", "processing", "indexed", "duplicate", "failed"],
    },
    chunkCount: { type: "number" },
    duplicateOfDocumentId: { type: ["string", "null"] },
    threadId: { type: ["string", "null"] },
    requestedByParticipantId: { type: ["string", "null"] },
    forceReindex: { type: "boolean" },
    error: { type: ["object", "null"] },
    externalId: { type: ["string", "null"] },
    metadata: { type: "object" },
    createdAt: { type: "string" },
    updatedAt: { type: "string" },
  },
  required: [
    "sourceType",
    "title",
    "source",
    "status",
    "chunkCount",
    "forceReindex",
    "metadata",
  ],
} as const;

/** Canonical source metadata and ingestion state for one knowledge document. */
export const knowledgeDocumentCollection: CollectionDefinition<
  typeof knowledgeDocumentSchema
> = defineCollection({
  name: KNOWLEDGE_DOCUMENT_COLLECTION,
  schema: knowledgeDocumentSchema,
  timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" },
  indexes: ["contentHash", "sourceUri", "status", "externalId", "threadId"],
  relations: {
    chunks: relation.hasMany(
      KNOWLEDGE_CHUNK_COLLECTION,
      "documentId",
      KNOWLEDGE_HAS_CHUNK_EDGE,
    ),
  },
  content: { fields: ["source"] },
});

const knowledgeChunkSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    documentId: { type: "string" },
    chunkIndex: { type: "number" },
    content: { type: "string" },
    tokenCount: { type: "number" },
    embedding: { type: "array", items: { type: "number" } },
    startPosition: { type: "number" },
    endPosition: { type: "number" },
    metadata: { type: "object" },
    createdAt: { type: "string" },
    updatedAt: { type: "string" },
  },
  required: [
    "documentId",
    "chunkIndex",
    "content",
    "tokenCount",
    "embedding",
    "startPosition",
    "endPosition",
    "metadata",
  ],
} as const;

/** Searchable projection derived from a canonical document source. */
export const knowledgeChunkCollection: CollectionDefinition<
  typeof knowledgeChunkSchema
> = defineCollection({
  name: KNOWLEDGE_CHUNK_COLLECTION,
  schema: knowledgeChunkSchema,
  timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" },
  indexes: ["documentId", ["documentId", "chunkIndex"]],
  relations: {
    document: relation.belongsTo(
      KNOWLEDGE_DOCUMENT_COLLECTION,
      "documentId",
      KNOWLEDGE_HAS_CHUNK_EDGE,
    ),
  },
  search: { enabled: true, fields: ["content"] },
});
