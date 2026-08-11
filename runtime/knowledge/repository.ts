import type { ContentInput, ContentSequence } from "../content/index.ts";
import type { SqlExecutor } from "../events/index.ts";
import {
  KNOWLEDGE_CHUNK_COLLECTION,
  KNOWLEDGE_DERIVED_FROM_EDGE,
  KNOWLEDGE_DOCUMENT_COLLECTION,
  KNOWLEDGE_HAS_CHUNK_EDGE,
} from "./collections.ts";
import type {
  CreateKnowledgeDocumentInput,
  CreateKnowledgeRepositoryOptions,
  KnowledgeChunk,
  KnowledgeDocument,
  KnowledgeDocumentSourceType,
  KnowledgeDocumentStatus,
  KnowledgeRepository,
  KnowledgeSearchInput,
  KnowledgeSearchResult,
} from "./types.ts";

type NodeRow = Readonly<{
  id: string;
  namespace: string;
  type: string;
  name: string;
  data: unknown;
  created_at: string | Date;
  updated_at: string | Date;
}>;

function record(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      return record(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function required(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${name} must be non-empty.`);
  }
  return value.trim();
}

function optional(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return required(value, name);
}

function iso(value: string | Date): string {
  const result = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(result.getTime())) {
    throw new Error("Invalid stored timestamp.");
  }
  return result.toISOString();
}

function status(value: unknown): KnowledgeDocumentStatus {
  if (
    value === "pending" || value === "processing" || value === "indexed" ||
    value === "duplicate" || value === "failed"
  ) return value;
  throw new Error(`Invalid knowledge document status '${String(value)}'.`);
}

function sourceType(value: unknown): KnowledgeDocumentSourceType {
  if (
    value === "url" || value === "file" || value === "text" || value === "asset"
  ) return value;
  throw new Error(`Invalid knowledge source type '${String(value)}'.`);
}

function nonNegativeInteger(value: unknown, name: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return result;
}

function finiteVector(value: unknown, name: string): readonly number[] {
  if (
    !Array.isArray(value) || value.length === 0 ||
    value.some((item) => !Number.isFinite(item))
  ) throw new Error(`${name} must be a non-empty finite vector.`);
  return Object.freeze(value.map(Number));
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function documentFromRow(row: NodeRow): KnowledgeDocument {
  const data = record(row.data);
  const storedError = data.error == null ? null : record(data.error);
  return deepFreeze({
    ...data,
    id: row.id,
    namespace: row.namespace,
    sourceType: sourceType(data.sourceType),
    sourceUri: optional(data.sourceUri, "Stored source URI") ?? null,
    title: required(data.title ?? row.name, "Stored document title"),
    mediaType: optional(data.mediaType, "Stored media type") ?? null,
    contentHash: optional(data.contentHash, "Stored content hash") ?? null,
    source: Array.isArray(data.source)
      ? structuredClone(data.source) as ContentSequence
      : [],
    status: status(data.status),
    chunkCount: nonNegativeInteger(data.chunkCount ?? 0, "Stored chunk count"),
    duplicateOfDocumentId:
      optional(data.duplicateOfDocumentId, "Stored duplicate ID") ?? null,
    threadId: optional(data.threadId, "Stored thread ID") ?? null,
    requestedByParticipantId:
      optional(data.requestedByParticipantId, "Stored requester ID") ?? null,
    forceReindex: data.forceReindex === true,
    error: storedError
      ? {
        code: required(storedError.code, "Stored error code"),
        message: required(storedError.message, "Stored error message"),
      }
      : null,
    externalId: optional(data.externalId, "Stored external ID") ?? null,
    metadata: record(data.metadata),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }) as KnowledgeDocument;
}

function chunkFromRow(row: NodeRow): KnowledgeChunk {
  const data = record(row.data);
  return deepFreeze({
    ...data,
    id: row.id,
    namespace: row.namespace,
    documentId: required(data.documentId, "Stored chunk document ID"),
    chunkIndex: nonNegativeInteger(data.chunkIndex, "Stored chunk index"),
    content: required(data.content, "Stored chunk content"),
    tokenCount: nonNegativeInteger(data.tokenCount, "Stored token count"),
    embedding: finiteVector(data.embedding, "Stored embedding"),
    startPosition: nonNegativeInteger(data.startPosition, "Stored start"),
    endPosition: nonNegativeInteger(data.endPosition, "Stored end"),
    metadata: record(data.metadata),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }) as KnowledgeChunk;
}

function defaultCreateId(): string {
  if (!globalThis.crypto?.randomUUID) {
    throw new Error("Web Crypto randomUUID is required for knowledge records.");
  }
  return crypto.randomUUID();
}

function stableId(
  namespace: string,
  input: CreateKnowledgeDocumentInput,
  createId: () => string,
): string {
  if (input.id?.trim()) return input.id.trim();
  if (input.identity?.deduplicationId?.trim()) {
    return `${namespace}:document:${input.identity.deduplicationId.trim()}`;
  }
  return createId();
}

function identityFields(identity: CreateKnowledgeDocumentInput["identity"]) {
  return {
    ...(identity?.causationId?.trim()
      ? { causationId: identity.causationId.trim() }
      : {}),
    ...(identity?.correlationId?.trim()
      ? { correlationId: identity.correlationId.trim() }
      : {}),
    ...(identity?.deduplicationId?.trim()
      ? { deduplicationId: identity.deduplicationId.trim() }
      : {}),
    metadata: structuredClone(identity?.metadata ?? {}),
  };
}

function sourceContent(value: ContentInput): ContentInput {
  return typeof value === "string"
    ? { type: "text", text: value, role: "document.source" }
    : { ...structuredClone(value), role: "document.source" } as ContentInput;
}

function singleSource(value: ContentSequence): ContentSequence {
  if (value.length !== 1 || value[0].role !== "document.source") {
    throw new TypeError(
      "A knowledge document requires exactly one document.source asset.",
    );
  }
  return value;
}

function inferredTitle(input: CreateKnowledgeDocumentInput): string {
  if (input.title?.trim()) return input.title.trim();
  if (input.source.kind !== "uri") return "Document";
  const uri = input.source.uri.trim();
  if (/^https?:\/\//i.test(uri)) {
    try {
      const parsed = new URL(uri);
      return parsed.pathname.split("/").filter(Boolean).at(-1) ||
        parsed.hostname;
    } catch {
      // URI validation in create() reports the malformed input.
    }
  }
  return uri.replaceAll("\\", "/").split("/").filter(Boolean).at(-1) ||
    "Document";
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function node(
  executor: SqlExecutor,
  table: string,
  namespace: string,
  id: string,
  type: string,
  lock = false,
): Promise<NodeRow | null> {
  const result = await executor.query<NodeRow>(
    `SELECT id, namespace, type, name, data, created_at, updated_at
     FROM ${table}
     WHERE namespace = $1 AND id = $2 AND type = $3
     LIMIT 1${lock ? " FOR UPDATE" : ""}`,
    [namespace, id, type],
  );
  return result.rows[0] ?? null;
}

async function requiredDocument(
  executor: SqlExecutor,
  table: string,
  namespace: string,
  id: string,
  lock = false,
): Promise<KnowledgeDocument> {
  const row = await node(
    executor,
    table,
    namespace,
    id,
    KNOWLEDGE_DOCUMENT_COLLECTION,
    lock,
  );
  if (!row) throw new Error(`Knowledge document '${id}' was not found.`);
  return documentFromRow(row);
}

function positiveLimit(value: number | undefined, maximum = 1_000): number {
  const result = value ?? 100;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) {
    throw new TypeError(`Limit must be between 1 and ${maximum}.`);
  }
  return result;
}

function contentHash(value: string): `sha256:${string}` {
  const normalized = required(value, "Document content hash");
  if (!/^sha256:[0-9a-f]{64}$/i.test(normalized)) {
    throw new TypeError("Document content hash must be a SHA-256 digest.");
  }
  return normalized.toLowerCase() as `sha256:${string}`;
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

function documentMatchesScope(
  document: KnowledgeDocument,
  scope: KnowledgeSearchInput["scope"],
): boolean {
  if (
    scope?.documentIds &&
    !scope.documentIds.includes(document.id)
  ) return false;

  if (document.threadId && document.threadId !== scope?.threadId) return false;

  const metadata = record(document.metadata);
  const storedScope = record(metadata.scope);
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

/** Creates the typed document/chunk aggregate over the four-table v3 schema. */
export function createKnowledgeRepository(
  options: CreateKnowledgeRepositoryOptions,
): KnowledgeRepository {
  const tables = options.eventStore.tables;
  const createId = options.createId ?? defaultCreateId;
  const now = options.now ?? (() => new Date());

  const get = async (namespaceInput: string, idInput: string) => {
    const namespace = required(namespaceInput, "Namespace");
    const id = required(idInput, "Document ID");
    const row = await node(
      options.session,
      tables.nodes,
      namespace,
      id,
      KNOWLEDGE_DOCUMENT_COLLECTION,
    );
    return row ? documentFromRow(row) : null;
  };

  const create: KnowledgeRepository["create"] = async (input) => {
    const namespace = required(input.namespace, "Namespace");
    const id = stableId(namespace, input, createId);
    const title = inferredTitle(input);
    const threadId = optional(input.threadId, "Thread ID");
    const requesterId = optional(
      input.requestedByParticipantId,
      "Requester participant ID",
    );
    const externalId = optional(input.externalId, "Document external ID");
    const sourceUri = input.source.kind === "uri"
      ? required(input.source.uri, "Document source URI")
      : optional(input.source.sourceUri, "Document source URI");
    const inferredSourceType: KnowledgeDocumentSourceType =
      input.source.kind === "uri"
        ? input.source.sourceType ??
          (/^https?:\/\//i.test(sourceUri!) ? "url" : "file")
        : input.source.sourceType ?? "text";
    const sourceKey = input.identity?.deduplicationId ??
      "document:" + id;
    const prepared = input.source.kind === "content"
      ? await options.preparer.prepare(sourceContent(input.source.content), {
        namespace,
        idempotencyKey: sourceKey + ":source",
      })
      : undefined;
    const timestamp = now().toISOString();
    const baseData = {
      sourceType: inferredSourceType,
      sourceUri: sourceUri ?? null,
      title,
      mediaType: null,
      contentHash: null,
      source: prepared ?? [],
      status: "pending",
      chunkCount: 0,
      duplicateOfDocumentId: null,
      threadId: threadId ?? null,
      requestedByParticipantId: requesterId ?? null,
      forceReindex: input.forceReindex === true,
      error: null,
      externalId: externalId ?? null,
      metadata: structuredClone(input.metadata ?? {}),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    return await options.coordinator.commitMutation({
      draft: {
        type: "document.created",
        namespace,
        ...(threadId ? { threadId } : {}),
        subject: { type: KNOWLEDGE_DOCUMENT_COLLECTION, id },
        payload: { documentId: id },
        delta: { status: "pending" },
        visibility: { kind: "internal" },
        ...identityFields(input.identity),
      },
      mutate: async (context) => {
        if (threadId) {
          const thread = await node(
            context.transaction,
            tables.nodes,
            namespace,
            threadId,
            "thread",
          );
          if (!thread) throw new Error(`Thread '${threadId}' was not found.`);
        }
        if (externalId) {
          const duplicate = await context.transaction.query<{ id: string }>(
            `SELECT id FROM ${tables.nodes}
             WHERE namespace = $1 AND type = $2
               AND data->>'externalId' = $3 LIMIT 1`,
            [namespace, KNOWLEDGE_DOCUMENT_COLLECTION, externalId],
          );
          if (duplicate.rows[0]) {
            throw new Error(
              `Document external ID '${externalId}' already exists.`,
            );
          }
        }
        const persistedSource = prepared
          ? singleSource(
            await options.assets.materialize(context, {
              namespace,
              content: prepared,
            }),
          )
          : [];
        const inserted = await context.transaction.query<NodeRow>(
          `INSERT INTO ${tables.nodes} (
             id, namespace, type, name, data, source_type, source_id,
             created_at, updated_at
           ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $8)
           RETURNING id, namespace, type, name, data, created_at, updated_at`,
          [
            id,
            namespace,
            KNOWLEDGE_DOCUMENT_COLLECTION,
            title,
            JSON.stringify({ ...baseData, source: persistedSource }),
            threadId ? "thread" : null,
            threadId ?? null,
            timestamp,
          ],
        );
        if (threadId) {
          await context.transaction.query(
            `INSERT INTO ${tables.edges} (
               id, namespace, source_node_id, target_node_id, type, data, weight
             ) VALUES ($1, $2, $3, $4, 'has_document', '{}', 1)
             ON CONFLICT (id) DO NOTHING`,
            [
              `relation:${namespace}:has_document:${threadId}:${id}`,
              namespace,
              threadId,
              id,
            ],
          );
        }
        if (persistedSource.length) {
          await options.assets.linkOwner(context, {
            namespace,
            ownerId: id,
            content: persistedSource,
          });
        }
        return documentFromRow(inserted.rows[0]);
      },
      recoverDuplicate: async (_event, context) => {
        const document = await requiredDocument(
          context.transaction,
          tables.nodes,
          namespace,
          id,
        );
        const expectedSource = prepared
          ? await options.assets.resolvePrepared(context, {
            namespace,
            content: prepared,
          })
          : [];
        if (
          document.title !== title ||
          document.sourceUri !== (sourceUri ?? null) ||
          document.sourceType !== inferredSourceType ||
          !jsonEqual(document.source, expectedSource)
        ) {
          throw new Error(
            `Document identity '${id}' was reused with different input.`,
          );
        }
        return document;
      },
    });
  };

  const transition = async (
    input: Readonly<{
      namespace: string;
      id: string;
      eventType: "document.processing" | "document.failed";
      patch: Record<string, unknown>;
      identity?: CreateKnowledgeDocumentInput["identity"];
    }>,
  ) => {
    const namespace = required(input.namespace, "Namespace");
    const id = required(input.id, "Document ID");
    const existing = await get(namespace, id);
    if (!existing) throw new Error(`Knowledge document '${id}' was not found.`);
    return await options.coordinator.commitMutation<KnowledgeDocument>({
      draft: {
        type: input.eventType,
        namespace,
        ...(existing.threadId ? { threadId: existing.threadId } : {}),
        subject: { type: KNOWLEDGE_DOCUMENT_COLLECTION, id },
        payload: { documentId: id },
        delta: structuredClone(input.patch),
        visibility: { kind: "internal" },
        ...identityFields(input.identity),
      },
      mutate: async (context) => {
        const current = await requiredDocument(
          context.transaction,
          tables.nodes,
          namespace,
          id,
          true,
        );
        if (current.status === "indexed" || current.status === "duplicate") {
          throw new Error(`Document '${id}' is already settled.`);
        }
        const updatedAt = now().toISOString();
        const updated = await context.transaction.query<NodeRow>(
          `UPDATE ${tables.nodes}
           SET data = COALESCE(data, '{}'::jsonb) || $1::jsonb,
               updated_at = $2
           WHERE namespace = $3 AND id = $4 AND type = $5
           RETURNING id, namespace, type, name, data, created_at, updated_at`,
          [
            JSON.stringify({ ...input.patch, updatedAt }),
            updatedAt,
            namespace,
            id,
            KNOWLEDGE_DOCUMENT_COLLECTION,
          ],
        );
        return documentFromRow(updated.rows[0]);
      },
      recoverDuplicate: async (_event, context) =>
        await requiredDocument(
          context.transaction,
          tables.nodes,
          namespace,
          id,
        ),
    });
  };

  const begin: KnowledgeRepository["begin"] = (namespace, id, identity) =>
    transition({
      namespace,
      id,
      eventType: "document.processing",
      patch: { status: "processing", error: null },
      identity,
    });

  const complete: KnowledgeRepository["complete"] = async (input) => {
    const namespace = required(input.namespace, "Namespace");
    const id = required(input.id, "Document ID");
    const mediaType = required(input.mediaType, "Document media type");
    const hash = contentHash(input.contentHash);
    const title = optional(input.title, "Document title");
    const chunks = [...input.chunks].map((candidate) => {
      const chunkIndex = nonNegativeInteger(
        candidate.chunkIndex,
        "Chunk index",
      );
      const startPosition = nonNegativeInteger(
        candidate.startPosition,
        "Chunk start",
      );
      const endPosition = nonNegativeInteger(
        candidate.endPosition,
        "Chunk end",
      );
      if (endPosition < startPosition) {
        throw new TypeError("Chunk end cannot precede its start.");
      }
      return Object.freeze({
        content: required(candidate.content, "Chunk content"),
        embedding: finiteVector(candidate.embedding, "Chunk embedding"),
        chunkIndex,
        tokenCount: nonNegativeInteger(
          candidate.tokenCount,
          "Chunk token count",
        ),
        startPosition,
        endPosition,
        metadata: structuredClone(candidate.metadata ?? {}),
      });
    }).sort((left, right) => left.chunkIndex - right.chunkIndex);
    if (chunks.length === 0) {
      throw new TypeError(
        "An indexed document must contain at least one chunk.",
      );
    }
    const dimensions = chunks[0].embedding.length;
    chunks.forEach((chunk, index) => {
      if (chunk.chunkIndex !== index) {
        throw new TypeError("Chunk indexes must be contiguous from zero.");
      }
      if (chunk.embedding.length !== dimensions) {
        throw new TypeError(
          "Every document chunk must use the same dimensions.",
        );
      }
    });
    const existing = await get(namespace, id);
    if (!existing) throw new Error(`Knowledge document '${id}' was not found.`);

    return await options.coordinator.commitMutation<KnowledgeDocument>({
      draft: {
        type: "document.indexed",
        namespace,
        ...(existing.threadId ? { threadId: existing.threadId } : {}),
        subject: { type: KNOWLEDGE_DOCUMENT_COLLECTION, id },
        payload: { documentId: id },
        delta: {
          status: "indexed",
          chunkCount: chunks.length,
          contentHash: hash,
        },
        visibility: { kind: "internal" },
        ...identityFields(input.identity),
      },
      mutate: async (context) => {
        const current = await requiredDocument(
          context.transaction,
          tables.nodes,
          namespace,
          id,
          true,
        );
        if (current.status === "indexed" || current.status === "duplicate") {
          throw new Error(`Document '${id}' is already settled.`);
        }
        const persistedSource = singleSource(
          await options.assets.materialize(context, {
            namespace,
            content: input.source,
          }),
        );
        const timestamp = now().toISOString();

        await context.transaction.query(
          `DELETE FROM ${tables.nodes}
           WHERE namespace = $1 AND type = $2
             AND data->>'documentId' = $3`,
          [namespace, KNOWLEDGE_CHUNK_COLLECTION, id],
        );
        for (const chunk of chunks) {
          const chunkId = `${id}:chunk:${chunk.chunkIndex}`;
          const data = {
            documentId: id,
            chunkIndex: chunk.chunkIndex,
            content: chunk.content,
            tokenCount: chunk.tokenCount,
            embedding: chunk.embedding,
            startPosition: chunk.startPosition,
            endPosition: chunk.endPosition,
            metadata: chunk.metadata,
            createdAt: timestamp,
            updatedAt: timestamp,
          };
          await context.transaction.query(
            `INSERT INTO ${tables.nodes} (
               id, namespace, type, name, content, data, embedding,
               source_type, source_id, created_at, updated_at
             ) VALUES (
               $1, $2, $3, $4, $5, $6::jsonb, $7::jsonb,
               'document', $8, $9, $9
             )`,
            [
              chunkId,
              namespace,
              KNOWLEDGE_CHUNK_COLLECTION,
              `${title ?? current.title} #${chunk.chunkIndex + 1}`,
              chunk.content,
              JSON.stringify(data),
              JSON.stringify(chunk.embedding),
              id,
              timestamp,
            ],
          );
          await context.transaction.query(
            `INSERT INTO ${tables.edges} (
               id, namespace, source_node_id, target_node_id, type, data, weight
             ) VALUES ($1, $2, $3, $4, $5, '{}', 1),
                      ($6, $2, $4, $3, $7, '{}', 1)`,
            [
              `relation:${namespace}:${KNOWLEDGE_HAS_CHUNK_EDGE}:${id}:${chunkId}`,
              namespace,
              id,
              chunkId,
              KNOWLEDGE_HAS_CHUNK_EDGE,
              `relation:${namespace}:${KNOWLEDGE_DERIVED_FROM_EDGE}:${chunkId}:${id}`,
              KNOWLEDGE_DERIVED_FROM_EDGE,
            ],
          );
        }

        const nextTitle = title ?? current.title;
        const updated = await context.transaction.query<NodeRow>(
          `UPDATE ${tables.nodes}
           SET name = $1,
               data = COALESCE(data, '{}'::jsonb) || $2::jsonb,
               updated_at = $3
           WHERE namespace = $4 AND id = $5 AND type = $6
           RETURNING id, namespace, type, name, data, created_at, updated_at`,
          [
            nextTitle,
            JSON.stringify({
              title: nextTitle,
              mediaType,
              contentHash: hash,
              source: persistedSource,
              status: "indexed",
              chunkCount: chunks.length,
              duplicateOfDocumentId: null,
              error: null,
              updatedAt: timestamp,
            }),
            timestamp,
            namespace,
            id,
            KNOWLEDGE_DOCUMENT_COLLECTION,
          ],
        );
        await options.assets.syncOwner(context, {
          namespace,
          ownerId: id,
          content: persistedSource,
        });
        return documentFromRow(updated.rows[0]);
      },
      recoverDuplicate: async (_event, context) => {
        const document = await requiredDocument(
          context.transaction,
          tables.nodes,
          namespace,
          id,
        );
        const expectedSource = await options.assets.resolvePrepared(context, {
          namespace,
          content: input.source,
        });
        if (
          document.status !== "indexed" ||
          document.contentHash !== hash ||
          document.mediaType !== mediaType ||
          document.chunkCount !== chunks.length ||
          !jsonEqual(document.source, expectedSource)
        ) {
          throw new Error(
            `Document completion identity for '${id}' was reused.`,
          );
        }
        const persistedChunks = await listChunks(namespace, id);
        if (
          persistedChunks.length !== chunks.length ||
          persistedChunks.some((chunk, index) =>
            chunk.content !== chunks[index].content ||
            !jsonEqual(chunk.embedding, chunks[index].embedding)
          )
        ) {
          throw new Error(
            `Document completion identity for '${id}' changed chunks.`,
          );
        }
        return document;
      },
    });
  };

  const markDuplicate: KnowledgeRepository["markDuplicate"] = async (
    input,
  ) => {
    const namespace = required(input.namespace, "Namespace");
    const id = required(input.id, "Document ID");
    const duplicateId = required(
      input.duplicateOfDocumentId,
      "Canonical document ID",
    );
    if (id === duplicateId) {
      throw new TypeError("A document cannot be a duplicate of itself.");
    }
    const mediaType = required(input.mediaType, "Document media type");
    const hash = contentHash(input.contentHash);
    const [existing, canonical] = await Promise.all([
      get(namespace, id),
      get(namespace, duplicateId),
    ]);
    if (!existing) throw new Error(`Knowledge document '${id}' was not found.`);
    if (!canonical || canonical.status !== "indexed") {
      throw new Error(
        `Canonical knowledge document '${duplicateId}' is not indexed.`,
      );
    }
    if (
      canonical.contentHash !== hash || canonical.mediaType !== mediaType
    ) {
      throw new Error(
        "Duplicate metadata does not match the canonical document.",
      );
    }

    return await options.coordinator.commitMutation<KnowledgeDocument>({
      draft: {
        type: "document.duplicate",
        namespace,
        ...(existing.threadId ? { threadId: existing.threadId } : {}),
        subject: { type: KNOWLEDGE_DOCUMENT_COLLECTION, id },
        payload: {
          documentId: id,
          duplicateOfDocumentId: duplicateId,
        },
        delta: {
          status: "duplicate",
          duplicateOfDocumentId: duplicateId,
          contentHash: hash,
        },
        visibility: { kind: "internal" },
        ...identityFields(input.identity),
      },
      mutate: async (context) => {
        const current = await requiredDocument(
          context.transaction,
          tables.nodes,
          namespace,
          id,
          true,
        );
        if (current.status === "indexed" || current.status === "duplicate") {
          throw new Error(`Document '${id}' is already settled.`);
        }
        const lockedCanonical = await requiredDocument(
          context.transaction,
          tables.nodes,
          namespace,
          duplicateId,
          true,
        );
        const persistedSource = singleSource(
          await options.assets.materialize(context, {
            namespace,
            content: input.source,
          }),
        );
        if (
          lockedCanonical.status !== "indexed" ||
          lockedCanonical.contentHash !== hash ||
          lockedCanonical.mediaType !== mediaType ||
          !jsonEqual(lockedCanonical.source, persistedSource)
        ) {
          throw new Error("Canonical document changed during deduplication.");
        }
        await context.transaction.query(
          `DELETE FROM ${tables.nodes}
           WHERE namespace = $1 AND type = $2
             AND data->>'documentId' = $3`,
          [namespace, KNOWLEDGE_CHUNK_COLLECTION, id],
        );
        const timestamp = now().toISOString();
        const updated = await context.transaction.query<NodeRow>(
          `UPDATE ${tables.nodes}
           SET data = COALESCE(data, '{}'::jsonb) || $1::jsonb,
               updated_at = $2
           WHERE namespace = $3 AND id = $4 AND type = $5
           RETURNING id, namespace, type, name, data, created_at, updated_at`,
          [
            JSON.stringify({
              mediaType,
              contentHash: hash,
              source: persistedSource,
              status: "duplicate",
              chunkCount: 0,
              duplicateOfDocumentId: duplicateId,
              error: null,
              updatedAt: timestamp,
            }),
            timestamp,
            namespace,
            id,
            KNOWLEDGE_DOCUMENT_COLLECTION,
          ],
        );
        await options.assets.syncOwner(context, {
          namespace,
          ownerId: id,
          content: persistedSource,
        });
        return documentFromRow(updated.rows[0]);
      },
      recoverDuplicate: async (_event, context) => {
        const document = await requiredDocument(
          context.transaction,
          tables.nodes,
          namespace,
          id,
        );
        const expectedSource = await options.assets.resolvePrepared(context, {
          namespace,
          content: input.source,
        });
        if (
          document.status !== "duplicate" ||
          document.duplicateOfDocumentId !== duplicateId ||
          document.contentHash !== hash ||
          document.mediaType !== mediaType ||
          !jsonEqual(document.source, expectedSource)
        ) {
          throw new Error(
            `Document duplicate identity for '${id}' was reused.`,
          );
        }
        return document;
      },
    });
  };

  const fail: KnowledgeRepository["fail"] = (input) => {
    const error = {
      code: required(input.error.code, "Knowledge failure code"),
      message: required(input.error.message, "Knowledge failure message"),
    };
    return transition({
      namespace: input.namespace,
      id: input.id,
      eventType: "document.failed",
      patch: { status: "failed", error },
      identity: input.identity,
    });
  };

  const deleteDocument: KnowledgeRepository["delete"] = async (
    namespaceInput,
    idInput,
    identity,
  ) => {
    const namespace = required(namespaceInput, "Namespace");
    const id = required(idInput, "Document ID");
    const existing = await get(namespace, id);
    if (!existing) throw new Error(`Knowledge document '${id}' was not found.`);
    return await options.coordinator.commitMutation({
      draft: {
        type: "document.deleted",
        namespace,
        ...(existing.threadId ? { threadId: existing.threadId } : {}),
        subject: { type: KNOWLEDGE_DOCUMENT_COLLECTION, id },
        payload: { documentId: id },
        delta: { deleted: true },
        visibility: { kind: "internal" },
        ...identityFields(identity),
      },
      mutate: async (context) => {
        await requiredDocument(
          context.transaction,
          tables.nodes,
          namespace,
          id,
          true,
        );
        await context.transaction.query(
          `DELETE FROM ${tables.nodes}
           WHERE namespace = $1 AND type = $2
             AND data->>'documentId' = $3`,
          [namespace, KNOWLEDGE_CHUNK_COLLECTION, id],
        );
        const deleted = await context.transaction.query<{ id: string }>(
          `DELETE FROM ${tables.nodes}
           WHERE namespace = $1 AND id = $2 AND type = $3
           RETURNING id`,
          [namespace, id, KNOWLEDGE_DOCUMENT_COLLECTION],
        );
        if (!deleted.rows[0]) {
          throw new Error(`Knowledge document '${id}' was not found.`);
        }
        return Object.freeze({ id, deleted: true as const });
      },
      recoverDuplicate: async (_event, context) => {
        const remaining = await node(
          context.transaction,
          tables.nodes,
          namespace,
          id,
          KNOWLEDGE_DOCUMENT_COLLECTION,
        );
        if (remaining) {
          throw new Error(
            `Document deletion identity for '${id}' was reused.`,
          );
        }
        return Object.freeze({ id, deleted: true as const });
      },
    });
  };

  const getByHash: KnowledgeRepository["getByHash"] = async (
    namespaceInput,
    hashInput,
  ) => {
    const namespace = required(namespaceInput, "Namespace");
    const hash = contentHash(hashInput);
    const result = await options.session.query<NodeRow>(
      `SELECT id, namespace, type, name, data, created_at, updated_at
       FROM ${tables.nodes}
       WHERE namespace = $1 AND type = $2
         AND data->>'contentHash' = $3
         AND data->>'status' = 'indexed'
       ORDER BY created_at, id
       LIMIT 1`,
      [namespace, KNOWLEDGE_DOCUMENT_COLLECTION, hash],
    );
    return result.rows[0] ? documentFromRow(result.rows[0]) : null;
  };

  const getBySourceUri: KnowledgeRepository["getBySourceUri"] = async (
    namespaceInput,
    uriInput,
  ) => {
    const namespace = required(namespaceInput, "Namespace");
    const sourceUri = required(uriInput, "Document source URI");
    const result = await options.session.query<NodeRow>(
      `SELECT id, namespace, type, name, data, created_at, updated_at
       FROM ${tables.nodes}
       WHERE namespace = $1 AND type = $2
         AND data->>'sourceUri' = $3
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
      [namespace, KNOWLEDGE_DOCUMENT_COLLECTION, sourceUri],
    );
    return result.rows[0] ? documentFromRow(result.rows[0]) : null;
  };

  const list: KnowledgeRepository["list"] = async (
    namespaceInput,
    listOptions = {},
  ) => {
    const namespace = required(namespaceInput, "Namespace");
    const limit = positiveLimit(listOptions.limit);
    const values: unknown[] = [namespace, KNOWLEDGE_DOCUMENT_COLLECTION];
    const conditions = ["namespace = $1", "type = $2"];
    if (listOptions.status !== undefined) {
      values.push(status(listOptions.status));
      conditions.push(`data->>'status' = $${values.length}`);
    }
    if (listOptions.after !== undefined) {
      values.push(required(listOptions.after, "Document cursor"));
      conditions.push(`id > $${values.length}`);
    }
    values.push(limit);
    const result = await options.session.query<NodeRow>(
      `SELECT id, namespace, type, name, data, created_at, updated_at
       FROM ${tables.nodes}
       WHERE ${conditions.join(" AND ")}
       ORDER BY id
       LIMIT $${values.length}`,
      values,
    );
    return Object.freeze(result.rows.map(documentFromRow));
  };

  const listChunks: KnowledgeRepository["listChunks"] = async (
    namespaceInput,
    documentIdInput,
  ) => {
    const namespace = required(namespaceInput, "Namespace");
    const documentId = required(documentIdInput, "Document ID");
    const result = await options.session.query<NodeRow>(
      `SELECT id, namespace, type, name, data, created_at, updated_at
       FROM ${tables.nodes}
       WHERE namespace = $1 AND type = $2
         AND data->>'documentId' = $3
       ORDER BY (data->>'chunkIndex')::integer, id`,
      [namespace, KNOWLEDGE_CHUNK_COLLECTION, documentId],
    );
    return Object.freeze(result.rows.map(chunkFromRow));
  };

  const search: KnowledgeRepository["search"] = async (input) => {
    const namespace = required(input.namespace, "Namespace");
    const queryEmbedding = finiteVector(
      input.embedding,
      "Knowledge query embedding",
    );
    const limit = positiveLimit(input.limit, 100);
    const threshold = input.threshold ?? -1;
    if (
      !Number.isFinite(threshold) || threshold < -1 || threshold > 1
    ) {
      throw new TypeError(
        "Knowledge similarity threshold must be -1 through 1.",
      );
    }
    const scope = input.scope
      ? Object.freeze({
        ...(input.scope.threadId
          ? { threadId: required(input.scope.threadId, "Scope thread ID") }
          : {}),
        ...(input.scope.agentId
          ? { agentId: required(input.scope.agentId, "Scope agent ID") }
          : {}),
        ...(input.scope.knowledgeSpaceIds
          ? {
            knowledgeSpaceIds: Object.freeze(
              input.scope.knowledgeSpaceIds.map((id) =>
                required(id, "Knowledge space ID")
              ),
            ),
          }
          : {}),
        ...(input.scope.documentIds
          ? {
            documentIds: Object.freeze(
              input.scope.documentIds.map((id) =>
                required(id, "Document scope ID")
              ),
            ),
          }
          : {}),
      })
      : undefined;
    if (scope?.documentIds?.length === 0) return Object.freeze([]);

    type SearchRow = Readonly<{
      chunk_id: string;
      chunk_namespace: string;
      chunk_type: string;
      chunk_name: string;
      chunk_data: unknown;
      chunk_created_at: string | Date;
      chunk_updated_at: string | Date;
      document_id: string;
      document_namespace: string;
      document_type: string;
      document_name: string;
      document_data: unknown;
      document_created_at: string | Date;
      document_updated_at: string | Date;
    }>;
    const rows = await options.session.query<SearchRow>(
      `SELECT
         chunk.id AS chunk_id,
         chunk.namespace AS chunk_namespace,
         chunk.type AS chunk_type,
         chunk.name AS chunk_name,
         chunk.data AS chunk_data,
         chunk.created_at AS chunk_created_at,
         chunk.updated_at AS chunk_updated_at,
         document.id AS document_id,
         document.namespace AS document_namespace,
         document.type AS document_type,
         document.name AS document_name,
         document.data AS document_data,
         document.created_at AS document_created_at,
         document.updated_at AS document_updated_at
       FROM ${tables.nodes} chunk
       JOIN ${tables.nodes} document
         ON document.namespace = chunk.namespace
        AND document.id = chunk.data->>'documentId'
        AND document.type = $3
       WHERE chunk.namespace = $1
         AND chunk.type = $2
         AND document.data->>'status' = 'indexed'
       ORDER BY chunk.id`,
      [
        namespace,
        KNOWLEDGE_CHUNK_COLLECTION,
        KNOWLEDGE_DOCUMENT_COLLECTION,
      ],
    );
    const results: KnowledgeSearchResult[] = [];
    for (const row of rows.rows) {
      const document = documentFromRow({
        id: row.document_id,
        namespace: row.document_namespace,
        type: row.document_type,
        name: row.document_name,
        data: row.document_data,
        created_at: row.document_created_at,
        updated_at: row.document_updated_at,
      });
      if (!documentMatchesScope(document, scope)) continue;
      const chunk = chunkFromRow({
        id: row.chunk_id,
        namespace: row.chunk_namespace,
        type: row.chunk_type,
        name: row.chunk_name,
        data: row.chunk_data,
        created_at: row.chunk_created_at,
        updated_at: row.chunk_updated_at,
      });
      const score = similarity(queryEmbedding, chunk.embedding);
      if (score < threshold) continue;
      results.push(Object.freeze({ chunk, document, similarity: score }));
    }
    results.sort((left, right) =>
      right.similarity - left.similarity ||
      left.chunk.documentId.localeCompare(right.chunk.documentId) ||
      left.chunk.chunkIndex - right.chunk.chunkIndex
    );
    return Object.freeze(results.slice(0, limit));
  };

  return Object.freeze({
    create,
    begin,
    complete,
    markDuplicate,
    fail,
    delete: deleteDocument,
    get,
    getByHash,
    getBySourceUri,
    list,
    listChunks,
    search,
  });
}
