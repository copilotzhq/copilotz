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
import type { CostBreakdown, TokenUsage } from "@/runtime/llm/types.ts";
import type {
  UsageCost,
  UsageEvent,
  UsageOptions,
} from "@/runtime/usage/types.ts";
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
import {
  resolveInitiatedById,
} from "@/runtime/usage/attribution.ts";

type CollectionAccessor =
  | CollectionsManager
  | ScopedCollectionsManager
  | undefined;

type MessageEditMetadata = {
  originalMessageId: string;
  rootMessageId: string;
  previousRevisionMessageId: string;
  revisionIndex: number;
  editedAt: string;
  supersededByMessageId?: string;
  supersededAt?: string;
};

type MessageEditState = {
  activeRootMessageId?: string;
  activeRevisionMessageId?: string;
  revisionByRoot?: Record<string, string>;
};

type MessageEditResult = {
  message: Message;
  rootMessageId: string;
  previousRevisionMessageId: string;
  revisionIndex: number;
};

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getMessageEditMetadata(
  metadata: Message["metadata"] | undefined | null,
): MessageEditMetadata | null {
  const edit = isRecord(metadata) && isRecord(metadata.copilotzEdit)
    ? metadata.copilotzEdit
    : null;
  if (!edit) return null;
  const originalMessageId = typeof edit.originalMessageId === "string"
    ? edit.originalMessageId
    : "";
  const rootMessageId = typeof edit.rootMessageId === "string"
    ? edit.rootMessageId
    : "";
  const previousRevisionMessageId =
    typeof edit.previousRevisionMessageId === "string"
      ? edit.previousRevisionMessageId
      : "";
  const revisionIndex = typeof edit.revisionIndex === "number"
    ? edit.revisionIndex
    : 0;
  const editedAt = typeof edit.editedAt === "string" ? edit.editedAt : "";
  if (
    !originalMessageId || !rootMessageId || !previousRevisionMessageId ||
    !revisionIndex || !editedAt
  ) {
    return null;
  }
  return {
    originalMessageId,
    rootMessageId,
    previousRevisionMessageId,
    revisionIndex,
    editedAt,
    supersededByMessageId: typeof edit.supersededByMessageId === "string"
      ? edit.supersededByMessageId
      : undefined,
    supersededAt: typeof edit.supersededAt === "string"
      ? edit.supersededAt
      : undefined,
  };
}

function getMessageEditState(metadata: unknown): MessageEditState {
  const system = isRecord(metadata) && isRecord(metadata.system)
    ? metadata.system
    : {};
  const messageEdits = isRecord(system.messageEdits) ? system.messageEdits : {};
  const revisionByRoot = isRecord(messageEdits.revisionByRoot)
    ? Object.fromEntries(
      Object.entries(messageEdits.revisionByRoot).filter((
        entry,
      ): entry is [string, string] =>
        typeof entry[0] === "string" && typeof entry[1] === "string"
      ),
    )
    : undefined;

  return {
    activeRootMessageId: typeof messageEdits.activeRootMessageId === "string"
      ? messageEdits.activeRootMessageId
      : undefined,
    activeRevisionMessageId:
      typeof messageEdits.activeRevisionMessageId === "string"
        ? messageEdits.activeRevisionMessageId
        : undefined,
    revisionByRoot,
  };
}

function sortMessagesByCreatedAt(messages: Message[]): Message[] {
  return [...messages].sort((a, b) => {
    const aTime = new Date(String(a.createdAt ?? "")).getTime();
    const bTime = new Date(String(b.createdAt ?? "")).getTime();
    if (aTime !== bTime) return aTime - bTime;
    return String(a.id).localeCompare(String(b.id));
  });
}

function projectActiveMessageBranch(
  messages: Message[],
  metadata: unknown,
): Message[] {
  const state = getMessageEditState(metadata);
  const activeRootId = state.activeRootMessageId;
  const activeRevisionId = state.activeRevisionMessageId;
  if (!activeRootId || !activeRevisionId) return messages;

  const byId = new Map(messages.map((message) => [message.id, message]));
  const activeRevision = byId.get(activeRevisionId);
  if (!activeRevision) return messages;

  const projected: Message[] = [];
  let skippingOldBranch = false;
  for (const message of sortMessagesByCreatedAt(messages)) {
    if (message.id === activeRootId) {
      projected.push(activeRevision);
      skippingOldBranch = true;
      continue;
    }
    if (message.id === activeRevisionId) {
      skippingOldBranch = false;
      continue;
    }
    if (skippingOldBranch) continue;

    const edit = getMessageEditMetadata(message.metadata);
    if (edit?.rootMessageId === activeRootId) continue;
    projected.push(message);
  }

  return projected;
}

function paginateProjectedMessages(
  messages: Message[],
  options?: MessageHistoryPageOptions,
): MessageHistoryPage {
  const ordered = sortMessagesByCreatedAt(messages);
  const limit = typeof options?.limit === "number" && options.limit > 0
    ? Math.floor(options.limit)
    : undefined;
  const before =
    typeof options?.before === "string" && options.before.length > 0
      ? options.before
      : null;
  const beforeIndex = before
    ? ordered.findIndex((message) => message.id === before)
    : -1;
  const eligible = before && beforeIndex >= 0
    ? ordered.slice(0, beforeIndex)
    : ordered;
  const data = limit !== undefined ? eligible.slice(-limit) : eligible;
  const firstIndex = data.length > 0 ? eligible.indexOf(data[0]) : -1;

  return {
    data,
    pageInfo: {
      hasMoreBefore: limit !== undefined && firstIndex > 0,
      oldestMessageId: data[0]?.id ?? null,
      newestMessageId: data[data.length - 1]?.id ?? null,
    },
  };
}

interface ParticipantRecord extends Record<string, unknown> {
  id: string;
  namespace?: string;
  externalId: string;
  participantType: "human" | "agent" | "job";
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
    participantType: "human" | "agent" | "job";
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
      return await ops.mutate.messages.create(message, namespace);
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
      const thread = await ops.getThreadById(threadId);
      const editState = getMessageEditState(thread?.metadata);
      if (editState.activeRootMessageId && editState.activeRevisionMessageId) {
        const messages = await ops.getMessageHistoryFromGraph(threadId);
        return paginateProjectedMessages(
          projectActiveMessageBranch(messages, thread?.metadata),
          options,
        );
      }
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

    async edit(
      threadId: string,
      messageId: string,
      content: string,
    ): Promise<MessageEditResult> {
      const nextContent = content.trim();
      if (!nextContent) {
        throw new Error("Edited message content is required.");
      }

      const thread = await ops.getThreadById(threadId);
      if (!thread) {
        throw new Error("Thread not found.");
      }

      const messages = await ops.getMessageHistoryFromGraph(threadId);
      const target = messages.find((message) => message.id === messageId);
      if (!target) {
        throw new Error("Message not found.");
      }
      if (target.senderType !== "user") {
        throw new Error("Only user messages can be edited.");
      }

      const targetEdit = getMessageEditMetadata(target.metadata);
      const rootMessageId = targetEdit?.rootMessageId ?? target.id;
      const root = messages.find((message) => message.id === rootMessageId) ??
        target;
      const revisionIndex = messages.reduce((count, message) => {
        const edit = getMessageEditMetadata(message.metadata);
        return edit?.rootMessageId === rootMessageId ? count + 1 : count;
      }, 0) + 1;
      const editedAt = new Date().toISOString();
      const previousMetadata = isRecord(target.metadata) ? target.metadata : {};
      const revision = await ops.mutate.messages.create({
        threadId,
        senderId: target.senderId,
        senderType: target.senderType,
        senderUserId: target.senderUserId ?? undefined,
        externalId: target.externalId ?? undefined,
        content: nextContent,
        metadata: {
          ...previousMetadata,
          copilotzEdit: {
            originalMessageId: target.id,
            rootMessageId,
            previousRevisionMessageId: target.id,
            revisionIndex,
            editedAt,
          },
        },
      }, typeof thread.namespace === "string" ? thread.namespace : undefined);

      const targetNode = await ops.unsafeGraph.getNodeById(target.id);
      if (targetNode) {
        const targetData = isRecord(targetNode.data) ? targetNode.data : {};
        const targetMetadata = isRecord(targetData.metadata)
          ? targetData.metadata
          : {};
        await ops.mutate.graph.updateNode(target.id, {
          data: {
            ...targetData,
            metadata: {
              ...targetMetadata,
              copilotzEdit: {
                ...(isRecord(targetMetadata.copilotzEdit)
                  ? targetMetadata.copilotzEdit
                  : {}),
                supersededByMessageId: revision.id,
                supersededAt: editedAt,
              },
            },
          },
        }, {
          threadId,
          namespace: typeof thread.namespace === "string"
            ? thread.namespace
            : null,
        });
      }

      const existingState = getMessageEditState(thread.metadata);
      const existingRevisionByRoot = existingState.revisionByRoot ?? {};
      const systemMetadata = isRecord(thread.metadata?.system)
        ? thread.metadata.system
        : {};
      const updatedMetadata = {
        ...(isRecord(thread.metadata) ? thread.metadata : {}),
        system: {
          ...systemMetadata,
          messageEdits: {
            ...existingState,
            activeRootMessageId: root.id,
            activeRevisionMessageId: revision.id,
            revisionByRoot: {
              ...existingRevisionByRoot,
              [root.id]: revision.id,
            },
          },
        },
      };
      await ops.updateThread(threadId, {
        metadata: updatedMetadata,
      });

      return {
        message: revision,
        rootMessageId: root.id,
        previousRevisionMessageId: target.id,
        revisionIndex,
      };
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

/**
 * Maps the legacy LLM {@link CostBreakdown} into the normalized {@link UsageCost}
 * so the LLM path and generic kinds share one cost shape.
 */
function costBreakdownToUsageCost(
  cost?: CostBreakdown | null,
): UsageCost | null {
  if (!cost) return null;
  const breakdown: Record<string, number> = {};
  for (
    const key of [
      "inputCostUsd",
      "outputCostUsd",
      "reasoningCostUsd",
      "cacheReadInputCostUsd",
      "cacheCreationInputCostUsd",
    ] as const
  ) {
    const value = (cost as unknown as Record<string, unknown>)[key];
    if (typeof value === "number") breakdown[key] = value;
  }
  return {
    currency: cost.currency ?? "USD",
    total: cost.totalCostUsd ?? 0,
    source: cost.source ?? "openrouter",
    pricingModelId: cost.pricingModelId,
    breakdown: Object.keys(breakdown).length ? breakdown : undefined,
  };
}

export function createUsageService(
  deps: {
    collections?: CollectionAccessor;
    ops: CopilotzDb["ops"];
    usageOptions?: UsageOptions;
  },
) {
  const { ops, usageOptions } = deps;

  const createUsageParticipantEdges = async (
    input: {
      namespace: string;
      usageNodeId: string;
      agentId: string | null;
      initiatedById: string | null;
    },
  ) => {
    const edgeInputs: Array<{
      sourceNodeId: string;
      targetNodeId: string;
      type: string;
    }> = [];

    if (input.agentId) {
      const caller = await ops.getParticipantNode(
        input.agentId,
        input.namespace,
      );
      if (caller?.id) {
        edgeInputs.push({
          sourceNodeId: caller.id as string,
          targetNodeId: input.usageNodeId,
          type: GRAPH_EDGE.GENERATED_USAGE,
        });
      }
    }

    if (input.initiatedById) {
      const initiator = await ops.getParticipantNode(
        input.initiatedById,
        input.namespace,
      );
      if (initiator?.id) {
        edgeInputs.push({
          sourceNodeId: initiator.id as string,
          targetNodeId: input.usageNodeId,
          type: GRAPH_EDGE.INITIATED_USAGE,
        });
      }
    }

    for (const edge of edgeInputs) {
      await ops.unsafeGraph.createEdge(edge).catch(() => undefined);
    }
  };

  const tokenMetrics = (usage: TokenUsage): Record<string, number> => {
    const metrics: Record<string, number> = {};
    for (
      const key of [
        "inputTokens",
        "outputTokens",
        "reasoningTokens",
        "cacheReadInputTokens",
        "cacheCreationInputTokens",
        "totalTokens",
      ] as const
    ) {
      const value = usage[key];
      if (typeof value === "number") metrics[key] = value;
    }
    return metrics;
  };

  const buildUsageData = (
    input: {
      threadId: string;
      eventId: string | null;
      agentId: string | null;
      initiatedById: string | null;
      provider: string | null;
      model: string | null;
      usage: TokenUsage;
      cost?: CostBreakdown | null;
      metricsFinalizedAt?: string | null;
      dedupeKey?: string | null;
      occurredAt?: string | null;
    },
  ) => ({
    // Unified ledger classification (LLM kind).
    kind: "llm",
    resource: input.model ?? input.provider ?? "unknown",
    operation: "chat",
    initiatedById: input.initiatedById,
    metrics: tokenMetrics(input.usage),
    dedupeKey: input.dedupeKey ?? null,
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    threadId: input.threadId,
    eventId: input.eventId,
    agentId: input.agentId,
    provider: input.provider,
    model: input.model,
    inputTokens: input.usage.inputTokens ?? null,
    outputTokens: input.usage.outputTokens ?? null,
    reasoningTokens: input.usage.reasoningTokens ?? null,
    cacheReadInputTokens: input.usage.cacheReadInputTokens ?? null,
    cacheCreationInputTokens: input.usage.cacheCreationInputTokens ?? null,
    totalTokens: input.usage.totalTokens ?? null,
    inputCostUsd: input.cost?.inputCostUsd ?? null,
    outputCostUsd: input.cost?.outputCostUsd ?? null,
    reasoningCostUsd: input.cost?.reasoningCostUsd ?? null,
    cacheReadInputCostUsd: input.cost?.cacheReadInputCostUsd ?? null,
    cacheCreationInputCostUsd: input.cost?.cacheCreationInputCostUsd ?? null,
    totalCostUsd: input.cost?.totalCostUsd ?? null,
    pricingModelId: input.cost?.pricingModelId ?? null,
    pricingSource: input.cost?.source ?? null,
    pricingCurrency: input.cost?.currency ?? null,
    source: input.usage.source ?? null,
    rawUsage: input.usage.rawUsage ?? null,
    status: input.usage.status,
    statusReason: input.usage.statusReason ?? null,
    stopSequence: input.usage.stopSequence ?? null,
    metricsFinalizedAt: input.metricsFinalizedAt ?? null,
  });

  const usageCostToBreakdown = (
    cost: UsageCost | null,
  ): CostBreakdown | null =>
    cost
      ? ({
        source: (cost.source as CostBreakdown["source"]) ?? "openrouter",
        currency: (cost.currency as CostBreakdown["currency"]) ?? "USD",
        pricingModelId: cost.pricingModelId ?? "",
        ...(cost.breakdown ?? {}),
        totalCostUsd: cost.total,
      } as CostBreakdown)
      : null;

  /**
   * Applies the configured cost resolver and record hook. Returns null when the
   * record is vetoed by `onRecord`. With no hooks configured this is a no-op
   * that preserves the supplied cost exactly.
   */
  const applyHooks = async (
    event: UsageEvent,
    source: unknown,
  ): Promise<{ cost: UsageCost | null; metrics: Record<string, number> } | null> => {
    if (!usageOptions?.resolveCost && !usageOptions?.onRecord) {
      return { cost: event.cost ?? null, metrics: event.metrics };
    }
    let cost = event.cost ?? null;
    if (usageOptions.resolveCost) {
      cost = (await usageOptions.resolveCost(event, {
        source,
        defaultResolve: () => Promise.resolve(event.cost ?? null),
      })) ?? null;
    }
    let record = { ...event, cost };
    if (usageOptions.onRecord) {
      const out = await usageOptions.onRecord(record);
      if (!out) return null;
      record = { ...out, cost: out.cost ?? null };
    }
    return { cost: record.cost ?? null, metrics: record.metrics ?? event.metrics };
  };

  const resolveThreadContext = async (
    threadId: string,
  ): Promise<{ namespace: string; threadMetadata: unknown }> => {
    const thread = await ops.getThreadById(threadId);
    const namespace = typeof thread?.namespace === "string" &&
        thread.namespace.length > 0
      ? thread.namespace
      : undefined;
    if (!namespace) {
      throw new Error(
        `Cannot create usage record for thread ${threadId}: tenant namespace is required`,
      );
    }
    return { namespace, threadMetadata: thread?.metadata };
  };

  /**
   * Persists a usage node through the durable domain-mutation path so a
   * `usage.created` outbox event is committed atomically (status `completed`,
   * so it never enters the worker queue). Returns the node id.
   */
  const persistUsageNode = async (args: {
    namespace: string;
    threadId: string;
    name: string;
    data: Record<string, unknown>;
    agentId: string | null;
    initiatedById: string | null;
  }): Promise<string> => {
    const created = await ops.mutate.graph.createNode(
      {
        namespace: args.namespace,
        type: "usage",
        name: args.name,
        data: args.data,
        sourceType: "thread",
        sourceId: args.threadId,
      },
      { threadId: args.threadId, namespace: args.namespace },
    );
    const nodeId = created.id as string;
    await ops.unsafeGraph.createEdge({
      sourceNodeId: args.threadId,
      targetNodeId: nodeId,
      type: GRAPH_EDGE.HAS_USAGE,
    }).catch(() => undefined);
    await createUsageParticipantEdges({
      namespace: args.namespace,
      usageNodeId: nodeId,
      agentId: args.agentId,
      initiatedById: args.initiatedById,
    });
    return nodeId;
  };

  return {
    async createUsageRecord(input: {
      threadId: string;
      eventId: string | null;
      agentId: string | null;
      runSender?: Record<string, unknown> | null;
      provider: string | null;
      model: string | null;
      usage: TokenUsage;
      cost?: CostBreakdown | null;
      dedupeKey?: string | null;
    }): Promise<string | null> {
      const { namespace, threadMetadata } = await resolveThreadContext(
        input.threadId,
      );
      const initiatedById = resolveInitiatedById({
        runSender: input.runSender ?? null,
        threadMetadata,
      });

      const event: UsageEvent = {
        kind: "llm",
        resource: input.model ?? input.provider ?? "unknown",
        provider: input.provider,
        operation: "chat",
        status: input.usage.status,
        statusReason: input.usage.statusReason ?? null,
        threadId: input.threadId,
        eventId: input.eventId,
        agentId: input.agentId,
        initiatedById,
        runSender: input.runSender ?? null,
        metrics: tokenMetrics(input.usage),
        cost: costBreakdownToUsageCost(input.cost),
        dedupeKey: input.dedupeKey ?? null,
        raw: input.usage.rawUsage ?? null,
      };
      const hooked = await applyHooks(event, input.usage);
      if (!hooked) return null;

      const effectiveCost = (usageOptions?.resolveCost || usageOptions?.onRecord)
        ? usageCostToBreakdown(hooked.cost)
        : input.cost ?? null;

      const data = buildUsageData({
        ...input,
        initiatedById,
        cost: effectiveCost,
      });
      data.metrics = hooked.metrics;

      return await persistUsageNode({
        namespace,
        threadId: input.threadId,
        name: `${input.usage.status}:${input.provider ?? "unknown"}:${
          input.model ?? "unknown"
        }`,
        data,
        agentId: input.agentId,
        initiatedById,
      });
    },

    /**
     * Records a metered usage event for any resource family (tools, assets,
     * RAG, ...). Resolves cost via the configured hook, persists a `usage`
     * ledger node with the outbox durability semantics, and returns the id.
     */
    async recordUsage(event: UsageEvent): Promise<string | null> {
      const { namespace, threadMetadata } = await resolveThreadContext(
        event.threadId,
      );
      const initiatedById = resolveInitiatedById({
        initiatedById: event.initiatedById,
        runSender: event.runSender ?? null,
        threadMetadata,
      });
      const hooked = await applyHooks(event, event.raw);
      if (!hooked) return null;

      const cost = hooked.cost;
      const data: Record<string, unknown> = {
        kind: event.kind,
        resource: event.resource,
        operation: event.operation ?? null,
        provider: event.provider ?? null,
        model: event.kind === "llm" ? event.resource : null,
        status: event.status ?? null,
        statusReason: event.statusReason ?? null,
        threadId: event.threadId,
        eventId: event.eventId ?? null,
        messageId: event.messageId ?? null,
        agentId: event.agentId ?? null,
        initiatedById,
        metrics: hooked.metrics,
        // Flat token fields (present only for token-metered kinds).
        inputTokens: hooked.metrics.inputTokens ?? null,
        outputTokens: hooked.metrics.outputTokens ?? null,
        reasoningTokens: hooked.metrics.reasoningTokens ?? null,
        cacheReadInputTokens: hooked.metrics.cacheReadInputTokens ?? null,
        cacheCreationInputTokens: hooked.metrics.cacheCreationInputTokens ?? null,
        totalTokens: hooked.metrics.totalTokens ?? null,
        // Flat cost fields.
        inputCostUsd: cost?.breakdown?.inputCostUsd ?? null,
        outputCostUsd: cost?.breakdown?.outputCostUsd ?? null,
        reasoningCostUsd: cost?.breakdown?.reasoningCostUsd ?? null,
        cacheReadInputCostUsd: cost?.breakdown?.cacheReadInputCostUsd ?? null,
        cacheCreationInputCostUsd: cost?.breakdown?.cacheCreationInputCostUsd ??
          null,
        totalCostUsd: cost?.total ?? null,
        pricingModelId: cost?.pricingModelId ?? null,
        pricingSource: cost?.source ?? null,
        pricingCurrency: cost?.currency ?? null,
        dedupeKey: event.dedupeKey ?? null,
        occurredAt: event.occurredAt ?? new Date().toISOString(),
        metricsFinalizedAt: null,
      };

      return await persistUsageNode({
        namespace,
        threadId: event.threadId,
        name: `${event.kind}:${event.resource}`,
        data,
        agentId: event.agentId ?? null,
        initiatedById,
      });
    },
    async updateUsageRecordMetrics(input: {
      usageNodeId: string;
      threadId: string;
      eventId: string | null;
      agentId: string | null;
      runSender?: Record<string, unknown> | null;
      provider: string | null;
      model: string | null;
      usage: TokenUsage;
      cost?: CostBreakdown | null;
      finalizedAt: string;
    }): Promise<void> {
      const { threadMetadata } = await resolveThreadContext(input.threadId);
      const initiatedById = resolveInitiatedById({
        runSender: input.runSender ?? null,
        threadMetadata,
      });
      await ops.unsafeGraph.updateNode(input.usageNodeId, {
        name: `${input.usage.status}:${input.provider ?? "unknown"}:${
          input.model ?? "unknown"
        }`,
        data: buildUsageData({
          threadId: input.threadId,
          eventId: input.eventId,
          agentId: input.agentId,
          initiatedById,
          provider: input.provider,
          model: input.model,
          usage: input.usage,
          cost: input.cost ?? null,
          metricsFinalizedAt: input.finalizedAt,
        }),
      });
    },
  };
}

/**
 * @deprecated Prefer {@link createUsageService}. Retained for backward
 * compatibility; the LLM usage path is now part of the unified usage ledger.
 */
export const createLlmUsageService = createUsageService;
