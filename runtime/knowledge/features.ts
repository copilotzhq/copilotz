import type { DurableContentInput } from "../content/index.ts";
import {
  defineFeature,
  type FeatureAction,
  type FeatureDefinition,
  type FeatureExecuteContext,
  type FeatureTransactionContext,
} from "../features/index.ts";
import {
  knowledgeChunkCollection,
  knowledgeDocumentCollection,
} from "./collections.ts";
import type {
  CompleteKnowledgeDocumentInput,
  KnowledgeChunk,
  KnowledgeDocument,
  KnowledgeSearchInput,
  KnowledgeSearchResult,
  MarkKnowledgeDocumentDuplicateInput,
} from "./types.ts";

export const KNOWLEDGE_FEATURE_ID = "copilotz.knowledge";

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

type DeleteDocumentResult = Readonly<
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

async function deleteDocumentChunks(
  tx: FeatureTransactionContext,
  documentId: string,
): Promise<void> {
  const chunks = tx.collection(knowledgeChunkCollection);
  let after: string | undefined;
  while (true) {
    const page = await chunks.list({
      where: { documentId },
      ...(after ? { after } : {}),
      limit: 1_000,
    }) as readonly KnowledgeChunk[];
    for (const chunk of page) {
      await chunks.delete({ id: chunk.id });
    }
    if (page.length < 1_000) break;
    after = page.at(-1)?.id;
    if (!after) break;
  }
}

async function listAllChunks(
  context: FeatureExecuteContext,
): Promise<readonly KnowledgeChunk[]> {
  const chunks = context.collection(knowledgeChunkCollection);
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
  context: FeatureExecuteContext,
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
  const documents = context.collection(knowledgeDocumentCollection);
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

async function beginIndex(
  input: unknown,
  context: FeatureExecuteContext,
): Promise<KnowledgeDocument> {
  const id = requireText(record(input).id, "Document ID");
  return await context.transaction(
    async (tx) =>
      await tx.collection(knowledgeDocumentCollection).commands.beginIndex({
        id,
      }) as KnowledgeDocument,
    { operationKey: `index:${id}:begin` },
  );
}

async function completeIndex(
  input: unknown,
  context: FeatureExecuteContext,
): Promise<KnowledgeDocument> {
  const data = completeIndexInput(input);
  return await context.transaction(async (tx) => {
    await deleteDocumentChunks(tx, data.id);
    const chunks = tx.collection(knowledgeChunkCollection);
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
    return await tx.collection(knowledgeDocumentCollection).commands
      .completeIndex({
        id: data.id,
        ...(data.title ? { title: data.title } : {}),
        mediaType: data.mediaType,
        contentHash: data.contentHash,
        source: data.source,
        chunkCount: data.chunks.length,
      }) as KnowledgeDocument;
  }, { operationKey: `index:${data.id}:complete` });
}

async function markDuplicate(
  input: unknown,
  context: FeatureExecuteContext,
): Promise<KnowledgeDocument> {
  const data = duplicateInput(input);
  return await context.transaction(async (tx) => {
    const canonical = await tx.collection(knowledgeDocumentCollection).get({
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
    await deleteDocumentChunks(tx, data.id);
    return await tx.collection(knowledgeDocumentCollection).commands
      .markDuplicate({
        id: data.id,
        duplicateOfDocumentId: data.duplicateOfDocumentId,
        source: data.source,
        mediaType: data.mediaType,
        contentHash: data.contentHash,
      }) as KnowledgeDocument;
  }, { operationKey: `index:${data.id}:duplicate` });
}

async function failIndex(
  input: unknown,
  context: FeatureExecuteContext,
): Promise<KnowledgeDocument> {
  const data = failIndexInput(input);
  return await context.transaction(
    async (tx) =>
      await tx.collection(knowledgeDocumentCollection).commands.failIndex({
        id: data.id,
        code: data.error.code,
        message: data.error.message,
      }) as KnowledgeDocument,
    { operationKey: `index:${data.id}:fail` },
  );
}

async function deleteDocument(
  input: unknown,
  context: FeatureExecuteContext,
): Promise<DeleteDocumentResult> {
  const data = record(input);
  const documentId = optional(data.documentId, "Document ID");
  const sourceUri = optional(data.sourceUri, "Document source URI");
  if (Boolean(documentId) === Boolean(sourceUri)) {
    throw new TypeError("Provide exactly one of documentId or sourceUri.");
  }
  return await context.transaction(async (tx) => {
    const document = documentId
      ? await tx.collections.document.get({ id: documentId })
      : (await tx.collections.document.queries.bySourceUri({
        sourceUri: sourceUri!,
      }))[0];
    if (!document) {
      return {
        success: false,
        message: documentId
          ? `Document with ID "${documentId}" not found.`
          : `Document with source "${sourceUri}" not found.`,
      };
    }
    const chunks = await tx.collections.chunk.list({
      where: { documentId: document.id },
      limit: 1_000,
    });
    for (const chunk of chunks) {
      await tx.collections.chunk.delete({ id: chunk.id });
    }
    await tx.collections.document.delete({ id: document.id });
    const title = String(document.title || document.sourceUri || document.id);
    return {
      success: true,
      message: `Document "${title}" deleted.`,
      documentId: document.id,
      title,
      namespace: document.namespace,
    };
  }, { operationKey: "delete_document" });
}

const deleteDocumentInputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    documentId: { type: "string" },
    sourceUri: { type: "string" },
  },
  oneOf: [{ required: ["documentId"] }, { required: ["sourceUri"] }],
} as const;

const deleteDocumentOutputSchema = {
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

const searchDocumentsInputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    embedding: {
      type: "array",
      items: { type: "number" },
      minItems: 1,
    },
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
    limit: { type: "integer", minimum: 1, maximum: 100, default: 100 },
    threshold: { type: "number", minimum: -1, maximum: 1, default: -1 },
  },
  required: ["embedding"],
} as const;

const searchDocumentsOutputSchema = {
  type: "array",
  items: {
    type: "object",
    additionalProperties: true,
    required: ["chunk", "document", "similarity"],
    properties: {
      chunk: { type: "object", additionalProperties: true },
      document: { type: "object", additionalProperties: true },
      similarity: { type: "number" },
    },
  },
} as const;

type KnowledgeFeature = FeatureDefinition<{
  beginIndex: FeatureAction<undefined, KnowledgeDocument>;
  completeIndex: FeatureAction<undefined, KnowledgeDocument>;
  markDuplicate: FeatureAction<undefined, KnowledgeDocument>;
  failIndex: FeatureAction<undefined, KnowledgeDocument>;
  searchDocuments: FeatureAction<
    typeof searchDocumentsInputSchema,
    readonly KnowledgeSearchResult[],
    typeof searchDocumentsOutputSchema
  >;
  deleteDocument: FeatureAction<
    typeof deleteDocumentInputSchema,
    DeleteDocumentResult,
    typeof deleteDocumentOutputSchema
  >;
}>;

const knowledgeFeatureDefinition: KnowledgeFeature = defineFeature({
  id: KNOWLEDGE_FEATURE_ID,
  actions: {
    beginIndex: { execute: beginIndex },
    completeIndex: { execute: completeIndex },
    markDuplicate: { execute: markDuplicate },
    failIndex: { execute: failIndex },
    searchDocuments: {
      inputSchema: searchDocumentsInputSchema,
      outputSchema: searchDocumentsOutputSchema,
      execute: searchDocuments,
    },
    deleteDocument: {
      inputSchema: deleteDocumentInputSchema,
      outputSchema: deleteDocumentOutputSchema,
      execute: deleteDocument,
    },
  },
});

export const knowledgeFeature: KnowledgeFeature = knowledgeFeatureDefinition;
