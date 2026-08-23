/** Knowledge graph state and mutation semantics. */
import {
  type CollectionDefinition,
  defineCollection,
  relation,
} from "@copilotz/copilotz/collections";

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

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function requireMutable(status: unknown, id: unknown): void {
  if (status === "indexed" || status === "duplicate") {
    throw new Error(`Knowledge document '${String(id)}' is already settled.`);
  }
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

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
    thread: relation.belongsTo("thread", "threadId", "has_document"),
    chunks: relation.hasMany(
      KNOWLEDGE_CHUNK_COLLECTION,
      "documentId",
      KNOWLEDGE_HAS_CHUNK_EDGE,
    ),
  },
  content: { fields: ["source"] },
  queries: {
    byExternalId: {
      query({ input }) {
        return {
          where: { externalId: String(input.externalId ?? "") },
          limit: 1,
        };
      },
    },
    byContentHash: {
      query({ input }) {
        return {
          where: {
            contentHash: String(input.contentHash ?? ""),
            status: "indexed",
          },
          order: { field: "createdAt" },
          limit: 1,
        };
      },
    },
  },
  commands: {
    beginIndex: {
      event: "document.processing",
      mutate({ current }) {
        requireMutable(current.status, current.id);
        return { set: { status: "processing", error: null } };
      },
    },
    completeIndex: {
      event: "document.indexed",
      mutate({ current, input }) {
        requireMutable(current.status, current.id);
        const body = asRecord(input);
        return {
          set: {
            ...(text(body.title) ? { title: text(body.title) } : {}),
            mediaType: text(body.mediaType) ?? null,
            contentHash: text(body.contentHash) ?? null,
            source: Array.isArray(body.source) || body.source
              ? body.source
              : [],
            status: "indexed",
            chunkCount: Number(body.chunkCount ?? 0),
            duplicateOfDocumentId: null,
            error: null,
          },
        };
      },
    },
    markDuplicate: {
      event: "document.duplicate",
      mutate({ current, input }) {
        requireMutable(current.status, current.id);
        const body = asRecord(input);
        return {
          set: {
            mediaType: text(body.mediaType) ?? null,
            contentHash: text(body.contentHash) ?? null,
            source: Array.isArray(body.source) || body.source
              ? body.source
              : [],
            status: "duplicate",
            chunkCount: 0,
            duplicateOfDocumentId: text(body.duplicateOfDocumentId) ?? null,
            error: null,
          },
        };
      },
    },
    failIndex: {
      event: "document.failed",
      mutate({ input }) {
        const body = asRecord(input);
        return {
          set: {
            status: "failed",
            error: {
              code: text(body.code) ?? "knowledge_index_failed",
              message: text(body.message) ?? "Knowledge indexing failed.",
            },
          },
        };
      },
    },
  },
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
