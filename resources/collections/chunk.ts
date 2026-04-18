/**
 * Chunk collection: RAG document chunks stored as graph nodes.
 */
import { defineCollection, relation } from "@/database/collections/index.ts";

export default defineCollection({
  name: "chunk",
  schema: {
    type: "object",
    properties: {
      id: { type: "string" },
      documentId: { type: "string" },
      chunkIndex: { type: "number" },
      content: { type: ["string", "null"] },
      tokenCount: { type: ["number", "null"] },
      embedding: { type: ["array", "null"] },
      startPosition: { type: ["number", "null"] },
      endPosition: { type: ["number", "null"] },
      metadata: { type: ["object", "null"] },
    },
    required: ["documentId"],
  } as const,
  timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" },
  indexes: [
    "documentId",
    "chunkIndex",
  ],
  relations: {
    nextChunk: relation.hasOne("chunk", "chunkIndex", "NEXT_CHUNK"),
  },
  search: {
    enabled: true,
    fields: ["content"],
  },
});
