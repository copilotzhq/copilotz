import { knowledgeConfig } from "../../internal/config.ts";
import {
  defaultKnowledgeSourceLoader,
  defaultKnowledgeTextExtractor,
} from "../../authoring/source/index.ts";
/** Owns the index-document Knowledge Action. @module */
import {
  digestContent,
  type DurableContentInput,
} from "@copilotz/copilotz/content";

import { chunkText } from "../internal/chunker.ts";
import { embedKnowledgeTexts } from "../../resources/embedding/index.ts";
import type {
  CompleteKnowledgeDocumentInput,
  KnowledgeDocument,
  KnowledgeSourceLoader,
  LoadedKnowledgeSource,
  MarkKnowledgeDocumentDuplicateInput,
} from "../../internal/types.ts";
import {
  type ActionDefinition,
  defineAction,
} from "@copilotz/copilotz/actions";
import type { KnowledgeActionContext } from "../internal/context.ts";
import {
  finiteVector,
  optional,
  record,
  requireText,
} from "../internal/input.ts";
import { listDocumentChunks } from "../internal/records.ts";
export const INDEX_KNOWLEDGE_DOCUMENT_ACTION_ID =
  "copilotz.knowledge.indexDocument";

export type IndexKnowledgeDocumentInput = Readonly<{ id: string }>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string {
  if (error instanceof TypeError) return "knowledge_input_invalid";
  if (error instanceof DOMException && error.name === "AbortError") {
    return "knowledge_cancelled";
  }
  return "knowledge_index_failed";
}

type CompleteIndexInput = Omit<
  CompleteKnowledgeDocumentInput,
  "namespace" | "identity"
>;

type MarkDuplicateInput = Omit<
  MarkKnowledgeDocumentDuplicateInput,
  "namespace" | "identity"
>;

type FailIndexInput = Readonly<{
  id: string;
  error: Readonly<{ code: string; message: string }>;
}>;

function nonNegativeInteger(value: unknown, name: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new TypeError(`${name} must be a non-negative integer.`);
  }
  return result;
}

function completeIndexInput(input: unknown): CompleteIndexInput {
  const data = record(input);
  const chunks = Array.isArray(data.chunks)
    ? data.chunks.map((candidate) => {
      const chunk = record(candidate, "Knowledge chunk");
      return ({
        content: requireText(chunk.content, "Chunk content"),
        embedding: finiteVector(chunk.embedding, "Chunk embedding"),
        chunkIndex: nonNegativeInteger(chunk.chunkIndex, "Chunk index"),
        tokenCount: nonNegativeInteger(chunk.tokenCount, "Chunk token count"),
        startPosition: nonNegativeInteger(chunk.startPosition, "Chunk start"),
        endPosition: nonNegativeInteger(chunk.endPosition, "Chunk end"),
        metadata: chunk.metadata === undefined
          ? {}
          : structuredClone(record(chunk.metadata, "Chunk metadata")),
      } as const);
    })
    : [];
  if (chunks.length === 0) {
    throw new TypeError("An indexed document must contain at least one chunk.");
  }
  const dimensions = chunks[0].embedding.length;
  chunks.forEach((chunk, index) => {
    if (chunk.chunkIndex !== index) {
      throw new TypeError("Chunk indexes must be contiguous from zero.");
    }
    if (chunk.endPosition < chunk.startPosition) {
      throw new TypeError("Chunk end cannot precede its start.");
    }
    if (chunk.embedding.length !== dimensions) {
      throw new TypeError(
        "Every document chunk must use the same dimensions.",
      );
    }
  });
  return ({
    id: requireText(data.id, "Document ID"),
    title: optional(data.title, "Document title"),
    mediaType: requireText(data.mediaType, "Document media type"),
    contentHash: requireText(
      data.contentHash,
      "Document content hash",
    ) as `sha256:${string}`,
    source: data.source as DurableContentInput,
    chunks: chunks,
  } as const);
}

function duplicateInput(input: unknown): MarkDuplicateInput {
  const data = record(input);
  return ({
    id: requireText(data.id, "Document ID"),
    duplicateOfDocumentId: requireText(
      data.duplicateOfDocumentId,
      "Canonical document ID",
    ),
    source: data.source as DurableContentInput,
    mediaType: requireText(data.mediaType, "Document media type"),
    contentHash: requireText(
      data.contentHash,
      "Document content hash",
    ) as `sha256:${string}`,
  } as const);
}

function failIndexInput(input: unknown): FailIndexInput {
  const data = record(input);
  const error = record(data.error, "Knowledge failure");
  return ({
    id: requireText(data.id, "Document ID"),
    error: {
      code: requireText(error.code, "Knowledge failure code"),
      message: requireText(error.message, "Knowledge failure message"),
    } as const,
  } as const);
}

async function beginIndex(
  input: unknown,
  context: KnowledgeActionContext,
): Promise<KnowledgeDocument> {
  const id = requireText(record(input).id, "Document ID");
  const ref = await context.transaction(
    (tx) =>
      tx.collections.document.commands.beginIndex({
        id,
      }),
    { operationKey: `index:${id}:begin` },
  );
  const document = await context.collections.document.get({ id: ref.id });
  if (!document) throw new Error(`Knowledge document '${ref.id}' is missing.`);
  return document as KnowledgeDocument;
}

async function completeIndex(
  input: unknown,
  context: KnowledgeActionContext,
): Promise<KnowledgeDocument> {
  const data = completeIndexInput(input);
  const previousChunks = await listDocumentChunks(context.collections, data.id);
  const ref = await context.transaction(async (tx) => {
    for (const chunk of previousChunks) {
      await tx.collections.chunk.delete({ id: chunk.id });
    }
    const chunks = tx.collections.chunk;
    for (const chunk of data.chunks) {
      await chunks.create({
        id: `${data.id}:chunk:${chunk.chunkIndex}`,
        documentId: data.id,
        chunkIndex: chunk.chunkIndex,
        content: chunk.content,
        tokenCount: chunk.tokenCount,
        embedding: chunk.embedding,
        startPosition: chunk.startPosition,
        endPosition: chunk.endPosition,
        metadata: chunk.metadata,
      }, { operationKey: `index:${data.id}:chunk:${chunk.chunkIndex}` });
    }
    return await tx.collections.document.commands.completeIndex({
      id: data.id,
      ...(data.title ? { title: data.title } : {}),
      mediaType: data.mediaType,
      contentHash: data.contentHash,
      source: data.source,
      chunkCount: data.chunks.length,
    });
  }, { operationKey: `index:${data.id}:complete` });
  const document = await context.collections.document.get({ id: ref.id });
  if (!document) throw new Error(`Knowledge document '${ref.id}' is missing.`);
  return document as KnowledgeDocument;
}

async function markDuplicate(
  input: unknown,
  context: KnowledgeActionContext,
): Promise<KnowledgeDocument> {
  const data = duplicateInput(input);
  const canonical = await context.collections.document.get({
    id: data.duplicateOfDocumentId,
  }) as KnowledgeDocument | null;
  if (!canonical || canonical.status !== "indexed") {
    throw new Error(
      `Canonical knowledge document '${data.duplicateOfDocumentId}' is not indexed.`,
    );
  }
  if (
    canonical.contentHash !== data.contentHash ||
    canonical.mediaType !== data.mediaType
  ) {
    throw new Error(
      "Duplicate metadata does not match the canonical document.",
    );
  }
  const previousChunks = await listDocumentChunks(context.collections, data.id);
  const ref = await context.transaction(async (tx) => {
    for (const chunk of previousChunks) {
      await tx.collections.chunk.delete({ id: chunk.id });
    }
    return await tx.collections.document.commands.markDuplicate({
      id: data.id,
      duplicateOfDocumentId: data.duplicateOfDocumentId,
      source: data.source,
      mediaType: data.mediaType,
      contentHash: data.contentHash,
    });
  }, { operationKey: `index:${data.id}:duplicate` });
  const document = await context.collections.document.get({ id: ref.id });
  if (!document) throw new Error(`Knowledge document '${ref.id}' is missing.`);
  return document as KnowledgeDocument;
}

async function failIndex(
  input: unknown,
  context: KnowledgeActionContext,
): Promise<KnowledgeDocument> {
  const data = failIndexInput(input);
  const ref = await context.transaction(
    (tx) =>
      tx.collections.document.commands.failIndex({
        id: data.id,
        code: data.error.code,
        message: data.error.message,
      }),
    { operationKey: `index:${data.id}:fail` },
  );
  const document = await context.collections.document.get({ id: ref.id });
  if (!document) throw new Error(`Knowledge document '${ref.id}' is missing.`);
  return document as KnowledgeDocument;
}

function actionSignal(context: KnowledgeActionContext): AbortSignal {
  return context.signal ?? new AbortController().signal;
}

async function loadSource(
  document: KnowledgeDocument,
  context: KnowledgeActionContext,
  loader: KnowledgeSourceLoader,
): Promise<LoadedKnowledgeSource> {
  if (document.source.length) {
    if (document.source.length !== 1) {
      throw new Error(`Document '${document.id}' has multiple source assets.`);
    }
    const [resolved] = await context.content.resolveMany(document.source);
    return ({
      bytes: resolved.bytes,
      mediaType: resolved.asset.mediaType,
      sourceType: document.sourceType,
      sourceUri: document.sourceUri,
      title: document.title,
    } as const);
  }
  return await loader({
    document,
    signal: actionSignal(context),
    idempotencyKey: `${context.operationKey}:knowledge-source`,
  });
}

async function announce(
  context: KnowledgeActionContext,
  document: KnowledgeDocument,
  input: Readonly<{
    status: "indexed" | "duplicate" | "failed";
    message: string;
    metadata?: Record<string, unknown>;
  }>,
): Promise<void> {
  if (!document.threadId) return;
  const threads = context.collections.thread;
  if (!threads || !await threads.get({ id: document.threadId })) return;
  const createMessage = context.actions.createThreadMessage;
  if (typeof createMessage !== "function") return;
  const messageId = `${document.id}:knowledge:${input.status}`;
  await createMessage({
    id: messageId,
    threadId: document.threadId,
    sender: {
      externalId: "copilotz.knowledge",
      participantType: "job",
      name: "RAG",
    },
    recipientIds: [],
    content: {
      type: "text",
      text: input.message,
      role: "body",
    },
    visibility: { kind: "public" },
    metadata: {
      knowledgeResult: {
        documentId: document.id,
        title: document.title,
        status: input.status,
        ...structuredClone(input.metadata ?? {}),
      },
    },
  }, { operationKey: `announce:${document.id}:${input.status}` });
}

const indexKnowledgeDocumentInputSchema = {
  type: "object",
  additionalProperties: false,
  properties: { id: { type: "string" } },
  required: ["id"],
} as const;

/** Defines one durable action for indexing a queued Knowledge document. */

export const indexKnowledgeDocumentAction: ActionDefinition<
  IndexKnowledgeDocumentInput,
  KnowledgeDocument,
  KnowledgeActionContext,
  typeof indexKnowledgeDocumentInputSchema,
  undefined
> = defineAction<
  IndexKnowledgeDocumentInput,
  KnowledgeDocument,
  KnowledgeActionContext,
  typeof indexKnowledgeDocumentInputSchema
>({
  id: INDEX_KNOWLEDGE_DOCUMENT_ACTION_ID,
  inputSchema: indexKnowledgeDocumentInputSchema,
  async execute(input, context: KnowledgeActionContext) {
    const options = {
      ...knowledgeConfig(context),
      loader: context.adapters.knowledge?.loader ??
        defaultKnowledgeSourceLoader,
      extractor: context.adapters.knowledge?.extractor ??
        defaultKnowledgeTextExtractor,
    };
    const id = requireText(record(input).id, "Document ID");
    let document = await context.collections.document.get({ id }) as
      | KnowledgeDocument
      | null;
    if (!document) throw new Error(`Knowledge document '${id}' vanished.`);
    let settled = false;
    try {
      document = await beginIndex({ id }, context);
      const loaded = await loadSource(document, context, options.loader);
      actionSignal(context).throwIfAborted();
      const text = (await options.extractor({
        bytes: loaded.bytes,
        mediaType: loaded.mediaType,
        signal: actionSignal(context),
      })).trim();
      if (!text) throw new Error("Document has no text to index.");
      const hash = await digestContent(loaded.bytes);
      const canonical = document.forceReindex
        ? null
        : (await context.collections.document.queries.byContentHash({
          contentHash: hash,
        }))[0] as KnowledgeDocument | undefined;
      if (canonical && canonical.id !== document.id) {
        document = await markDuplicate({
          id,
          duplicateOfDocumentId: canonical.id,
          source: canonical.source,
          mediaType: canonical.mediaType ?? loaded.mediaType,
          contentHash: hash,
        }, context);
        settled = true;
        await announce(context, document, {
          status: "duplicate",
          message: `Document "${document.title}" already indexed (hash: ${
            hash.slice(7, 15)
          }...).`,
          metadata: { duplicateOfDocumentId: canonical.id },
        }).catch(() => undefined);
        return document;
      }

      const chunks = chunkText(text, options.chunking);
      if (chunks.length === 0) {
        throw new Error("Document has no content to index.");
      }
      const vectors: (readonly number[])[] = [];
      const batchSize = options.embedding.batchSize!;
      let model = options.embedding.model;
      let dimensions = options.embedding.dimensions;
      for (let offset = 0; offset < chunks.length; offset += batchSize) {
        actionSignal(context).throwIfAborted();
        const batch = chunks.slice(offset, offset + batchSize);
        const response = await embedKnowledgeTexts(
          { embeddings: context.adapters.embedding ?? ({} as const) },
          options.embedding,
          batch.map((item) => item.content),
          {
            signal: actionSignal(context),
            idempotencyKey: `${context.operationKey}:knowledge-embed:${offset}`,
          },
        );
        vectors.push(...response.embeddings);
        model = response.model;
        dimensions = response.dimensions;
      }
      const source = document.source.length
        ? document.source
        : await context.content.prepare({
          type: "file",
          bytes: loaded.bytes,
          mediaType: loaded.mediaType,
          role: "document.source",
          ...(loaded.title ? { name: loaded.title } : {}),
        }, { operationKey: `index:${id}:source` });
      document = await completeIndex({
        id,
        title: loaded.title ?? document.title,
        mediaType: loaded.mediaType,
        contentHash: hash,
        source,
        chunks: chunks.map((chunk, index) => ({
          content: chunk.content,
          embedding: vectors[index],
          chunkIndex: chunk.metadata.chunkIndex,
          tokenCount: chunk.metadata.tokenCount,
          startPosition: chunk.metadata.startPosition,
          endPosition: chunk.metadata.endPosition,
          metadata: {
            ...(model ? { embeddingModel: model } : {}),
            ...(dimensions ? { embeddingDimensions: dimensions } : {}),
          },
        })),
      }, context);
      settled = true;
      await announce(context, document, {
        status: "indexed",
        message:
          `Successfully indexed "${document.title}" (${document.chunkCount} chunks).`,
        metadata: { chunks: document.chunkCount },
      }).catch(() => undefined);
      return document;
    } catch (error) {
      if (!settled) {
        const failed = await failIndex({
          id,
          error: { code: errorCode(error), message: errorMessage(error) },
        }, context).catch(() => undefined);
        document = failed ?? document;
        await announce(context, document, {
          status: "failed",
          message: `Failed to ingest document: ${errorMessage(error)}`,
        }).catch(() => undefined);
      }
      throw error;
    }
  },
});

export type IndexKnowledgeDocumentAction = typeof indexKnowledgeDocumentAction;

export default indexKnowledgeDocumentAction;
