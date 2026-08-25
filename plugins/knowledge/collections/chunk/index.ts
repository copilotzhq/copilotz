/** Defines the searchable Knowledge chunk Collection. @module */

import {
  type CollectionDefinition,
  defineCollection,
  relation,
} from "@copilotz/copilotz/collections";
import {
  KNOWLEDGE_CHUNK_COLLECTION,
  KNOWLEDGE_DOCUMENT_COLLECTION,
  KNOWLEDGE_HAS_CHUNK_EDGE,
} from "../internal/contracts.ts";

const schema = {
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

/** Holds one embedding-backed searchable segment derived from a document. */
export const knowledgeChunkCollection: CollectionDefinition<typeof schema> =
  defineCollection({
    name: KNOWLEDGE_CHUNK_COLLECTION,
    schema: schema,
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
