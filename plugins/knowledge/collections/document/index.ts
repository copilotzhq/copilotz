/** Defines the canonical Knowledge document Collection. @module */

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

const schema = {
  type: "object",
  properties: {
    id: { type: "string" },
    sourceType: { type: "string", enum: ["url", "file", "text", "asset"] },
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

/** Holds source metadata and the indexing state of one Knowledge document. */
export const knowledgeDocumentCollection: CollectionDefinition<typeof schema> =
  defineCollection({
    name: KNOWLEDGE_DOCUMENT_COLLECTION,
    schema: schema,
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
