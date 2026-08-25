/** Shared private implementation for Knowledge Action owners. @module */

import { digestContent } from "@copilotz/copilotz/content";
import type {
  ContentInput,
  ContentKind,
  ContentRef,
  DurableContentInput,
} from "@copilotz/copilotz/content";
import type {
  ActionCallOptions,
  ActionContext,
} from "@copilotz/copilotz/actions";
import { chunkText } from "./chunker.ts";
import { embedKnowledgeTexts } from "../../resources/embedding/index.ts";
import type {
  CompleteKnowledgeDocumentInput,
  KnowledgeChunk,
  KnowledgeChunkingConfig,
  KnowledgeDocument,
  KnowledgeDocumentSourceInput,
  KnowledgeEmbeddingConfig,
  KnowledgeEmbeddingProviderResource,
  KnowledgeSearchInput,
  KnowledgeSearchResult,
  KnowledgeSourceLoader,
  KnowledgeTextExtractor,
  LoadedKnowledgeSource,
  MarkKnowledgeDocumentDuplicateInput,
} from "../../internal/types.ts";

export const INDEX_KNOWLEDGE_DOCUMENT_ACTION_ID =
  "copilotz.knowledge.indexDocument";
export const INGEST_KNOWLEDGE_DOCUMENT_ACTION_ID =
  "copilotz.knowledge.ingestDocument";
export const SEARCH_KNOWLEDGE_ACTION_ID = "copilotz.knowledge.searchDocuments";
export const DELETE_KNOWLEDGE_DOCUMENT_ACTION_ID =
  "copilotz.knowledge.deleteDocument";

export type KnowledgeActionContext =
  & Omit<ActionContext, "actions" | "adapters">
  & Readonly<{
    actions: Readonly<{
      createThreadMessage: (
        input: unknown,
        options?: ActionCallOptions,
      ) => Promise<unknown>;
    }>;
    adapters: Readonly<{
      embedding: Readonly<
        Record<string, KnowledgeEmbeddingProviderResource | undefined>
      >;
    }>;
  }>;

export type IndexKnowledgeDocumentInput = Readonly<{ id: string }>;
export type IngestKnowledgeDocumentInput = Readonly<{
  source?: string;
  assetId?: string;
  title?: string;
  externalId?: string;
  forceReindex?: boolean;
  metadata?: Readonly<Record<string, unknown>>;
}>;
export type IngestKnowledgeDocumentResult = Readonly<{
  status: "pending";
  message: string;
  documentId: string;
  source: string;
  title: string;
  namespace: string;
}>;
export type SearchKnowledgeActionInput = Readonly<{
  query: string;
  scope?: Omit<KnowledgeSearchInput, "namespace" | "embedding">["scope"];
  limit?: number;
  threshold?: number;
}>;
export type SearchKnowledgeActionResult = Readonly<{
  results: readonly Readonly<{
    content: string;
    score: number;
    source: string;
    namespace: string;
    documentId: string;
    chunkIndex: number;
  }>[];
  query: string;
  namespace: string;
  totalResults?: number;
  message?: string;
}>;
export type DeleteKnowledgeDocumentInput = Readonly<{
  documentId?: string;
  sourceUri?: string;
}>;

export type CreateIndexKnowledgeDocumentActionOptions = Readonly<{
  embedding: KnowledgeEmbeddingConfig;
  chunking: Required<KnowledgeChunkingConfig>;
  loader: KnowledgeSourceLoader;
  extractor: KnowledgeTextExtractor;
}>;

function record(value: unknown, name = "Input"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function optional(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${name} must be non-empty.`);
  }
  return value.trim();
}

function kind(mediaType: string): ContentKind {
  if (mediaType.startsWith("text/")) return "text";
  if (mediaType.startsWith("image/")) return "image";
  if (mediaType.startsWith("audio/")) return "audio";
  if (mediaType.startsWith("video/")) return "video";
  if (mediaType === "application/json") return "json";
  return "file";
}

function sourceTitle(
  input: Readonly<{
    title?: string;
    source?: string;
    assetId?: string;
  }>,
): string {
  if (input.title?.trim()) return input.title.trim();
  const source = input.source?.trim();
  if (!source || source.startsWith("text:")) return "Document";
  if (/^https?:\/\//i.test(source)) {
    try {
      const parsed = new URL(source);
      return parsed.pathname.split("/").filter(Boolean).at(-1) ||
        parsed.hostname;
    } catch {
      return source;
    }
  }
  return source.split(/[\\/]/).filter(Boolean).at(-1) || source ||
    input.assetId || "Document";
}

function sourceType(source: string | undefined, assetId: string | undefined) {
  if (assetId) return "asset" as const;
  if (!source || source.startsWith("text:")) return "text" as const;
  return /^https?:\/\//i.test(source) ? "url" as const : "file" as const;
}

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

export type DeleteKnowledgeDocumentResult = Readonly<
  | {
    success: true;
    message: string;
    documentId: string;
    title: string;
    namespace: string;
  }
  | {
    success: false;
    message: string;
  }
>;

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

function finiteVector(value: unknown, name: string): readonly number[] {
  if (
    !Array.isArray(value) || value.length === 0 ||
    value.some((item) => !Number.isFinite(item))
  ) {
    throw new TypeError(`${name} must be a non-empty finite vector.`);
  }
  return Object.freeze(value.map(Number));
}

function similarity(
  left: readonly number[],
  right: readonly number[],
): number {
  if (left.length !== right.length) return Number.NEGATIVE_INFINITY;
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftMagnitude += left[index] ** 2;
    rightMagnitude += right[index] ** 2;
  }
  if (leftMagnitude === 0 || rightMagnitude === 0) return 0;
  return dot / Math.sqrt(leftMagnitude * rightMagnitude);
}

function stringList(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) =>
    typeof item === "string" && item.trim() ? [item.trim()] : []
  );
}

function searchScope(
  value: unknown,
): Omit<KnowledgeSearchInput, "namespace" | "embedding">["scope"] {
  if (value === undefined) return undefined;
  const input = record(value, "Knowledge search scope");
  return Object.freeze({
    ...(optional(input.threadId, "Scope thread ID")
      ? { threadId: optional(input.threadId, "Scope thread ID") }
      : {}),
    ...(optional(input.agentId, "Scope agent ID")
      ? { agentId: optional(input.agentId, "Scope agent ID") }
      : {}),
    ...(stringList(input.knowledgeSpaceIds).length
      ? { knowledgeSpaceIds: stringList(input.knowledgeSpaceIds) }
      : {}),
    ...(stringList(input.documentIds).length
      ? { documentIds: stringList(input.documentIds) }
      : {}),
  });
}

function documentMatchesScope(
  document: KnowledgeDocument,
  scope: Omit<KnowledgeSearchInput, "namespace" | "embedding">["scope"],
): boolean {
  if (scope?.documentIds && !scope.documentIds.includes(document.id)) {
    return false;
  }
  if (document.threadId && document.threadId !== scope?.threadId) {
    return false;
  }
  const metadata = record(document.metadata, "Document metadata");
  const storedScope = metadata.scope === undefined
    ? {}
    : record(metadata.scope, "Document metadata scope");
  const agentIds = [
    ...stringList(storedScope.agentIds ?? metadata.agentIds),
    ...(
      typeof (storedScope.agentId ?? metadata.agentId) === "string"
        ? [String(storedScope.agentId ?? metadata.agentId).trim()]
        : []
    ),
  ].filter(Boolean);
  if (agentIds.length && !scope?.agentId?.trim()) return false;
  if (agentIds.length && !agentIds.includes(scope!.agentId!.trim())) {
    return false;
  }
  const documentSpaces = [
    ...stringList(
      storedScope.knowledgeSpaceIds ?? metadata.knowledgeSpaceIds,
    ),
    ...(
      typeof (storedScope.knowledgeSpaceId ?? metadata.knowledgeSpaceId) ===
          "string"
        ? [
          String(
            storedScope.knowledgeSpaceId ?? metadata.knowledgeSpaceId,
          ).trim(),
        ]
        : []
    ),
  ].filter(Boolean);
  if (documentSpaces.length) {
    const requested = new Set(scope?.knowledgeSpaceIds ?? []);
    if (!documentSpaces.some((id) => requested.has(id))) return false;
  }
  return true;
}

function boundedNumber(
  value: unknown,
  fallback: number,
  name: string,
  minimum: number,
  maximum: number,
): number {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(result) || result < minimum || result > maximum) {
    throw new TypeError(`${name} must be between ${minimum} and ${maximum}.`);
  }
  return result;
}

function boundedInteger(
  value: unknown,
  fallback: number,
  name: string,
  minimum: number,
  maximum: number,
): number {
  const result = boundedNumber(value, fallback, name, minimum, maximum);
  if (!Number.isSafeInteger(result)) {
    throw new TypeError(`${name} must be a safe integer.`);
  }
  return result;
}

function requireText(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${name} must be non-empty.`);
  }
  return value.trim();
}

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
      return Object.freeze({
        content: requireText(chunk.content, "Chunk content"),
        embedding: finiteVector(chunk.embedding, "Chunk embedding"),
        chunkIndex: nonNegativeInteger(chunk.chunkIndex, "Chunk index"),
        tokenCount: nonNegativeInteger(chunk.tokenCount, "Chunk token count"),
        startPosition: nonNegativeInteger(chunk.startPosition, "Chunk start"),
        endPosition: nonNegativeInteger(chunk.endPosition, "Chunk end"),
        metadata: chunk.metadata === undefined
          ? {}
          : structuredClone(record(chunk.metadata, "Chunk metadata")),
      });
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
  return Object.freeze({
    id: requireText(data.id, "Document ID"),
    title: optional(data.title, "Document title"),
    mediaType: requireText(data.mediaType, "Document media type"),
    contentHash: requireText(
      data.contentHash,
      "Document content hash",
    ) as `sha256:${string}`,
    source: data.source as DurableContentInput,
    chunks: Object.freeze(chunks),
  });
}

function duplicateInput(input: unknown): MarkDuplicateInput {
  const data = record(input);
  return Object.freeze({
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
  });
}

function failIndexInput(input: unknown): FailIndexInput {
  const data = record(input);
  const error = record(data.error, "Knowledge failure");
  return Object.freeze({
    id: requireText(data.id, "Document ID"),
    error: Object.freeze({
      code: requireText(error.code, "Knowledge failure code"),
      message: requireText(error.message, "Knowledge failure message"),
    }),
  });
}

async function listDocumentChunks(
  collections: ActionContext["collections"],
  documentId: string,
): Promise<readonly KnowledgeChunk[]> {
  const chunks = collections.chunk;
  const collected: KnowledgeChunk[] = [];
  let after: string | undefined;
  while (true) {
    const page = await chunks.list({
      where: { documentId },
      ...(after ? { after } : {}),
      limit: 1_000,
    }) as readonly KnowledgeChunk[];
    collected.push(...page);
    if (page.length < 1_000) break;
    after = page.at(-1)?.id;
    if (!after) break;
  }
  return Object.freeze(collected);
}

async function listAllChunks(
  context: Pick<ActionContext, "collections">,
): Promise<readonly KnowledgeChunk[]> {
  const chunks = context.collections.chunk;
  const collected: KnowledgeChunk[] = [];
  let after: string | undefined;
  while (true) {
    const page = await chunks.list({
      ...(after ? { after } : {}),
      limit: 1_000,
    }) as readonly KnowledgeChunk[];
    collected.push(...page);
    if (page.length < 1_000) break;
    after = page.at(-1)?.id;
    if (!after) break;
  }
  return Object.freeze(collected);
}

async function searchDocuments(
  input: unknown,
  context: ActionContext,
): Promise<readonly KnowledgeSearchResult[]> {
  const data = record(input);
  const embedding = finiteVector(data.embedding, "Knowledge query embedding");
  const scope = searchScope(data.scope);
  if (scope?.documentIds?.length === 0) return Object.freeze([]);
  const limit = boundedInteger(
    data.limit,
    100,
    "Knowledge result limit",
    1,
    100,
  );
  const threshold = boundedNumber(
    data.threshold,
    -1,
    "Knowledge similarity threshold",
    -1,
    1,
  );
  const documents = context.collections.document;
  const documentCache = new Map<string, KnowledgeDocument | null>();
  const results: KnowledgeSearchResult[] = [];
  for (const chunk of await listAllChunks(context)) {
    let document = documentCache.get(chunk.documentId);
    if (document === undefined) {
      document = await documents.get({ id: chunk.documentId }) as
        | KnowledgeDocument
        | null;
      documentCache.set(chunk.documentId, document);
    }
    if (!document || document.status !== "indexed") continue;
    if (!documentMatchesScope(document, scope)) continue;
    const score = similarity(
      embedding,
      finiteVector(chunk.embedding, "Chunk embedding"),
    );
    if (score < threshold) continue;
    results.push(Object.freeze({ chunk, document, similarity: score }));
  }
  results.sort((left, right) =>
    right.similarity - left.similarity ||
    left.chunk.documentId.localeCompare(right.chunk.documentId) ||
    left.chunk.chunkIndex - right.chunk.chunkIndex
  );
  return Object.freeze(results.slice(0, limit));
}

export async function searchKnowledge(
  raw: unknown,
  context: KnowledgeActionContext,
  embedding: KnowledgeEmbeddingConfig,
): Promise<SearchKnowledgeActionResult> {
  const input = record(raw);
  const query = requireText(input.query, "Knowledge query");
  const explicitScope = searchScope(input.scope);
  const actionMetadata = record(context.action.metadata, "Action metadata");
  const threadId = optional(actionMetadata.threadId, "Action thread ID");
  const agentId = optional(actionMetadata.agentId, "Action agent ID");
  const response = await embedKnowledgeTexts(
    { embeddings: context.adapters.embedding ?? Object.freeze({}) },
    embedding,
    [query],
    {
      signal: context.signal,
      idempotencyKey: `${context.operationKey}:knowledge-query`,
    },
  );
  const results = await searchDocuments({
    embedding: response.embeddings[0],
    scope: {
      ...explicitScope,
      ...(threadId ? { threadId } : {}),
      ...(agentId ? { agentId } : {}),
    },
    limit: boundedInteger(
      input.limit,
      5,
      "Knowledge result limit",
      1,
      20,
    ),
    threshold: boundedNumber(
      input.threshold,
      0.5,
      "Knowledge similarity threshold",
      -1,
      1,
    ),
  }, context);
  if (results.length === 0) {
    return Object.freeze({
      results: Object.freeze([]),
      message: "No relevant documents found for the query.",
      query,
      namespace: context.namespace,
    });
  }
  return Object.freeze({
    results: Object.freeze(results.map((result) =>
      Object.freeze({
        content: result.chunk.content,
        score: Math.round(result.similarity * 100) / 100,
        source: result.document.title || result.document.sourceUri || "Unknown",
        namespace: result.document.namespace,
        documentId: result.document.id,
        chunkIndex: result.chunk.chunkIndex,
      })
    )),
    query,
    namespace: context.namespace,
    totalResults: results.length,
  });
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
    return Object.freeze({
      bytes: resolved.bytes,
      mediaType: resolved.asset.mediaType,
      sourceType: document.sourceType,
      sourceUri: document.sourceUri,
      title: document.title,
    });
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

export async function indexDocument(
  input: unknown,
  context: KnowledgeActionContext,
  options: CreateIndexKnowledgeDocumentActionOptions,
): Promise<KnowledgeDocument> {
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
        { embeddings: context.adapters.embedding ?? Object.freeze({}) },
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
}

export async function ingestDocument(
  raw: unknown,
  context: ActionContext,
): Promise<IngestKnowledgeDocumentResult> {
  const input = record(raw);
  const source = optional(input.source, "Document source");
  const assetId = optional(input.assetId, "Document asset ID");
  if (Boolean(source) === Boolean(assetId)) {
    throw new TypeError("Provide exactly one of source or assetId.");
  }

  let sourceInput: KnowledgeDocumentSourceInput;
  let content: DurableContentInput = [];
  if (assetId) {
    const asset = await context.content.get(assetId);
    if (!asset) throw new Error(`Asset '${assetId}' was not found.`);
    const ref: ContentRef = Object.freeze({
      assetId,
      kind: kind(asset.mediaType),
      role: "document.source",
      mediaType: asset.mediaType,
    });
    sourceInput = {
      kind: "content",
      content: ref,
      sourceType: "asset",
      sourceUri: `asset:${assetId}`,
    };
    content = await context.content.prepare(ref, {
      operationKey: `${context.operationKey}:source`,
    });
  } else if (source!.startsWith("text:")) {
    const sourceContent: ContentInput = {
      type: "text",
      text: source!.slice("text:".length),
      role: "document.source",
    };
    sourceInput = {
      kind: "content",
      content: sourceContent,
      sourceType: "text",
    };
    content = await context.content.prepare(sourceContent, {
      operationKey: `${context.operationKey}:source`,
    });
  } else {
    sourceInput = { kind: "uri", uri: source! };
  }

  const actionMetadata = record(context.action.metadata, "Action metadata");
  const threadId = optional(actionMetadata.threadId, "Action thread ID");
  const agentId = optional(actionMetadata.agentId, "Action agent ID");
  const participantId = optional(
    actionMetadata.initiatorParticipantId,
    "Action initiator participant ID",
  );
  const suppliedMetadata = input.metadata === undefined
    ? {}
    : structuredClone(record(input.metadata, "Document metadata"));
  const suppliedScope = suppliedMetadata.scope === undefined
    ? {}
    : record(suppliedMetadata.scope, "Document metadata scope");
  const metadata = {
    ...suppliedMetadata,
    ...(threadId ? { threadId } : {}),
    ...(agentId ? { agentId } : {}),
    ...(participantId ? { initiatorParticipantId: participantId } : {}),
    scope: {
      ...suppliedScope,
      ...(threadId ? { threadId } : {}),
      ...(agentId ? { agentId } : {}),
      ...(participantId ? { initiatorParticipantId: participantId } : {}),
    },
  };
  const externalId = optional(input.externalId, "Document external ID");
  if (externalId && context.collections.document.queries.byExternalId) {
    const [existing] = await context.collections.document.queries.byExternalId({
      externalId,
    });
    if (existing) {
      throw new Error(`Document external ID '${externalId}' already exists.`);
    }
  }

  const documentId = `document:${context.action.runId}`;
  const title = sourceTitle({
    title: optional(input.title, "Document title"),
    source,
    assetId,
  });
  const created = await context.collections.document.create({
    id: documentId,
    sourceType: sourceType(source, assetId),
    sourceUri: sourceInput.kind === "uri"
      ? sourceInput.uri
      : sourceInput.sourceUri ?? (assetId ? `asset:${assetId}` : null),
    title,
    mediaType: null,
    contentHash: null,
    source: content,
    status: "pending",
    chunkCount: 0,
    duplicateOfDocumentId: null,
    threadId: threadId ?? null,
    requestedByParticipantId: participantId ?? null,
    forceReindex: input.forceReindex === true,
    error: null,
    externalId: externalId ?? null,
    metadata,
  }, { operationKey: `${context.operationKey}:document` });
  const createdTitle = String(created.title);
  return Object.freeze({
    status: "pending",
    message: `Document "${createdTitle}" accepted for ingestion.`,
    documentId: created.id,
    source: source ?? `asset:${assetId}`,
    title: createdTitle,
    namespace: context.namespace,
  });
}

export async function deleteDocument(
  input: unknown,
  context: KnowledgeActionContext,
): Promise<DeleteKnowledgeDocumentResult> {
  const data = record(input);
  const documentId = optional(data.documentId, "Document ID");
  const sourceUri = optional(data.sourceUri, "Document source URI");
  if (Boolean(documentId) === Boolean(sourceUri)) {
    throw new TypeError("Provide exactly one of documentId or sourceUri.");
  }
  const actionMetadata = record(context.action.metadata, "Action metadata");
  const threadId = optional(actionMetadata.threadId, "Action thread ID");
  const agentId = optional(actionMetadata.agentId, "Action agent ID");
  const candidates = [];
  if (documentId) {
    const exact = await context.collections.document.get({ id: documentId });
    if (exact) candidates.push(exact);
  } else {
    let after: string | undefined;
    while (true) {
      const page = await context.collections.document.list({
        where: { sourceUri: sourceUri! },
        order: { field: "id" },
        ...(after ? { after } : {}),
        limit: 1_000,
      });
      candidates.push(...page);
      if (page.length < 1_000) break;
      after = page.at(-1)!.id;
    }
    candidates.sort((left, right) =>
      String(right.createdAt).localeCompare(String(left.createdAt)) ||
      right.id.localeCompare(left.id)
    );
  }
  const document = candidates.find((candidate) =>
    !threadId && !agentId ||
    documentMatchesScope(candidate as KnowledgeDocument, {
      ...(threadId ? { threadId } : {}),
      ...(agentId ? { agentId } : {}),
    })
  );
  if (!document) {
    return {
      success: false,
      message: documentId
        ? `Document with ID "${documentId}" not found.`
        : `Document with source "${sourceUri}" not found.`,
    };
  }
  const chunks = await listDocumentChunks(
    context.collections,
    document.id,
  );
  await context.transaction(async (tx) => {
    for (const chunk of chunks) {
      await tx.collections.chunk.delete({ id: chunk.id });
    }
    await tx.collections.document.delete({ id: document.id });
  }, { operationKey: "delete_document" });
  const title = String(document.title || document.sourceUri || document.id);
  return {
    success: true,
    message: `Document "${title}" deleted.`,
    documentId: document.id,
    title,
    namespace: document.namespace,
  };
}

export const deleteDocumentInputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    documentId: { type: "string" },
    sourceUri: { type: "string" },
  },
  oneOf: [{ required: ["documentId"] }, { required: ["sourceUri"] }],
} as const;

export const deleteDocumentOutputSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    success: { type: "boolean" },
    message: { type: "string" },
    documentId: { type: "string" },
    title: { type: "string" },
    namespace: { type: "string" },
  },
  required: ["success", "message"],
} as const;

export const ingestDocumentInputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    source: { type: "string" },
    assetId: { type: "string" },
    title: { type: "string" },
    externalId: { type: "string" },
    forceReindex: { type: "boolean", default: false },
    metadata: { type: "object", additionalProperties: true },
  },
  oneOf: [{ required: ["source"] }, { required: ["assetId"] }],
} as const;

export const ingestDocumentOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: { const: "pending" },
    message: { type: "string" },
    documentId: { type: "string" },
    source: { type: "string" },
    title: { type: "string" },
    namespace: { type: "string" },
  },
  required: [
    "status",
    "message",
    "documentId",
    "source",
    "title",
    "namespace",
  ],
} as const;

export const searchKnowledgeInputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    query: { type: "string", minLength: 1 },
    scope: {
      type: "object",
      additionalProperties: false,
      properties: {
        threadId: { type: "string" },
        agentId: { type: "string" },
        knowledgeSpaceIds: { type: "array", items: { type: "string" } },
        documentIds: { type: "array", items: { type: "string" } },
      },
    },
    limit: { type: "integer", minimum: 1, maximum: 20, default: 5 },
    threshold: { type: "number", minimum: -1, maximum: 1, default: 0.5 },
  },
  required: ["query"],
} as const;

export const searchKnowledgeOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          content: { type: "string" },
          score: { type: "number" },
          source: { type: "string" },
          namespace: { type: "string" },
          documentId: { type: "string" },
          chunkIndex: { type: "integer", minimum: 0 },
        },
        required: [
          "content",
          "score",
          "source",
          "namespace",
          "documentId",
          "chunkIndex",
        ],
      },
    },
    query: { type: "string" },
    namespace: { type: "string" },
    totalResults: { type: "integer", minimum: 0 },
    message: { type: "string" },
  },
  required: ["results", "query", "namespace"],
} as const;

export const indexKnowledgeDocumentInputSchema = {
  type: "object",
  additionalProperties: false,
  properties: { id: { type: "string" } },
  required: ["id"],
} as const;
