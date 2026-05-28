/**
 * Native runtime entities (participant, message, RAG, llm_usage) backed by
 * `collections.*` when configured, with fallbacks to `copilotz.ops` graph paths.
 *
 * Lives under `runtime/collections/` (runtime integration, not the collection CRUD engine).
 * @module
 */
import type {
  ChunkSearchOptions,
  ChunkSearchResult,
  MessageHistoryPage,
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
import { GRAPH_EDGE } from "@/runtime/graph/edges.ts";

type CollectionAccessor =
  | CollectionsManager
  | ScopedCollectionsManager
  | undefined;

type ScopedCollectionLike<TRecord> = {
  create: (data: Record<string, unknown>) => Promise<TRecord>;
  createMany?: (data: Record<string, unknown>[]) => Promise<TRecord[]>;
  find: (
    filter?: Record<string, unknown>,
    options?: Record<string, unknown>,
  ) => Promise<TRecord[]>;
  findOne: (
    filter: Record<string, unknown>,
    options?: Record<string, unknown>,
  ) => Promise<TRecord | null>;
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
  update: (
    filter: Record<string, unknown>,
    data: Record<string, unknown>,
  ) => Promise<TRecord | null>;
  upsert: (
    filter: Record<string, unknown>,
    data: Record<string, unknown>,
  ) => Promise<TRecord>;
  delete: (filter: Record<string, unknown>) => Promise<{ deleted: number }>;
  deleteMany?: (
    filter: Record<string, unknown>,
  ) => Promise<{ deleted: number }>;
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
  resolveByExternalId?: (
    externalId: string,
  ) => Promise<ParticipantRecord | null>;
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

function getScopedCollection<TRecord>(
  collections: CollectionAccessor,
  collectionName: string,
  namespace?: string,
): ScopedCollectionLike<TRecord> | undefined {
  if (!collections) return undefined;
  const maybeManager = collections as
    & CollectionsManager
    & Record<string, unknown>;
  if (namespace && typeof maybeManager.withNamespace === "function") {
    const scoped = maybeManager.withNamespace(namespace) as Record<
      string,
      unknown
    >;
    return scoped[collectionName] as ScopedCollectionLike<TRecord> | undefined;
  }
  return (collections as Record<string, unknown>)[collectionName] as
    | ScopedCollectionLike<TRecord>
    | undefined;
}

function getParticipantCollection(
  collections: CollectionAccessor,
  namespace?: string | null,
):
  | (ScopedCollectionLike<ParticipantRecord> & ParticipantCollectionMethods)
  | undefined {
  return getScopedCollection<ParticipantRecord>(
    collections,
    "participant",
    namespace ?? undefined,
  ) as
    | (ScopedCollectionLike<ParticipantRecord> & ParticipantCollectionMethods)
    | undefined;
}

export function hasParticipantCollection(
  collections?: CollectionAccessor,
): boolean {
  if (!collections) return false;
  const maybeManager = collections as
    & CollectionsManager
    & Record<string, unknown>;
  if (typeof maybeManager.hasCollection === "function") {
    return maybeManager.hasCollection("participant");
  }
  return Boolean((collections as Record<string, unknown>).participant);
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

export function createMessageService(
  deps: { collections?: CollectionAccessor; ops: CopilotzDb["ops"] },
) {
  const { ops } = deps;

  return {
    async create(
      message: Omit<NewMessage, "id"> & { id?: string },
      namespace?: string,
    ): Promise<Message> {
      return await ops.createMessage(message, namespace);
    },

    async listForThread(
      threadId: string,
      options?: { limit?: number; offset?: number; order?: "asc" | "desc" },
    ): Promise<Message[]> {
      return await ops.getMessagesForThread(threadId, options);
    },

    async listHistoryPage(
      threadId: string,
      options?: MessageHistoryPageOptions,
    ): Promise<MessageHistoryPage> {
      return await ops.getMessageHistoryPageFromGraph(threadId, options);
    },

    async listHistory(threadId: string, limit?: number): Promise<Message[]> {
      const page = await this.listHistoryPage(
        threadId,
        limit !== undefined ? { limit } : undefined,
      );
      return page.data;
    },

    async getHistory(
      threadId: string,
      userId: string,
      limit?: number,
    ): Promise<Message[]> {
      const allMessages: { message: Message; threadLevel: number }[] = [];
      let currentThreadId: string | null = threadId;
      let level = 0;

      while (currentThreadId) {
        const thread = await ops.getThreadById(currentThreadId);
        if (!thread) break;
        const participants = Array.isArray(thread.participants)
          ? thread.participants.filter((value): value is string =>
            typeof value === "string"
          )
          : [];
        if (
          !participants.some((participant) =>
            participant.toLowerCase() === userId.toLowerCase()
          )
        ) {
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

      return limit !== undefined
        ? allMessages.slice(-limit).map((entry) => entry.message)
        : allMessages.map((entry) => entry.message);
    },

    async deleteForThread(threadId: string): Promise<void> {
      await ops.deleteMessagesForThread(threadId);
    },
  };
}

export function createRagDataServices(
  deps: { collections?: CollectionAccessor; ops: CopilotzDb["ops"] },
) {
  const { ops } = deps;

  return {
    async createDocument(
      doc: Omit<NewDocument, "id"> & { id?: string },
    ): Promise<Document> {
      return await ops.createDocument(doc);
    },

    async getDocumentById(
      id: string,
      namespace?: string,
    ): Promise<Document | undefined> {
      const document = await ops.getDocumentById(id);
      if (!document) return undefined;
      if (namespace && document.namespace !== namespace) return undefined;
      return document;
    },

    async getDocumentByHash(
      hash: string,
      namespace: string,
    ): Promise<Document | undefined> {
      return await ops.getDocumentByHash(hash, namespace);
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
      await ops.updateDocumentStatus(id, status, errorMessage, chunkCount);
    },

    async deleteDocument(id: string, namespace?: string): Promise<void> {
      const document = namespace
        ? await this.getDocumentById(id, namespace)
        : await ops.getDocumentById(id);
      if (!document) return;
      await this.deleteChunksByDocumentId(id, document.namespace);
      await ops.deleteDocument(id);
    },

    async deleteChunksByDocumentId(
      documentId: string,
      namespace?: string,
    ): Promise<void> {
      await ops.deleteChunksByDocumentId(documentId);
    },

    async createChunks(
      chunks: Array<Omit<NewDocumentChunk, "id"> & { id?: string }>,
    ): Promise<DocumentChunk[]> {
      return await ops.createChunks(chunks);
    },

    async searchChunks(
      options: ChunkSearchOptions,
    ): Promise<ChunkSearchResult[]> {
      return await ops.searchChunks(options);
    },
  };
}

export function createLlmUsageService(
  deps: { collections?: CollectionAccessor; ops: CopilotzDb["ops"] },
) {
  const { ops } = deps;

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
      const thread = await ops.getThreadById(input.threadId);
      const namespace = typeof thread?.namespace === "string" &&
          thread.namespace.length > 0
        ? thread.namespace
        : undefined;
      if (!namespace) {
        throw new Error(
          `Cannot create llm_usage for thread ${input.threadId}: tenant namespace is required`,
        );
      }

      const node = await ops.createNode({
        namespace,
        type: "llm_usage",
        name: `${input.usage.status}:${input.provider ?? "unknown"}:${
          input.model ?? "unknown"
        }`,
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
        sourceType: "thread",
        sourceId: input.threadId,
      });
      await ops.createEdge({
        sourceNodeId: input.threadId,
        targetNodeId: node.id as string,
        type: GRAPH_EDGE.HAS_LLM_USAGE,
      });
      return node.id as string;
    },
  };
}
