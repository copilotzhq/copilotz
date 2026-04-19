/**
 * Native runtime entities (participant, message, RAG, llm_usage) backed by
 * `collections.*` when configured, with fallbacks to `copilotz.ops` graph paths.
 *
 * Lives under `runtime/collections/` (runtime integration, not the collection CRUD engine).
 * @module
 */
import { ulid } from "ulid";
import type {
  ChunkSearchOptions,
  ChunkSearchResult,
  MessageHistoryPage,
  MessageHistoryPageInfo,
  MessageHistoryPageOptions,
} from "@/database/operations/index.ts";
import type { TokenUsage } from "@/runtime/llm/types.ts";
import type {
  CollectionsManager,
  CopilotzDb,
  Document,
  DocumentChunk,
  Message,
  NewDocument,
  NewDocumentChunk,
  NewMessage,
  ScopedCollectionsManager,
} from "@/types/index.ts";

type CollectionAccessor = CollectionsManager | ScopedCollectionsManager | undefined;

type ScopedCollectionLike<TRecord> = {
  create: (data: Record<string, unknown>) => Promise<TRecord>;
  createMany?: (data: Record<string, unknown>[]) => Promise<TRecord[]>;
  find: (filter?: Record<string, unknown>, options?: Record<string, unknown>) => Promise<TRecord[]>;
  findOne: (filter: Record<string, unknown>, options?: Record<string, unknown>) => Promise<TRecord | null>;
  findPage?: (
    filter?: Record<string, unknown>,
    options?: Record<string, unknown>,
  ) => Promise<{
    data: TRecord[];
    pageInfo: {
      hasMoreBefore: boolean;
      hasMoreAfter: boolean;
      startCursor: string | null;
      endCursor: string | null;
      cursorField: string;
    };
  }>;
  update: (filter: Record<string, unknown>, data: Record<string, unknown>) => Promise<TRecord | null>;
  upsert: (filter: Record<string, unknown>, data: Record<string, unknown>) => Promise<TRecord>;
  delete: (filter: Record<string, unknown>) => Promise<{ deleted: number }>;
  deleteMany?: (filter: Record<string, unknown>) => Promise<{ deleted: number }>;
  search?: (
    query: string,
    options?: Record<string, unknown>,
  ) => Promise<Array<TRecord & { _similarity: number }>>;
};

interface ParticipantRecord extends Record<string, unknown> {
  id: string;
  namespace?: string;
  externalId: string;
  participantType: "human" | "agent";
  name?: string | null;
  email?: string | null;
  agentId?: string | null;
  metadata?: Record<string, unknown> | null;
  isGlobal?: boolean | null;
  createdAt?: string | Date;
  updatedAt?: string | Date;
}

type ParticipantCollectionMethods = {
  getByExternalId?: (externalId: string) => Promise<ParticipantRecord | null>;
  resolveByExternalId?: (externalId: string) => Promise<ParticipantRecord | null>;
  upsertIdentity?: (input: {
    id?: string;
    externalId: string;
    participantType: "human" | "agent";
    name?: string | null;
    email?: string | null;
    agentId?: string | null;
    metadata?: Record<string, unknown> | null;
    isGlobal?: boolean | null;
  }) => Promise<ParticipantRecord>;
};

interface MessageRecord extends Record<string, unknown> {
  id: string;
  namespace?: string;
  content?: string | null;
  messageId?: string;
  senderId?: string | null;
  senderType?: Message["senderType"] | null;
  senderUserId?: string | null;
  externalId?: string | null;
  toolCallId?: string | null;
  toolCalls?: Message["toolCalls"] | null;
  reasoning?: string | null;
  metadata?: Message["metadata"];
  createdAt?: string | Date;
  updatedAt?: string | Date;
}

interface DocumentRecord extends Record<string, unknown> {
  id: string;
  namespace?: string;
  externalId?: string | null;
  sourceType: string;
  sourceUri?: string | null;
  title?: string | null;
  mimeType?: string | null;
  contentHash: string;
  assetId?: string | null;
  status: Document["status"];
  chunkCount?: number | null;
  errorMessage?: string | null;
  metadata?: Record<string, unknown> | null;
  createdAt?: string | Date;
  updatedAt?: string | Date;
}

interface ChunkRecord extends Record<string, unknown> {
  id: string;
  namespace?: string;
  documentId: string;
  chunkIndex: number;
  content?: string | null;
  tokenCount?: number | null;
  embedding?: number[] | null;
  startPosition?: number | null;
  endPosition?: number | null;
  metadata?: Record<string, unknown> | null;
  createdAt?: string | Date;
  updatedAt?: string | Date;
}

function getScopedCollection<TRecord>(
  collections: CollectionAccessor,
  collectionName: string,
  namespace?: string,
): ScopedCollectionLike<TRecord> | undefined {
  if (!collections) return undefined;
  const maybeManager = collections as CollectionsManager & Record<string, unknown>;
  if (namespace && typeof maybeManager.withNamespace === "function") {
    const scoped = maybeManager.withNamespace(namespace) as Record<string, unknown>;
    return scoped[collectionName] as ScopedCollectionLike<TRecord> | undefined;
  }
  return (collections as Record<string, unknown>)[collectionName] as
    | ScopedCollectionLike<TRecord>
    | undefined;
}

function getParticipantCollection(
  collections: CollectionAccessor,
  namespace?: string | null,
): (ScopedCollectionLike<ParticipantRecord> & ParticipantCollectionMethods) | undefined {
  return getScopedCollection<ParticipantRecord>(
    collections,
    "participant",
    namespace ?? "global",
  ) as (ScopedCollectionLike<ParticipantRecord> & ParticipantCollectionMethods) | undefined;
}

export function hasParticipantCollection(collections?: CollectionAccessor): boolean {
  if (!collections) return false;
  const maybeManager = collections as CollectionsManager & Record<string, unknown>;
  if (typeof maybeManager.hasCollection === "function") {
    return maybeManager.hasCollection("participant");
  }
  return Boolean((collections as Record<string, unknown>).participant);
}

function normalizeMessage(record: MessageRecord): Message {
  return {
    id: (record.messageId ?? record.id) as string,
    threadId: (record.namespace ?? "") as string,
    senderId: (record.senderId ?? "") as string,
    senderType: (record.senderType ?? "system") as Message["senderType"],
    senderUserId: (record.senderUserId ?? null) as string | null,
    externalId: (record.externalId ?? null) as string | null,
    content: (record.content ?? null) as string | null,
    toolCallId: (record.toolCallId ?? null) as string | null,
    toolCalls: (record.toolCalls ?? null) as Message["toolCalls"],
    reasoning: (record.reasoning ?? null) as string | null,
    metadata: (record.metadata ?? null) as Message["metadata"],
    createdAt: (record.createdAt ?? new Date().toISOString()) as string | Date,
    updatedAt: (record.updatedAt ?? record.createdAt ?? new Date().toISOString()) as
      | string
      | Date,
  };
}

function normalizeDocument(record: DocumentRecord): Document {
  return {
    id: record.id,
    namespace: (record.namespace ?? "default") as string,
    externalId: (record.externalId ?? null) as string | null,
    sourceType: record.sourceType as Document["sourceType"],
    sourceUri: (record.sourceUri ?? null) as string | null,
    title: (record.title ?? null) as string | null,
    mimeType: (record.mimeType ?? null) as string | null,
    contentHash: record.contentHash,
    assetId: (record.assetId ?? null) as string | null,
    status: record.status,
    chunkCount: (record.chunkCount ?? null) as number | null,
    errorMessage: (record.errorMessage ?? null) as string | null,
    metadata: (record.metadata ?? null) as Record<string, unknown> | null,
    createdAt: record.createdAt as string | undefined,
    updatedAt: record.updatedAt as string | undefined,
  };
}

function normalizeChunk(record: ChunkRecord): DocumentChunk {
  return {
    id: record.id,
    documentId: record.documentId,
    namespace: (record.namespace ?? "default") as string,
    chunkIndex: record.chunkIndex,
    content: (record.content ?? "") as string,
    tokenCount: (record.tokenCount ?? null) as number | null,
    embedding: (record.embedding ?? null) as number[] | null,
    startPosition: (record.startPosition ?? null) as number | null,
    endPosition: (record.endPosition ?? null) as number | null,
    metadata: (record.metadata ?? null) as Record<string, unknown> | null,
    createdAt: record.createdAt as string | undefined,
    updatedAt: record.updatedAt as string | undefined,
  };
}

function deepMergeReplaceArrays(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...target };
  for (const [key, value] of Object.entries(source)) {
    const existing = result[key];
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      existing &&
      typeof existing === "object" &&
      !Array.isArray(existing)
    ) {
      result[key] = deepMergeReplaceArrays(
        existing as Record<string, unknown>,
        value as Record<string, unknown>,
      );
    } else if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

function emptyHistoryPage(): MessageHistoryPage {
  return {
    data: [],
    pageInfo: {
      hasMoreBefore: false,
      oldestMessageId: null,
      newestMessageId: null,
    },
  };
}

function historyPageInfo(messages: Message[], hasMoreBefore: boolean): MessageHistoryPageInfo {
  return {
    hasMoreBefore,
    oldestMessageId: messages[0]?.id ?? null,
    newestMessageId: messages[messages.length - 1]?.id ?? null,
  };
}

export function createMessageService(
  deps: { collections?: CollectionAccessor; ops: CopilotzDb["ops"] },
) {
  const { collections, ops } = deps;

  return {
    async create(
      message: Omit<NewMessage, "id"> & { id?: string },
      namespace?: string,
    ): Promise<Message> {
      const scoped = getScopedCollection<MessageRecord>(collections, "message", message.threadId);
      if (!scoped) {
        return await ops.createMessage(message, namespace);
      }

      const messageId = message.id ?? ulid();
      const previous = await scoped.findOne(
        {},
        { limit: 1, sort: [["createdAt", "desc"], ["id", "desc"]] },
      );
      const created = await scoped.create({
        id: messageId,
        messageId,
        senderId: message.senderId,
        senderType: message.senderType,
        senderUserId: message.senderUserId ?? null,
        externalId: message.externalId ?? null,
        content: message.content ?? null,
        toolCallId: message.toolCallId ?? null,
        toolCalls: message.toolCalls ?? null,
        reasoning: (message as Record<string, unknown>).reasoning ?? null,
        metadata: message.metadata ?? null,
      });

      if (previous?.id) {
        await ops.createEdge({
          sourceNodeId: previous.id as string,
          targetNodeId: created.id,
          type: "REPLIED_BY",
        });
      }

      if (message.senderType === "user" && message.senderId) {
        const participantScoped = getParticipantCollection(deps.collections, namespace ?? "global");
        if (participantScoped && typeof participantScoped.resolveByExternalId === "function") {
          const participant = await participantScoped.resolveByExternalId(message.senderId);
          if (participant?.id) {
            await ops.createEdge({
              sourceNodeId: participant.id,
              targetNodeId: created.id,
              type: "SENT_BY",
            });
          }
        }
      }

      return normalizeMessage(created);
    },

    async listForThread(
      threadId: string,
      options?: { limit?: number; offset?: number; order?: "asc" | "desc" },
    ): Promise<Message[]> {
      const scoped = getScopedCollection<MessageRecord>(collections, "message", threadId);
      if (!scoped) {
        return await ops.getMessagesForThread(threadId, options);
      }
      const sortDirection = options?.order === "asc" ? "asc" : "desc";
      const records = await scoped.find(
        {},
        {
          limit: options?.limit,
          offset: options?.offset,
          sort: [["createdAt", sortDirection], ["id", sortDirection]],
        },
      );
      const messages = records.map(normalizeMessage);
      return sortDirection === "desc" ? messages : messages;
    },

    async listHistoryPage(
      threadId: string,
      options?: MessageHistoryPageOptions,
    ): Promise<MessageHistoryPage> {
      const scoped = getScopedCollection<MessageRecord>(collections, "message", threadId);
      if (!scoped?.findPage) {
        return await ops.getMessageHistoryPageFromGraph(threadId, options);
      }

      const page = await scoped.findPage(
        {},
        {
          limit: options?.limit ?? 50,
          before: options?.before ?? undefined,
          cursorField: "messageId",
          sort: [["createdAt", "desc"]],
        },
      );
      const ordered = page.data.map(normalizeMessage).reverse();
      return {
        data: ordered,
        pageInfo: historyPageInfo(ordered, page.pageInfo.hasMoreBefore),
      };
    },

    async listHistory(threadId: string, limit = 50): Promise<Message[]> {
      const page = await this.listHistoryPage(threadId, { limit });
      return page.data;
    },

    async getHistory(
      threadId: string,
      userId: string,
      limit = 50,
    ): Promise<Message[]> {
      const allMessages: { message: Message; threadLevel: number }[] = [];
      let currentThreadId: string | null = threadId;
      let level = 0;

      while (currentThreadId) {
        const thread = await ops.getThreadById(currentThreadId);
        if (!thread) break;
        const participants = Array.isArray(thread.participants)
          ? thread.participants.filter((value): value is string => typeof value === "string")
          : [];
        if (!participants.some((participant) => participant.toLowerCase() === userId.toLowerCase())) {
          break;
        }

        const threadMessages = await this.listHistory(currentThreadId, limit);
        for (const message of threadMessages) {
          allMessages.push({ message, threadLevel: level });
        }

        currentThreadId = typeof thread.parentThreadId === "string"
          ? thread.parentThreadId
          : null;
        level += 1;
      }

      allMessages.sort((a, b) => {
        const dateA = new Date(String(a.message.createdAt)).getTime();
        const dateB = new Date(String(b.message.createdAt)).getTime();
        if (dateA !== dateB) return dateA - dateB;
        return b.threadLevel - a.threadLevel;
      });

      return allMessages.slice(-limit).map((entry) => entry.message);
    },

    async deleteForThread(threadId: string): Promise<void> {
      const scoped = getScopedCollection<MessageRecord>(collections, "message", threadId);
      if (!scoped) {
        await ops.deleteMessagesForThread(threadId);
        return;
      }
      if (typeof scoped.deleteMany === "function") {
        await scoped.deleteMany({});
        return;
      }
      const records = await scoped.find({});
      for (const record of records) {
        await scoped.delete({ id: record.id });
      }
    },
  };
}

export function createRagDataServices(
  deps: { collections?: CollectionAccessor; ops: CopilotzDb["ops"] },
) {
  const { collections, ops } = deps;

  return {
    async createDocument(doc: Omit<NewDocument, "id"> & { id?: string }): Promise<Document> {
      const scoped = getScopedCollection<DocumentRecord>(
        collections,
        "document",
        doc.namespace ?? "default",
      );
      if (!scoped) {
        return await ops.createDocument(doc);
      }
      return normalizeDocument(await scoped.create({
        ...(doc.id ? { id: doc.id } : {}),
        externalId: doc.externalId ?? null,
        sourceType: doc.sourceType,
        sourceUri: doc.sourceUri ?? null,
        title: doc.title ?? null,
        mimeType: doc.mimeType ?? null,
        contentHash: doc.contentHash,
        assetId: doc.assetId ?? null,
        status: doc.status ?? "pending",
        chunkCount: doc.chunkCount ?? null,
        errorMessage: doc.errorMessage ?? null,
        metadata: doc.metadata ?? null,
      }));
    },

    async getDocumentById(id: string, namespace?: string): Promise<Document | undefined> {
      if (!namespace) {
        return await ops.getDocumentById(id);
      }
      const scoped = getScopedCollection<DocumentRecord>(collections, "document", namespace);
      if (!scoped) {
        return await ops.getDocumentById(id);
      }
      const record = await scoped.findOne({ id });
      return record ? normalizeDocument(record) : undefined;
    },

    async getDocumentByHash(hash: string, namespace: string): Promise<Document | undefined> {
      const scoped = getScopedCollection<DocumentRecord>(collections, "document", namespace);
      if (!scoped) {
        return await ops.getDocumentByHash(hash, namespace);
      }
      const record = await scoped.findOne({ contentHash: hash });
      return record ? normalizeDocument(record) : undefined;
    },

    async updateDocumentStatus(
      id: string,
      namespace: string | undefined,
      status: Document["status"],
      errorMessage?: string,
      chunkCount?: number,
    ): Promise<void> {
      const document = namespace
        ? await this.getDocumentById(id, namespace)
        : await ops.getDocumentById(id);
      if (!document) return;
      const scoped = getScopedCollection<DocumentRecord>(
        collections,
        "document",
        document.namespace,
      );
      if (!scoped) {
        await ops.updateDocumentStatus(id, status, errorMessage, chunkCount);
        return;
      }
      await scoped.update(
        { id },
        {
          status,
          ...(errorMessage !== undefined ? { errorMessage } : {}),
          ...(chunkCount !== undefined ? { chunkCount } : {}),
        },
      );
    },

    async deleteDocument(id: string, namespace?: string): Promise<void> {
      const document = namespace
        ? await this.getDocumentById(id, namespace)
        : await ops.getDocumentById(id);
      if (!document) return;
      await this.deleteChunksByDocumentId(id, document.namespace);
      const scoped = getScopedCollection<DocumentRecord>(
        collections,
        "document",
        document.namespace,
      );
      if (!scoped) {
        await ops.deleteDocument(id);
        return;
      }
      await scoped.delete({ id });
    },

    async deleteChunksByDocumentId(documentId: string, namespace?: string): Promise<void> {
      if (!namespace) {
        await ops.deleteChunksByDocumentId(documentId);
        return;
      }
      const scoped = getScopedCollection<ChunkRecord>(collections, "chunk", namespace);
      if (!scoped) {
        await ops.deleteChunksByDocumentId(documentId);
        return;
      }
      if (typeof scoped.deleteMany === "function") {
        await scoped.deleteMany({ documentId });
        return;
      }
      const chunks = await scoped.find({ documentId });
      for (const chunk of chunks) {
        await scoped.delete({ id: chunk.id });
      }
    },

    async createChunks(
      chunks: Array<Omit<NewDocumentChunk, "id"> & { id?: string }>,
    ): Promise<DocumentChunk[]> {
      if (chunks.length === 0) return [];
      const created: DocumentChunk[] = [];
      for (const chunk of chunks) {
        const scoped = getScopedCollection<ChunkRecord>(collections, "chunk", chunk.namespace);
        if (!scoped) {
          const legacy = await ops.createChunks([chunk]);
          created.push(...legacy);
          continue;
        }
        const record = await scoped.create({
          ...(chunk.id ? { id: chunk.id } : {}),
          documentId: chunk.documentId,
          chunkIndex: chunk.chunkIndex,
          content: chunk.content,
          tokenCount: chunk.tokenCount ?? null,
          embedding: chunk.embedding ?? null,
          startPosition: chunk.startPosition ?? null,
          endPosition: chunk.endPosition ?? null,
          metadata: chunk.metadata ?? null,
        });
        created.push(normalizeChunk(record));
      }
      return created;
    },

    async searchChunks(options: ChunkSearchOptions): Promise<ChunkSearchResult[]> {
      if (!options.query || !Array.isArray(options.namespaces) || options.namespaces.length === 0) {
        return await ops.searchChunks(options);
      }

      const allResults: Array<ChunkRecord & { _similarity: number }> = [];
      for (const namespace of options.namespaces) {
        const scoped = getScopedCollection<ChunkRecord>(collections, "chunk", namespace);
        if (!scoped?.search) {
          return await ops.searchChunks(options);
        }
        const records = await scoped.search(options.query, {
          limit: options.limit ?? 10,
          threshold: options.threshold ?? 0.5,
        });
        allResults.push(...records);
      }

      const sorted = allResults
        .sort((a, b) => (b._similarity ?? 0) - (a._similarity ?? 0))
        .slice(0, options.limit ?? 10);

      const documentCache = new Map<string, Document | undefined>();
      const results: ChunkSearchResult[] = [];
      for (const record of sorted) {
        if (!documentCache.has(record.documentId)) {
          documentCache.set(
            record.documentId,
            await this.getDocumentById(record.documentId, record.namespace),
          );
        }
        const document = documentCache.get(record.documentId);
        if (options.documentFilters) {
          if (options.documentFilters.status && document?.status !== options.documentFilters.status) {
            continue;
          }
          if (
            options.documentFilters.sourceType &&
            document?.sourceType !== options.documentFilters.sourceType
          ) {
            continue;
          }
          if (
            options.documentFilters.mimeType &&
            document?.mimeType !== options.documentFilters.mimeType
          ) {
            continue;
          }
        }
        results.push({
          id: record.id,
          content: (record.content ?? "") as string,
          namespace: (record.namespace ?? "default") as string,
          chunkIndex: record.chunkIndex,
          similarity: record._similarity,
          tokenCount: (record.tokenCount ?? null) as number | null,
          metadata: (record.metadata ?? null) as Record<string, unknown> | null,
          document: document
            ? {
              id: document.id,
              title: document.title ?? null,
              sourceUri: document.sourceUri ?? null,
              sourceType: document.sourceType,
              mimeType: document.mimeType ?? null,
            }
            : undefined,
        });
      }

      return results;
    },
  };
}

export function createLlmUsageService(
  deps: { collections?: CollectionAccessor; ops: CopilotzDb["ops"] },
) {
  const { collections, ops } = deps;

  return {
    async createUsageRecord(input: {
      threadId: string;
      eventId: string | null;
      agentId: string | null;
      provider: string | null;
      model: string | null;
      usage: TokenUsage;
      cost?: {
        inputCostUsd?: number | null;
        outputCostUsd?: number | null;
        totalCostUsd?: number | null;
      } | null;
    }): Promise<string | null> {
      const scoped = getScopedCollection<Record<string, unknown>>(
        collections,
        "llm_usage",
        input.threadId,
      );
      if (!scoped) {
        const legacy = await ops.createNode({
          namespace: input.threadId,
          type: "llm_usage",
          name: `${input.usage.status}:${input.provider ?? "unknown"}:${input.model ?? "unknown"}`,
          data: {
            threadId: input.threadId,
            eventId: input.eventId,
            agentId: input.agentId,
            provider: input.provider,
            model: input.model,
            promptTokens: input.usage.inputTokens ?? null,
            completionTokens: input.usage.outputTokens ?? null,
            totalTokens: input.usage.totalTokens ?? null,
            promptCost: input.cost?.inputCostUsd ?? null,
            completionCost: input.cost?.outputCostUsd ?? null,
            totalCost: input.cost?.totalCostUsd ?? null,
            status: input.usage.status,
          },
          sourceType: "event",
          sourceId: input.eventId ?? input.threadId,
        });
        return legacy.id as string;
      }

      const created = await scoped.create({
        threadId: input.threadId,
        eventId: input.eventId,
        agentId: input.agentId,
        provider: input.provider,
        model: input.model,
        promptTokens: input.usage.inputTokens ?? null,
        completionTokens: input.usage.outputTokens ?? null,
        totalTokens: input.usage.totalTokens ?? null,
        promptCost: input.cost?.inputCostUsd ?? null,
        completionCost: input.cost?.outputCostUsd ?? null,
        totalCost: input.cost?.totalCostUsd ?? null,
        status: input.usage.status,
      });
      return (created.id as string) ?? null;
    },
  };
}
