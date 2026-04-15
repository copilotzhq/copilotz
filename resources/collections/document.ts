/**
 * Document collection: RAG documents stored as graph nodes.
 * Holds metadata for ingested documents; chunks are linked via the chunk collection.
 */
import { defineCollection, relation } from "@/database/collections/index.ts";

export default defineCollection({
  name: "document",
  schema: {
    type: "object",
    properties: {
      id: { type: "string" },
      sourceType: {
        type: "string",
        enum: ["url", "file", "text", "asset"],
      },
      sourceUri: { type: ["string", "null"] },
      title: { type: ["string", "null"] },
      mimeType: { type: ["string", "null"] },
      contentHash: { type: "string" },
      assetId: { type: ["string", "null"] },
      status: {
        type: "string",
        enum: ["pending", "processing", "indexed", "failed"],
      },
      chunkCount: { type: ["number", "null"] },
      errorMessage: { type: ["string", "null"] },
      externalId: { type: ["string", "null"] },
      metadata: { type: ["object", "null"] },
    },
    required: ["sourceType", "contentHash", "status"],
  } as const,
  timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" },
  indexes: [
    "contentHash",
    "status",
  ],
  relations: {
    chunks: relation.hasMany("chunk", "documentId", "HAS_CHUNK"),
  },
});
