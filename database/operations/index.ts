import type {
  KnowledgeEdge,
  KnowledgeNode,
  NewKnowledgeEdge,
  NewKnowledgeNode,
  NewQueue,
  NewThread,
  Queue,
  Thread,
} from "../schemas/index.ts";
import type {
  Document,
  DocumentChunk,
  Message,
  NewDocument,
  NewDocumentChunk,
  NewMessage,
  RagScope,
} from "@/types/index.ts";
import type { DbInstance } from "../index.ts";
import { ulid } from "ulid";
import { GRAPH_EDGE } from "@/runtime/graph/edges.ts";
import { sanitizePostgresParam } from "../postgres-json-safety.ts";

const MAX_EXPIRED_CLEANUP_BATCH = 100;
const EXPIRED_RETENTION_INTERVAL = "1 day";

type MessageInsert =
  & Omit<NewMessage, "id">
  & { id?: string };
export type ThreadInsert = NewThread & {
  name?: string;
  description?: string | null;
  participants?: string[] | null;
  initialMessage?: string | null;
  summary?: string | null;
  metadata?: Record<string, unknown> | null;
};

export interface QueueEventInput {
  eventType: Queue["eventType"];
  payload: Queue["payload"];
  parentEventId?: string;
  traceId?: string;
  priority?: number;
  metadata?: Queue["metadata"] | undefined;
  ttlMs?: number;
  expiresAt?: Date | string | null;
  status?: Queue["status"];
  /** Namespace for multi-tenant isolation */
  namespace?: string;
}

export type ThreadActivityStatus = "idle" | "running" | "failed";

export interface ThreadActivityEvent extends Record<string, unknown> {
  id: string;
  eventType: string;
  status: Queue["status"];
  priority: number | null;
  traceId: string | null;
  parentEventId: string | null;
  createdAt: string | Date;
  updatedAt: string | Date;
}

export interface ThreadActivity {
  threadId: string;
  status: ThreadActivityStatus;
  activeCount: number;
  activeEvents?: ThreadActivityEvent[];
  lastFailure: ThreadActivityEvent | null;
  updatedAt: string;
}

export interface ThreadActivityOptions {
  namespace?: string;
  minPriority?: number;
  includeEvents?: boolean;
}

export interface NewerInterruptingEventOptions {
  namespace?: string;
  minPriority?: number;
  interruptMode?: "abort" | "soft";
}

// RAG types
export interface ChunkSearchOptions {
  query?: string;
  embedding?: number[];
  /** Tenant/application namespace. */
  namespace?: string;
  /** Graph roots used to resolve eligible documents/chunks. */
  scope?: RagScope;
  /** @deprecated Namespace no longer models RAG grouping. Use namespace + scope. */
  namespaces?: string[];
  limit?: number;
  threshold?: number;
  documentFilters?: {
    sourceType?: string;
    mimeType?: string;
    status?: string;
  };
}

export interface ChunkSearchResult {
  id: string;
  content: string;
  namespace: string;
  chunkIndex: number;
  similarity: number;
  tokenCount?: number | null;
  metadata?: Record<string, unknown> | null;
  document?: {
    id: string;
    title?: string | null;
    sourceUri?: string | null;
    sourceType: string;
    mimeType?: string | null;
  };
}

export interface NamespaceStats {
  namespace: string;
  documentCount: number;
  chunkCount: number;
  lastUpdated: Date | null;
}

export interface MessageHistoryPageOptions {
  limit?: number;
  before?: string | null;
}

export interface MessageHistoryPageInfo {
  hasMoreBefore: boolean;
  oldestMessageId: string | null;
  newestMessageId: string | null;
}

export interface MessageHistoryPage {
  data: Message[];
  pageInfo: MessageHistoryPageInfo;
}

// ============================================
// KNOWLEDGE GRAPH TYPES
// ============================================

/** Options for querying the knowledge graph */
export interface GraphQueryOptions {
  /** Natural language query for semantic search */
  query?: string;
  /** Pre-computed embedding vector */
  embedding?: number[];
  /** Namespace(s) to search within */
  namespaces?: string[];
  /** Filter by node types (e.g., 'chunk', 'entity', 'concept') */
  nodeTypes?: string[];
  /** Edge types to traverse (e.g., 'mentions', 'caused') */
  edgeTypes?: string[];
  /** Maximum traversal depth (0 = vector search only) */
  maxDepth?: number;
  /** Maximum number of results */
  limit?: number;
  /** Minimum similarity threshold for vector search */
  minSimilarity?: number;
}

/** Result from graph retrieval */
export interface GraphQueryResult {
  /** The retrieved node */
  node: KnowledgeNode;
  /** Similarity score (if from vector search) */
  similarity?: number;
  /** Depth from seed node (0 = seed itself) */
  depth: number;
  /** Path of edge types from seed to this node */
  path: string[];
}

/** Result from graph traversal */
export interface TraversalResult {
  nodes: KnowledgeNode[];
  edges: KnowledgeEdge[];
}

export type QueryResult<
  T extends Record<string, unknown> = Record<string, unknown>,
> = {
  rows: T[];
  rowCount?: number;
};

export interface OutboxEventInput {
  threadId: string;
  eventType: string;
  subjectType?: string | null;
  subjectId?: string | null;
  operation?:
    | "created"
    | "updated"
    | "deleted"
    | "completed"
    | "failed"
    | string
    | null;
  payload?: Record<string, unknown>;
  input?: unknown;
  before?: unknown;
  after?: unknown;
  patch?: unknown;
  parentEventId?: string | null;
  traceId?: string | null;
  causationId?: string | null;
  correlationId?: string | null;
  dedupeKey?: string | null;
  priority?: number | null;
  metadata?: Record<string, unknown> | null;
  ttlMs?: number | null;
  expiresAt?: Date | string | null;
  status?: Queue["status"];
  namespace?: string | null;
}

type LifecycleOperation = NonNullable<OutboxEventInput["operation"]>;

type DomainLifecycleEventInput =
  & Omit<OutboxEventInput, "eventType" | "operation" | "subjectType">
  & {
    subjectType: string;
    operation: LifecycleOperation;
  };

type DomainMutationCommit<T> = {
  result: T;
  event?: DomainLifecycleEventInput | null;
};

export interface LlmAttemptInput {
  id?: string;
  threadId: string;
  messageId?: string | null;
  eventId?: string | null;
  agentId?: string | null;
  agentName?: string | null;
  provider?: string | null;
  model?: string | null;
  config?: Record<string, unknown> | null;
  messages?: unknown;
  tools?: unknown;
  status?: string | null;
  attemptIndex?: number | null;
  parentAttemptId?: string | null;
  runSender?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
  namespace?: string | null;
}

export interface LlmAttemptPatch {
  status?: string | null;
  provider?: string | null;
  model?: string | null;
  finishReason?: string | null;
  answer?: string | null;
  reasoning?: string | null;
  partialAnswer?: string | null;
  partialReasoning?: string | null;
  toolCalls?: unknown;
  usage?: unknown;
  cost?: unknown;
  error?: unknown;
  metricsFinalizedAt?: string | Date | null;
  startedAt?: string | Date | null;
  finishedAt?: string | Date | null;
  metadata?: Record<string, unknown> | null;
}

export interface ToolExecutionInput {
  id?: string;
  threadId: string;
  messageId?: string | null;
  eventId?: string | null;
  agentId?: string | null;
  agentName?: string | null;
  toolCallId: string;
  tool: Record<string, unknown>;
  args?: unknown;
  status?: string | null;
  metadata?: Record<string, unknown> | null;
  namespace?: string | null;
}

export interface ToolExecutionPatch {
  status?: string | null;
  output?: unknown;
  error?: unknown;
  projectedOutput?: unknown;
  historyVisibility?: string | null;
  startedAt?: string | Date | null;
  finishedAt?: string | Date | null;
  durationMs?: number | null;
  metadata?: Record<string, unknown> | null;
}

export interface ThreadMutationOptions {
  traceId?: string | null;
  causationId?: string | null;
  namespace?: string | null;
}

export interface GraphMutationOptions extends ThreadMutationOptions {
  /** Queue/outbox topic for this mutation. Often a conversation thread id. */
  threadId: string;
  correlationId?: string | null;
  metadata?: Record<string, unknown> | null;
}

export type ThreadCreateInput = ThreadInsert;
export type ThreadUpdateInput = Partial<ThreadInsert>;
export type ThreadForkInput = Partial<ThreadInsert> & {
  sourceThreadId: string;
};

export interface DomainMutationOperations {
  threads: {
    create: (
      threadId: string | undefined,
      threadData: ThreadCreateInput,
      options?: ThreadMutationOptions,
    ) => Promise<Thread>;
    update: (
      threadId: string,
      updates: ThreadUpdateInput,
      options?: ThreadMutationOptions,
    ) => Promise<Thread | null>;
    fork: (
      input: ThreadForkInput,
      options?: ThreadMutationOptions,
    ) => Promise<Thread>;
    ensureGraphNode: (
      thread: Thread,
      options?: {
        metadata?: Record<string, unknown> | null;
        namespace?: string | null;
      },
    ) => Promise<KnowledgeNode>;
  };
  messages: {
    create: (
      message: MessageInsert,
      namespace?: string | null,
      options?: { traceId?: string | null; causationId?: string | null },
    ) => Promise<Message>;
    appendSegments: (
      messageId: string,
      segments: unknown[],
      options?: {
        threadId?: string | null;
        namespace?: string | null;
        traceId?: string | null;
        causationId?: string | null;
      },
    ) => Promise<KnowledgeNode | undefined>;
  };
  llmAttempts: {
    create: (input: LlmAttemptInput) => Promise<KnowledgeNode>;
    update: (
      id: string,
      patch: LlmAttemptPatch,
      options?: {
        threadId?: string | null;
        traceId?: string | null;
        causationId?: string | null;
        namespace?: string | null;
      },
    ) => Promise<KnowledgeNode | undefined>;
    complete: (
      id: string,
      patch: LlmAttemptPatch,
      options?: {
        threadId?: string | null;
        traceId?: string | null;
        causationId?: string | null;
        namespace?: string | null;
      },
    ) => Promise<KnowledgeNode | undefined>;
    fail: (
      id: string,
      patch: LlmAttemptPatch,
      options?: {
        threadId?: string | null;
        traceId?: string | null;
        causationId?: string | null;
        namespace?: string | null;
      },
    ) => Promise<KnowledgeNode | undefined>;
  };
  toolExecutions: {
    create: (input: ToolExecutionInput) => Promise<KnowledgeNode>;
    update: (
      id: string,
      patch: ToolExecutionPatch,
      options?: {
        threadId?: string | null;
        traceId?: string | null;
        causationId?: string | null;
        namespace?: string | null;
      },
    ) => Promise<KnowledgeNode | undefined>;
    complete: (
      id: string,
      patch: ToolExecutionPatch,
      options?: {
        threadId?: string | null;
        traceId?: string | null;
        causationId?: string | null;
        namespace?: string | null;
      },
    ) => Promise<KnowledgeNode | undefined>;
    fail: (
      id: string,
      patch: ToolExecutionPatch,
      options?: {
        threadId?: string | null;
        traceId?: string | null;
        causationId?: string | null;
        namespace?: string | null;
      },
    ) => Promise<KnowledgeNode | undefined>;
    getOutput: (
      id: string,
      threadId: string,
    ) => Promise<
      { node: KnowledgeNode; output: unknown; projectedOutput?: unknown } | null
    >;
  };
  assets: {
    create: (input: {
      id?: string;
      threadId: string;
      ref?: string | null;
      mime?: string | null;
      by?: string | null;
      toolCallId?: string | null;
      metadata?: Record<string, unknown> | null;
      namespace?: string | null;
    }) => Promise<KnowledgeNode>;
  };
  graph: {
    createNode: (
      node: Omit<NewKnowledgeNode, "id"> & { id?: string },
      options: GraphMutationOptions,
    ) => Promise<KnowledgeNode>;
    updateNode: (
      id: string,
      updates: Partial<NewKnowledgeNode>,
      options: GraphMutationOptions,
    ) => Promise<KnowledgeNode | undefined>;
    deleteNode: (
      id: string,
      options: GraphMutationOptions,
    ) => Promise<void>;
    createEdge: (
      edge: Omit<NewKnowledgeEdge, "id"> & { id?: string },
      options: GraphMutationOptions,
    ) => Promise<KnowledgeEdge>;
    deleteEdge: (
      id: string,
      options: GraphMutationOptions,
    ) => Promise<void>;
  };
}

/**
 * Low-level graph operations that bypass domain mutation/outbox semantics.
 *
 * Use these only for admin/debug tooling, migrations, read-oriented graph
 * exploration, or non-thread-scoped knowledge nodes. Thread-scoped durable
 * workflow state should go through `ops.mutate.*` so the graph/table mutation
 * and `<subjectType>.<operation>` outbox row are committed atomically.
 */
export interface UnsafeGraphOperations {
  createNode: (
    node: Omit<NewKnowledgeNode, "id"> & { id?: string },
  ) => Promise<KnowledgeNode>;
  createNodes: (
    nodes: Array<Omit<NewKnowledgeNode, "id"> & { id?: string }>,
  ) => Promise<KnowledgeNode[]>;
  getNodeById: (id: string) => Promise<KnowledgeNode | undefined>;
  getNodesByNamespace: (
    namespace: string,
    type?: string,
  ) => Promise<KnowledgeNode[]>;
  updateNode: (
    id: string,
    updates: Partial<NewKnowledgeNode>,
  ) => Promise<KnowledgeNode | undefined>;
  deleteNode: (id: string) => Promise<void>;
  deleteNodesBySource: (sourceType: string, sourceId: string) => Promise<void>;
  createEdge: (
    edge: Omit<NewKnowledgeEdge, "id"> & { id?: string },
  ) => Promise<KnowledgeEdge>;
  createEdges: (
    edges: Array<Omit<NewKnowledgeEdge, "id"> & { id?: string }>,
  ) => Promise<KnowledgeEdge[]>;
  getEdgesForNode: (
    nodeId: string,
    direction?: "in" | "out" | "both",
    types?: string[],
  ) => Promise<KnowledgeEdge[]>;
  deleteEdge: (id: string) => Promise<void>;
  deleteEdgesForNode: (nodeId: string) => Promise<void>;
  searchNodes: (options: GraphQueryOptions) => Promise<GraphQueryResult[]>;
  traverseGraph: (
    startNodeId: string,
    edgeTypes?: string[],
    maxDepth?: number,
  ) => Promise<TraversalResult>;
  findRelatedNodes: (
    nodeId: string,
    depth?: number,
  ) => Promise<KnowledgeNode[]>;
}

export interface OutboxOperations {
  append: (event: OutboxEventInput) => Promise<Queue>;
}

export interface DatabaseOperations {
  crud: DbInstance["crud"];
  query: <T extends Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ) => Promise<QueryResult<T>>;
  transaction: <T>(fn: (ops: DatabaseOperations) => Promise<T>) => Promise<T>;
  outbox: OutboxOperations;
  mutate: DomainMutationOperations;
  unsafeGraph: UnsafeGraphOperations;
  addToQueue: (threadId: string, event: QueueEventInput) => Promise<NewQueue>;
  getQueueItemById: (queueId: string) => Promise<Queue | undefined>;
  getQueueItemsByTraceId: (traceId: string) => Promise<Queue[]>;
  getNewerInterruptingEvent: (
    threadId: string,
    since: string | Date,
    options?: NewerInterruptingEventOptions,
  ) => Promise<Queue | undefined>;
  hasNewerHumanInput: (
    threadId: string,
    since: string | Date,
    namespace?: string,
  ) => Promise<boolean>;
  overwritePendingAgentContinuations: (
    threadId: string,
    since: string | Date,
    namespace?: string,
  ) => Promise<number>;
  getProcessingQueueItem: (
    threadId: string,
    minPriority?: number,
  ) => Promise<Queue | undefined>;
  getThreadActivity: (
    threadId: string,
    options?: ThreadActivityOptions,
  ) => Promise<ThreadActivity>;
  getNextPendingQueueItem: (
    threadId: string,
    namespace?: string,
    minPriority?: number,
  ) => Promise<Queue | undefined>;
  updateQueueItemStatus: (
    queueId: string,
    status: Queue["status"],
  ) => Promise<void>;
  mergeQueueItemMetadata: (
    queueId: string,
    metadata: Record<string, unknown>,
  ) => Promise<void>;
  /**
   * Acquire an exclusive worker lease for a thread.
   * Returns false when another worker holds an active lease.
   */
  acquireThreadWorkerLease: (
    threadId: string,
    workerId: string,
  ) => Promise<boolean>;
  /** Renew an existing thread worker lease (only succeeds for the current lease owner). */
  renewThreadWorkerLease: (
    threadId: string,
    workerId: string,
  ) => Promise<boolean>;
  /** Check whether the worker still owns an active lease for the thread. */
  isThreadWorkerLeaseOwner: (
    threadId: string,
    workerId: string,
  ) => Promise<boolean>;
  /** Release a thread worker lease (best-effort; only affects the current lease owner). */
  releaseThreadWorkerLease: (
    threadId: string,
    workerId: string,
  ) => Promise<void>;
  /**
   * Release a thread worker lease only when no eligible pending work remains.
   * Returns true when the lease was released, false when the worker should keep polling.
   */
  releaseThreadWorkerLeaseIfNoPendingWork: (
    threadId: string,
    workerId: string,
    minPriority?: number,
  ) => Promise<boolean>;
  /** Get effective thread worker lease configuration. */
  getThreadWorkerLeaseConfig: () => { leaseMs: number; heartbeatMs: number };
  /** Crash recovery: reset stale "processing" queue items for a thread back to "pending". */
  recoverThreadProcessingQueueItems: (threadId: string) => Promise<number>;
  getMessageHistory: (
    threadId: string,
    userId: string,
    limit?: number,
  ) => Promise<Message[]>;
  getThreadsForParticipant: (
    participantId: string,
    options?: {
      status?: Thread["status"] | "all";
      limit?: number;
      offset?: number;
      order?: "asc" | "desc";
    },
  ) => Promise<Thread[]>;
  getMessagesForThread: (
    threadId: string,
    options?: {
      limit?: number;
      offset?: number;
      order?: "asc" | "desc";
    },
  ) => Promise<Message[]>;
  deleteMessagesForThread: (threadId: string) => Promise<void>;
  getThreadById: (threadId: string) => Promise<Thread | undefined>;
  getThreadByExternalId: (
    externalId: string,
    namespace?: string,
  ) => Promise<Thread | undefined>;
  findOrCreateThread: (
    threadId: string | undefined,
    threadData: ThreadInsert,
    options?: ThreadMutationOptions,
  ) => Promise<Thread>;
  updateThread: (
    threadId: string,
    updates: Partial<ThreadInsert>,
    options?: ThreadMutationOptions,
  ) => Promise<Thread | null>;
  deleteThread: (threadId: string) => Promise<void>;
  createMessage: (
    message: MessageInsert,
    namespace?: string,
  ) => Promise<Message>;
  archiveThread: (threadId: string, summary: string) => Promise<Thread | null>;
  /** Return pending NEW_MESSAGE queue events in this thread (excluding current), oldest first. */
  peekCoalescableCandidates: (
    threadId: string,
    currentEventId: string,
    namespace?: string,
  ) => Promise<Queue[]>;
  /** Atomically mark a batch of pending queue events as completed. Returns IDs actually claimed. */
  claimAndCompleteEventsBatch: (ids: string[]) => Promise<string[]>;

  // ============================================
  // PARTICIPANT NODE OPERATIONS (Unified users & agents)
  // ============================================

  /**
   * @deprecated Use `copilotz.collections.participant.upsertIdentity` instead.
   * Find or create a participant node in the graph (human or agent).
   * This is the preferred method for creating participant nodes.
   *
   * - Human participants: Store user identity with optional metadata
   * - Agent participants: Store agent identity with persistent memory
   *
   * @param externalId - External identifier (user ID or agent ID/name)
   * @param participantType - "human", "agent", or "job"
   * @param namespace - Tenant/application namespace. Required for participant identity.
   * @param data - Participant data
   */
  upsertParticipantNode: (
    externalId: string,
    participantType: "human" | "agent" | "job",
    namespace: string | null,
    data: {
      name?: string | null;
      email?: string | null; // humans only
      agentId?: string | null; // agents only
      metadata?: Record<string, unknown> | null;
    },
  ) => Promise<KnowledgeNode>;

  /**
   * @deprecated Use `copilotz.collections.participant.resolveByExternalId` instead.
   * Get a participant node by externalId.
   * Works for both humans and agents.
   * Looks only inside the provided tenant namespace.
   */
  getParticipantNode: (
    externalId: string,
    namespace?: string | null,
  ) => Promise<KnowledgeNode | undefined>;

  /**
   * @deprecated Use `copilotz.collections.participant` for participant management.
   * Compatibility helper for one-off migrations from legacy graph-backed user
   * nodes into the participant collection. Does not read the collection layer.
   */
  listLegacyParticipantGraphNodes: (
    options?: { namespace?: string; limit?: number },
  ) => Promise<KnowledgeNode[]>;

  // RAG operations (legacy - use graph operations for new code)
  createDocument: (
    doc: Omit<NewDocument, "id"> & { id?: string },
  ) => Promise<Document>;
  getDocumentById: (id: string) => Promise<Document | undefined>;
  getDocumentByHash: (
    hash: string,
    namespace: string,
  ) => Promise<Document | undefined>;
  updateDocumentStatus: (
    id: string,
    status: Document["status"],
    errorMessage?: string,
    chunkCount?: number,
  ) => Promise<void>;
  deleteDocument: (id: string) => Promise<void>;
  createChunks: (
    chunks: Array<Omit<NewDocumentChunk, "id"> & { id?: string }>,
  ) => Promise<DocumentChunk[]>;
  searchChunks: (options: ChunkSearchOptions) => Promise<ChunkSearchResult[]>;
  getNamespaceStats: () => Promise<NamespaceStats[]>;
  deleteChunksByDocumentId: (documentId: string) => Promise<void>;

  // ============================================
  // MESSAGE AS NODE OPERATIONS
  // ============================================

  // Create message as a node (used internally by createMessage)
  // namespace: Tenant namespace for participant lookup and message storage.
  createMessageNode: (
    message: MessageInsert,
    previousMessageId?: string,
    namespace?: string,
  ) => Promise<KnowledgeNode>;
  // Get message history from graph (nodes with type='message')
  getMessageHistoryFromGraph: (
    threadId: string,
    limit?: number,
  ) => Promise<Message[]>;
  getMessageHistoryPageFromGraph: (
    threadId: string,
    options?: MessageHistoryPageOptions,
  ) => Promise<MessageHistoryPage>;
  // Get the last message node in a thread
  getLastMessageNode: (threadId: string) => Promise<KnowledgeNode | undefined>;

  // ============================================
  // CHUNK AS NODE OPERATIONS
  // ============================================

  // Search chunks from graph (nodes with type='chunk')
  searchChunksFromGraph: (
    options: ChunkSearchOptions,
  ) => Promise<ChunkSearchResult[]>;

  // ============================================
  // UNSAFE/LEGACY KNOWLEDGE GRAPH OPERATIONS
  // ============================================
  //
  // These flat aliases bypass domain mutation outbox semantics. Prefer
  // `ops.mutate.*` for durable workflow state and `ops.unsafeGraph.*` when a
  // low-level graph write is intentionally needed.

  /** @deprecated Use `ops.unsafeGraph.createNode` or `ops.mutate.*`. */
  createNode: (
    node: Omit<NewKnowledgeNode, "id"> & { id?: string },
  ) => Promise<KnowledgeNode>;
  /** @deprecated Use `ops.unsafeGraph.createNodes` or `ops.mutate.*`. */
  createNodes: (
    nodes: Array<Omit<NewKnowledgeNode, "id"> & { id?: string }>,
  ) => Promise<KnowledgeNode[]>;
  /** @deprecated Use `ops.unsafeGraph.getNodeById` for low-level graph reads. */
  getNodeById: (id: string) => Promise<KnowledgeNode | undefined>;
  /** @deprecated Use `ops.unsafeGraph.getNodesByNamespace` for low-level graph reads. */
  getNodesByNamespace: (
    namespace: string,
    type?: string,
  ) => Promise<KnowledgeNode[]>;
  /** @deprecated Use `ops.unsafeGraph.updateNode` or `ops.mutate.*`. */
  updateNode: (
    id: string,
    updates: Partial<NewKnowledgeNode>,
  ) => Promise<KnowledgeNode | undefined>;
  /** @deprecated Use `ops.unsafeGraph.deleteNode` or a domain mutation. */
  deleteNode: (id: string) => Promise<void>;
  /** @deprecated Use `ops.unsafeGraph.deleteNodesBySource` or a domain mutation. */
  deleteNodesBySource: (sourceType: string, sourceId: string) => Promise<void>;

  /** @deprecated Use `ops.unsafeGraph.createEdge` or a domain mutation. */
  createEdge: (
    edge: Omit<NewKnowledgeEdge, "id"> & { id?: string },
  ) => Promise<KnowledgeEdge>;
  /** @deprecated Use `ops.unsafeGraph.createEdges` or a domain mutation. */
  createEdges: (
    edges: Array<Omit<NewKnowledgeEdge, "id"> & { id?: string }>,
  ) => Promise<KnowledgeEdge[]>;
  /** @deprecated Use `ops.unsafeGraph.getEdgesForNode` for low-level graph reads. */
  getEdgesForNode: (
    nodeId: string,
    direction?: "in" | "out" | "both",
    types?: string[],
  ) => Promise<KnowledgeEdge[]>;
  /** @deprecated Use `ops.unsafeGraph.deleteEdge` or a domain mutation. */
  deleteEdge: (id: string) => Promise<void>;
  /** @deprecated Use `ops.unsafeGraph.deleteEdgesForNode` or a domain mutation. */
  deleteEdgesForNode: (nodeId: string) => Promise<void>;

  /** @deprecated Use `ops.unsafeGraph.searchNodes` for low-level graph reads. */
  searchNodes: (options: GraphQueryOptions) => Promise<GraphQueryResult[]>;
  /** @deprecated Use `ops.unsafeGraph.traverseGraph` for low-level graph reads. */
  traverseGraph: (
    startNodeId: string,
    edgeTypes?: string[],
    maxDepth?: number,
  ) => Promise<TraversalResult>;
  /** @deprecated Use `ops.unsafeGraph.findRelatedNodes` for low-level graph reads. */
  findRelatedNodes: (
    nodeId: string,
    depth?: number,
  ) => Promise<KnowledgeNode[]>;
}

const toIsoString = (
  value: Date | string | null | undefined,
): string | null => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

export function createOperations(
  db: DbInstance,
  config?: {
    staleProcessingThresholdMs?: number;
    threadLeaseMs?: number;
    threadLeaseHeartbeatMs?: number;
  },
): DatabaseOperations {
  const { crud } = db;
  const STALE_PROCESSING_THRESHOLD_MS = config?.staleProcessingThresholdMs ??
    300000; // Default: 5 minutes
  const THREAD_WORKER_LEASE_MS = config?.threadLeaseMs ?? 60_000; // Default: 1 minute
  const THREAD_WORKER_HEARTBEAT_MS = config?.threadLeaseHeartbeatMs ?? 15_000; // Default: 15 seconds
  let operations: DatabaseOperations;

  const cleanupExpiredQueueItems = async (): Promise<void> => {
    await db.query(
      `DELETE FROM "events"
       WHERE "id" IN (
         SELECT "id" FROM "events"
         WHERE "status" = 'expired'
           AND "expiresAt" IS NOT NULL
           AND "expiresAt" < NOW() - INTERVAL '${EXPIRED_RETENTION_INTERVAL}'
                LIMIT ${MAX_EXPIRED_CLEANUP_BATCH}
       )`,
    );
  };

  const markQueueItemExpired = async (queueId: string): Promise<void> => {
    await db.query(
      `UPDATE "events"
       SET "status" = 'expired',
           "expiresAt" = COALESCE("expiresAt", NOW()),
           "updatedAt" = NOW()
       WHERE "id" = $1`,
      [queueId],
    );
    await cleanupExpiredQueueItems();
  };

  const addToQueue = async (
    threadId: string,
    event: QueueEventInput,
  ): Promise<NewQueue> => {
    const ttlMs = typeof event.ttlMs === "number" && event.ttlMs > 0
      ? Math.floor(event.ttlMs)
      : null;

    const expiresAt = event.expiresAt
      ? toIsoString(event.expiresAt)
      : ttlMs
      ? new Date(Date.now() + ttlMs).toISOString()
      : null;

    const insertQueueItem = {
      threadId,
      eventType: event.eventType,
      payload: sanitizePostgresParam(event.payload),
      parentEventId: event.parentEventId ?? null,
      traceId: event.traceId ?? null,
      priority: event.priority ?? null,
      ttlMs,
      expiresAt: expiresAt ? new Date(expiresAt) : null,
      status: event.status ?? "pending",
      metadata: event.metadata ? sanitizePostgresParam(event.metadata) : null,
      namespace: event.namespace ?? null,
    };

    const newQueueItem = await crud.events.create(insertQueueItem);

    await cleanupExpiredQueueItems();
    return newQueueItem;
  };

  const getQueueItemById = async (
    queueId: string,
  ): Promise<Queue | undefined> => {
    const item = await crud.events.findOne({ id: queueId }) as Queue | null;
    return item ?? undefined;
  };

  const getQueueItemsByTraceId = async (
    traceId: string,
  ): Promise<Queue[]> => {
    const items = await crud.events.find({ traceId }) as Queue[];
    return items;
  };

  const getNewerInterruptingEvent = async (
    threadId: string,
    since: string | Date,
    options: NewerInterruptingEventOptions = {},
  ): Promise<Queue | undefined> => {
    const sinceIso = toIsoString(since);
    if (!sinceIso) {
      return undefined;
    }

    const minPriority = options.minPriority ?? 2000;
    const params: unknown[] = [threadId, sinceIso, minPriority];
    const filters = [
      `"threadId" = $1`,
      `"createdAt" > ($2::timestamptz)`,
      `"status" IN ('pending', 'processing', 'completed')`,
      `COALESCE("priority", 0) >= $3`,
      `(
        "metadata"->>'interruptsActiveWork' = 'true'
        OR (
          "eventType" = 'NEW_MESSAGE'
          AND ("payload"->'sender'->>'type') IN ('user', 'job')
        )
      )`,
    ];

    if (options.namespace !== undefined) {
      params.push(options.namespace);
      filters.push(`"namespace" = $${params.length}`);
    }

    if (options.interruptMode) {
      params.push(options.interruptMode);
      filters.push(
        `COALESCE("metadata"->>'interruptMode', 'abort') = $${params.length}`,
      );
    }

    const result = await db.query<Queue>(
      `SELECT *
       FROM "events"
       WHERE ${filters.join(" AND ")}
       ORDER BY "createdAt" ASC, "id" ASC
       LIMIT 1`,
      params,
    );

    return result.rows[0] as Queue | undefined;
  };

  const hasNewerHumanInput = async (
    threadId: string,
    since: string | Date,
    namespace?: string,
  ): Promise<boolean> => {
    const event = await getNewerInterruptingEvent(threadId, since, {
      namespace,
      minPriority: -2147483648,
    });
    return Boolean(event);
  };

  const overwritePendingAgentContinuations = async (
    threadId: string,
    since: string | Date,
    namespace?: string,
  ): Promise<number> => {
    const sinceIso = toIsoString(since);
    if (!sinceIso) {
      return 0;
    }

    const params: unknown[] = [threadId, sinceIso];
    const namespaceClause = namespace ? `AND "namespace" = $3` : "";
    if (namespace) {
      params.push(namespace);
    }

    const result = await db.query<{ id: string }>(
      `UPDATE "events"
       SET "status" = 'overwritten',
           "updatedAt" = NOW()
       WHERE "threadId" = $1
         AND "createdAt" < ($2::timestamptz)
         AND "status" = 'pending'
         AND "eventType" IN ('LLM_CALL', 'TOOL_CALL')
         ${namespaceClause}
       RETURNING "id"`,
      params,
    );

    return result.rows.length;
  };

  const hasVisibleLlmProgress = (event: Queue): boolean => {
    if (event.eventType !== "LLM_CALL") return false;
    const metadata = event.metadata;
    return Boolean(
      metadata &&
        typeof metadata === "object" &&
        !Array.isArray(metadata) &&
        (metadata as Record<string, unknown>).visibleOutputStarted === true,
    );
  };

  const failVisibleProgressRecovery = async (
    event: Queue,
    reason: string,
  ): Promise<void> => {
    const metadata = event.metadata && typeof event.metadata === "object" &&
        !Array.isArray(event.metadata)
      ? event.metadata as Record<string, unknown>
      : {};
    await crud.events.update(
      { id: event.id },
      {
        status: "failed",
        metadata: sanitizePostgresParam({
          ...metadata,
          recoverySkipped: true,
          recoveryReason: reason,
        }),
        updatedAt: new Date(),
      },
    );
  };

  const recoverStaleProcessingQueueItems = async (
    threadId: string,
  ): Promise<number> => {
    const staleThreshold = new Date(Date.now() - STALE_PROCESSING_THRESHOLD_MS);
    const processingEvents = await crud.events.find({
      threadId,
      status: "processing",
    });

    let recovered = 0;
    for (const event of processingEvents) {
      const updatedAt = typeof event.updatedAt === "string"
        ? new Date(event.updatedAt)
        : event.updatedAt;

      if (!updatedAt || updatedAt >= staleThreshold) {
        continue;
      }

      if (hasVisibleLlmProgress(event as Queue)) {
        await failVisibleProgressRecovery(
          event as Queue,
          "visible_output_started",
        );
        console.warn(
          `[recovery] Marked visible-progress LLM event ${event.id} in thread ${threadId} as failed instead of replaying.`,
        );
        continue;
      }

      await crud.events.update(
        { id: event.id },
        {
          status: "pending",
          updatedAt: new Date(),
        },
      );
      recovered += 1;
      console.warn(
        `[recovery] Reset stale processing event ${event.id} in thread ${threadId} (stuck since ${updatedAt.toISOString()})`,
      );
    }

    return recovered;
  };

  const resetProcessingQueueItemsAfterLeaseTakeover = async (
    threadId: string,
  ): Promise<number> => {
    const processingEvents = await crud.events.find({
      threadId,
      status: "processing",
    }) as Queue[];
    let reset = 0;

    for (const event of processingEvents) {
      if (hasVisibleLlmProgress(event)) {
        await failVisibleProgressRecovery(event, "visible_output_started");
        console.warn(
          `[recovery] Marked visible-progress LLM event ${event.id} in thread ${threadId} as failed after lease takeover instead of replaying.`,
        );
        continue;
      }

      await crud.events.update(
        { id: event.id },
        {
          status: "pending",
          updatedAt: new Date(),
        },
      );
      reset += 1;
    }

    if (reset > 0) {
      console.warn(
        `[recovery] Reset ${reset} "processing" event(s) after expired worker lease takeover in thread ${threadId}.`,
      );
    }

    return reset;
  };

  const getProcessingQueueItem = async (
    threadId: string,
    minPriority?: number,
  ): Promise<Queue | undefined> => {
    await recoverStaleProcessingQueueItems(threadId);

    // Now check for any remaining processing events at or above minPriority
    const processingEvents = await crud.events.find({
      threadId,
      status: "processing",
    });

    // Filter by minPriority if specified (ignore background events being processed)
    const relevantEvents = minPriority !== undefined
      ? processingEvents.filter((e) => {
        const eventPriority = typeof e.priority === "number" ? e.priority : 0;
        return eventPriority >= minPriority;
      })
      : processingEvents;

    return (relevantEvents[0] as Queue) ?? undefined;
  };

  const getThreadActivity = async (
    threadId: string,
    options: ThreadActivityOptions = {},
  ): Promise<ThreadActivity> => {
    const minPriority = options.minPriority ?? 0;
    const params: unknown[] = [threadId, minPriority];
    const namespaceClause = options.namespace !== undefined
      ? ` AND "namespace" = $${params.push(options.namespace)}`
      : "";

    const activeResult = await db.query<ThreadActivityEvent>(
      `SELECT "id", "eventType", "status", "priority", "traceId", "parentEventId", "createdAt", "updatedAt"
       FROM "events"
       WHERE "threadId" = $1
         AND "status" IN ('pending', 'processing')
         AND COALESCE("priority", 0) >= $2
         ${namespaceClause}
       ORDER BY COALESCE("priority", 0) DESC, "createdAt" ASC, "id" ASC`,
      params,
    );

    const failureResult = await db.query<ThreadActivityEvent>(
      `SELECT "id", "eventType", "status", "priority", "traceId", "parentEventId", "createdAt", "updatedAt"
       FROM "events"
       WHERE "threadId" = $1
         AND "status" = 'failed'
         AND COALESCE("priority", 0) >= $2
         ${namespaceClause}
       ORDER BY "updatedAt" DESC, "createdAt" DESC, "id" DESC
       LIMIT 1`,
      params,
    );

    const activeEvents = activeResult.rows;
    const lastFailure = failureResult.rows[0] ?? null;
    const latestUpdatedAt = [
      activeEvents[0]?.updatedAt,
      lastFailure?.updatedAt,
    ]
      .map((value) => toIsoString(value))
      .filter((value): value is string => Boolean(value))
      .sort()
      .at(-1) ?? new Date().toISOString();

    return {
      threadId,
      status: activeEvents.length > 0
        ? "running"
        : lastFailure
        ? "failed"
        : "idle",
      activeCount: activeEvents.length,
      ...(options.includeEvents ? { activeEvents } : {}),
      lastFailure,
      updatedAt: latestUpdatedAt,
    };
  };

  const getNextPendingQueueItem = async (
    threadId: string,
    namespace?: string,
    minPriority?: number,
  ): Promise<Queue | undefined> => {
    while (true) {
      // Build filter with optional namespace
      const filter: Record<string, unknown> = {
        threadId,
        status: "pending",
      };
      if (namespace !== undefined) {
        filter.namespace = namespace;
      }

      // Use raw SQL with COALESCE so NULL-priority events (user messages) do NOT
      // sort before high-priority chain events (LLM_CALL, TOOL_CALL) due to
      // PostgreSQL's default NULLS FIRST behaviour on DESC sorts.
      const whereParams: unknown[] = [threadId];
      const whereParts: string[] = [`"threadId" = $1`, `"status" = 'pending'`];
      if (namespace !== undefined) {
        whereParts.push(`"namespace" = $${whereParams.length + 1}`);
        whereParams.push(namespace);
      }
      const pendingResult = await db.query<Queue>(
        `SELECT * FROM "events"
         WHERE ${whereParts.join(" AND ")}
         ORDER BY COALESCE("priority", 0) DESC, "createdAt" ASC, "id" ASC
         LIMIT 1`,
        whereParams,
      );
      const [candidate] = pendingResult.rows;

      if (!candidate) {
        await cleanupExpiredQueueItems();
        return undefined;
      }

      // Skip events below minimum priority threshold (for background processing)
      if (minPriority !== undefined) {
        const eventPriority = typeof candidate.priority === "number"
          ? candidate.priority
          : 0;
        if (eventPriority < minPriority) {
          // Leave background events for later processing
          return undefined;
        }
      }

      const expiresAtIso = typeof candidate.expiresAt === "string"
        ? candidate.expiresAt
        : null;
      if (expiresAtIso) {
        const expiresAtMs = new Date(expiresAtIso).getTime();
        if (!Number.isNaN(expiresAtMs) && expiresAtMs <= Date.now()) {
          await markQueueItemExpired(candidate.id as string);
          continue;
        }
      }

      return candidate as Queue;
    }
  };

  const updateQueueItemStatus = async (
    queueId: string,
    status: Queue["status"],
  ): Promise<void> => {
    await crud.events.update({ id: queueId }, { status });
  };

  const mergeQueueItemMetadata = async (
    queueId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> => {
    const item = await crud.events.findOne({ id: queueId }) as Queue | null;
    if (!item) return;
    const current = item.metadata && typeof item.metadata === "object" &&
        !Array.isArray(item.metadata)
      ? item.metadata as Record<string, unknown>
      : {};
    await crud.events.update(
      { id: queueId },
      {
        metadata: sanitizePostgresParam({ ...current, ...metadata }),
        updatedAt: new Date(),
      },
    );
  };

  const getThreadWorkerLeaseConfig = () => ({
    leaseMs: THREAD_WORKER_LEASE_MS,
    heartbeatMs: THREAD_WORKER_HEARTBEAT_MS,
  });

  const acquireThreadWorkerLease = async (
    threadId: string,
    workerId: string,
  ): Promise<boolean> => {
    const result = await db.query<{
      id: string;
      previousWorkerLockedBy: string | null;
    }>(
      `WITH eligible_thread AS (
         SELECT
           "id",
           "workerLockedBy" AS "previousWorkerLockedBy"
         FROM "threads"
         WHERE "id" = $1
           AND (
             "workerLeaseExpiresAt" IS NULL
             OR "workerLeaseExpiresAt" < NOW()
             OR "workerLockedBy" = $2
           )
         FOR UPDATE
       )
       UPDATE "threads" AS t
       SET "workerLockedBy" = $2,
           "workerLeaseExpiresAt" = NOW() + ($3 * INTERVAL '1 millisecond'),
           "updatedAt" = NOW()
       FROM eligible_thread
       WHERE t."id" = eligible_thread."id"
       RETURNING
         t."id",
         eligible_thread."previousWorkerLockedBy"`,
      [threadId, workerId, THREAD_WORKER_LEASE_MS],
    );

    const acquired = result.rows[0];
    if (!acquired) {
      return false;
    }

    if (
      acquired.previousWorkerLockedBy &&
      acquired.previousWorkerLockedBy !== workerId
    ) {
      await resetProcessingQueueItemsAfterLeaseTakeover(threadId);
    }

    return true;
  };

  const renewThreadWorkerLease = async (
    threadId: string,
    workerId: string,
  ): Promise<boolean> => {
    const result = await db.query<{ id: string }>(
      `UPDATE "threads"
       SET "workerLeaseExpiresAt" = NOW() + ($3 * INTERVAL '1 millisecond'),
           "updatedAt" = NOW()
       WHERE "id" = $1
         AND "workerLockedBy" = $2
         AND (
           "workerLeaseExpiresAt" IS NULL
           OR "workerLeaseExpiresAt" >= NOW()
         )
       RETURNING "id"`,
      [threadId, workerId, THREAD_WORKER_LEASE_MS],
    );
    return result.rows.length > 0;
  };

  const isThreadWorkerLeaseOwner = async (
    threadId: string,
    workerId: string,
  ): Promise<boolean> => {
    const result = await db.query<{ ownsLease: boolean }>(
      `SELECT EXISTS(
         SELECT 1
         FROM "threads"
         WHERE "id" = $1
           AND "workerLockedBy" = $2
           AND (
             "workerLeaseExpiresAt" IS NULL
             OR "workerLeaseExpiresAt" >= NOW()
           )
       ) AS "ownsLease"`,
      [threadId, workerId],
    );
    return Boolean(result.rows[0]?.ownsLease);
  };

  const releaseThreadWorkerLease = async (
    threadId: string,
    workerId: string,
  ): Promise<void> => {
    await db.query(
      `UPDATE "threads"
       SET "workerLockedBy" = NULL,
           "workerLeaseExpiresAt" = NULL,
           "updatedAt" = NOW()
       WHERE "id" = $1 AND "workerLockedBy" = $2`,
      [threadId, workerId],
    );
  };

  const releaseThreadWorkerLeaseIfNoPendingWork = async (
    threadId: string,
    workerId: string,
    minPriority?: number,
  ): Promise<boolean> => {
    const params: unknown[] = [threadId, workerId];
    let pendingPriorityClause = "";

    if (typeof minPriority === "number" && Number.isFinite(minPriority)) {
      params.push(minPriority);
      pendingPriorityClause =
        ` AND COALESCE("priority", 0) >= $${params.length}`;
    }

    const result = await db.query<{ id: string }>(
      `UPDATE "threads"
       SET "workerLockedBy" = NULL,
           "workerLeaseExpiresAt" = NULL,
           "updatedAt" = NOW()
       WHERE "id" = $1
         AND "workerLockedBy" = $2
         AND NOT EXISTS (
           SELECT 1
           FROM "events"
           WHERE "threadId" = $1
             AND "status" = 'pending'
             ${pendingPriorityClause}
         )
       RETURNING "id"`,
      params,
    );

    return result.rows.length > 0;
  };

  const recoverThreadProcessingQueueItems = async (
    threadId: string,
  ): Promise<number> => {
    return await recoverStaleProcessingQueueItems(threadId);
  };

  const getThreadById = async (
    threadId: string,
  ): Promise<Thread | undefined> => {
    const thread = await crud.threads.findOne({
      id: threadId,
      status: "active",
    }) as Thread | null;
    return await hydrateThreadFromNode(thread);
  };

  const getThreadByExternalId = async (
    externalId: string,
    namespace?: string,
  ): Promise<Thread | undefined> => {
    const filter: Record<string, unknown> = {
      externalId,
      status: "active",
    };
    if (namespace !== undefined) filter.namespace = namespace;
    const thread = await crud.threads.findOne(filter) as Thread | null;
    return await hydrateThreadFromNode(thread);
  };

  const ensureThreadNode = async (
    thread: Thread,
    domain: Partial<ThreadInsert>,
  ): Promise<void> => {
    const namespace = typeof thread.namespace === "string" &&
        thread.namespace.length > 0
      ? thread.namespace
      : typeof domain.namespace === "string" && domain.namespace.length > 0
      ? domain.namespace
      : "default";

    const threadId = thread.id as string;
    const existing = await getNodeById(threadId);
    const existingData = existing?.type === "thread"
      ? (existing.data ?? {}) as Record<string, unknown>
      : {};
    const threadMetadata =
      (thread as { metadata?: Record<string, unknown> | null })
        .metadata;
    const data = {
      description: domain.description ?? thread.description ?? null,
      summary: domain.summary ?? thread.summary ?? null,
      initialMessage: domain.initialMessage ?? thread.initialMessage ?? null,
      metadata: domain.metadata !== undefined
        ? domain.metadata ?? null
        : threadMetadata ?? existingData.metadata ?? null,
      participants: Array.isArray(domain.participants)
        ? domain.participants
        : Array.isArray(thread.participants)
        ? thread.participants
        : null,
      externalId: domain.externalId ?? thread.externalId ?? null,
      mode: domain.mode ?? thread.mode ?? "immediate",
      status: domain.status ?? thread.status ?? "active",
    };

    if (existing?.type === "thread") {
      await updateNode(threadId, {
        namespace,
        name: domain.name ?? existing.name ?? "Main Thread",
        data: {
          ...existingData,
          ...data,
        },
        sourceType: "thread",
        sourceId: threadId,
      });
      return;
    }

    await createNode({
      id: threadId,
      namespace,
      type: "thread",
      name: domain.name ?? "Main Thread",
      content: null,
      data,
      sourceType: "thread",
      sourceId: threadId,
    });

    if (typeof domain.parentThreadId === "string") {
      await createEdge({
        sourceNodeId: domain.parentThreadId,
        targetNodeId: threadId,
        type: GRAPH_EDGE.HAS_CHILD_THREAD,
      });
    }

    if (Array.isArray(domain.participants)) {
      for (const participantId of domain.participants) {
        const participant = await getParticipantNode(participantId, namespace);
        if (participant) {
          await createEdge({
            sourceNodeId: participant.id as string,
            targetNodeId: threadId,
            type: GRAPH_EDGE.PARTICIPATES_IN,
          });
        }
      }
    }
  };

  const hydrateThreadFromNode = async (
    thread: Thread | null | undefined,
  ): Promise<Thread | undefined> => {
    if (!thread?.id) return undefined;
    const node = await getNodeById(thread.id as string);
    if (node?.type !== "thread") return thread;

    const data = (node.data ?? {}) as Record<string, unknown>;
    if (data.metadata === undefined || data.metadata === null) return thread;

    return {
      ...thread,
      metadata: data.metadata as Thread["metadata"],
    };
  };

  const findOrCreateThread = async (
    threadId: string | undefined,
    threadData: ThreadInsert,
    options: ThreadMutationOptions = {},
  ): Promise<Thread> =>
    await domainMutation(async () => {
      let existing: Thread | null = null;
      if (threadId) {
        existing = await crud.threads.findOne({ id: threadId }) as
          | Thread
          | null;
      } else if (
        typeof threadData.externalId === "string" && threadData.externalId
      ) {
        existing = await crud.threads.findOne({
          externalId: threadData.externalId,
        }) as Thread | null;
      }

      const normalizeParticipants = (participants?: string[] | null) => {
        if (!Array.isArray(participants)) return participants ?? null;
        const normalized = participants
          .filter((participant): participant is string =>
            typeof participant === "string"
          )
          .map((participant) => participant.trim())
          .filter((participant) => participant.length > 0);
        return Array.from(new Set(normalized));
      };

      if (!existing) {
        const participants = normalizeParticipants(threadData.participants);
        const baseInsert = {
          namespace: threadData.namespace ?? null,
          name: threadData.name,
          externalId: threadData.externalId ?? null,
          description: threadData.description ?? null,
          participants,
          initialMessage: threadData.initialMessage ?? null,
          mode: threadData.mode ?? "immediate",
          status: threadData.status ?? "active",
          summary: threadData.summary ?? null,
          parentThreadId: threadData.parentThreadId ?? null,
          rootThreadId: threadData.rootThreadId ?? threadData.parentThreadId ??
            null,
          lastEventId: threadData.lastEventId ?? null,
          lastEventAt: threadData.lastEventAt ?? null,
        };
        const created = await crud.threads.create(
          threadId ? { id: threadId, ...baseInsert } : baseInsert,
        ) as Thread;
        await ensureThreadNode(created, { ...threadData, participants });
        const result = (await hydrateThreadFromNode(created)) ?? created;
        return {
          result,
          event: {
            threadId: String(created.id),
            subjectType: "thread",
            subjectId: String(created.id),
            operation: "created",
            input: threadData,
            after: result as unknown as Record<string, unknown>,
            traceId: options.traceId ?? null,
            causationId: options.causationId ?? null,
            namespace: typeof created.namespace === "string"
              ? created.namespace
              : options.namespace ?? null,
          },
        };
      }

      const updates: Partial<Thread> = {};

      if (
        Array.isArray(threadData.participants) &&
        threadData.participants.length > 0
      ) {
        const incoming = normalizeParticipants(threadData.participants);
        const existingParticipants = Array.isArray(existing.participants)
          ? existing.participants
          : [];
        if (JSON.stringify(existingParticipants) !== JSON.stringify(incoming)) {
          updates.participants = incoming ?? null;
        }
      }

      if (
        typeof threadData.namespace === "string" &&
        threadData.namespace !== existing.namespace
      ) {
        updates.namespace = threadData.namespace;
      }

      if (
        typeof threadData.status === "string" &&
        threadData.status !== existing.status
      ) {
        updates.status = threadData.status;
      }

      if (Object.keys(updates).length === 0) {
        await ensureThreadNode(existing, threadData);
        return { result: (await hydrateThreadFromNode(existing)) ?? existing };
      }

      const updated = await crud.threads.update({ id: existing.id }, updates);
      const result = (updated ?? existing) as Thread;
      await ensureThreadNode(result, { ...threadData, ...updates });
      const hydrated = (await hydrateThreadFromNode(result)) ?? result;
      return {
        result: hydrated,
        event: {
          threadId: String(result.id),
          subjectType: "thread",
          subjectId: String(result.id),
          operation: "updated",
          input: threadData,
          before: existing as unknown as Record<string, unknown>,
          after: hydrated as unknown as Record<string, unknown>,
          patch: updates,
          traceId: options.traceId ?? null,
          causationId: options.causationId ?? null,
          namespace: typeof result.namespace === "string"
            ? result.namespace
            : options.namespace ?? null,
        },
      };
    });

  const createMessage = async (
    message: MessageInsert,
    namespace?: string,
  ): Promise<Message> => {
    const messageId = message.id ?? ulid();
    const messageWithId = { ...message, id: messageId };

    const threadIdStr = message.threadId as string;
    const thread = await getThreadById(threadIdStr);
    const messageNamespace = namespace ??
      (typeof thread?.namespace === "string" ? thread.namespace : undefined);
    const lastMessage = await getLastMessageNode(threadIdStr);
    const messageNode = await createMessageNode(
      messageWithId,
      lastMessage?.id as string | undefined,
      messageNamespace,
    );

    return nodeToMessage(messageNode);
  };

  const getMessageHistory = async (
    threadId: string,
    userId: string,
    limit = 50,
  ): Promise<Message[]> => {
    const allMessages: { message: Message; threadLevel: number }[] = [];
    let currentThreadId: string | null = threadId;
    let level = 0;

    while (currentThreadId) {
      const thread = await crud.threads.findOne({
        id: currentThreadId,
      }) as Thread | null;
      if (!thread || thread.status !== "active") {
        break;
      }

      const participants = Array.isArray(thread.participants)
        ? thread.participants.filter((
          participant: string,
        ): participant is string => typeof participant === "string")
        : [];
      // Use case-insensitive comparison: thread participants use agent.name (e.g. "Assistant")
      // but history lookups use agent.id (e.g. "assistant"). Normalize both to lowercase.
      const userIdLower = userId.toLowerCase();
      if (!participants.some((p) => p.toLowerCase() === userIdLower)) {
        break;
      }

      // Read messages from graph (nodes table) instead of messages table
      const threadMessages = await getMessagesFromGraphForThread(
        currentThreadId,
      );

      for (const msg of threadMessages) {
        allMessages.push({ message: msg, threadLevel: level });
      }

      const parentId: string | null = typeof thread.parentThreadId === "string"
        ? thread.parentThreadId
        : null;

      currentThreadId = parentId;
      level += 1;
    }

    allMessages.sort((a, b) => {
      const dateA = new Date(String(a.message.createdAt)).getTime();
      const dateB = new Date(String(b.message.createdAt)).getTime();
      if (dateA !== dateB) return dateA - dateB;
      return b.threadLevel - a.threadLevel;
    });

    const result: Message[] = [];
    for (const e of allMessages?.slice(-limit)) {
      if (e?.message) {
        result.push(e.message);
      }
    }

    return result;
  };

  const getMessagesFromGraphForThread = async (
    threadId: string,
  ): Promise<Message[]> => {
    const result = await db.query<KnowledgeNode>(
      `SELECT * FROM "nodes"
       WHERE "source_type" = 'thread' AND "source_id" = $1 AND "type" = 'message'
       ORDER BY "created_at" ASC`,
      [threadId],
    );
    return result.rows.map(nodeToMessage);
  };

  const nodeToMessage = (node: KnowledgeNode): Message => {
    const data = (node.data ?? {}) as Record<string, unknown>;
    const rawNode = node as KnowledgeNode & {
      created_at?: Date | string | null;
      updated_at?: Date | string | null;
    };
    return {
      id: (data.messageId ?? node.id) as string,
      threadId: (data.threadId ?? node.sourceId ?? node.namespace) as string,
      senderId: data.senderId as string,
      senderType: data.senderType as Message["senderType"],
      senderUserId: data.senderUserId as string | null,
      externalId: data.externalId as string | null,
      content: typeof node.content === "string"
        ? node.content
        : typeof data.content === "string"
        ? data.content
        : "",
      toolCallId: data.toolCallId as string | null,
      toolCalls: data.toolCalls as Message["toolCalls"],
      reasoning: (data.reasoning as string | null) ?? null,
      metadata: data.metadata as Message["metadata"],
      createdAt: (rawNode.created_at ?? node.createdAt) as Date | string,
      updatedAt: (rawNode.updated_at ?? node.updatedAt) as Date | string,
    } as Message;
  };

  const emptyMessageHistoryPage = (): MessageHistoryPage => ({
    data: [],
    pageInfo: {
      hasMoreBefore: false,
      oldestMessageId: null,
      newestMessageId: null,
    },
  });

  const getPageEdgeMessageIds = (
    data: Message[],
  ): Pick<MessageHistoryPageInfo, "oldestMessageId" | "newestMessageId"> => {
    const firstMessage = data[0];
    const lastMessage = data.length > 0 ? data[data.length - 1] : undefined;

    return {
      oldestMessageId: typeof firstMessage?.id === "string"
        ? firstMessage.id
        : null,
      newestMessageId: typeof lastMessage?.id === "string"
        ? lastMessage.id
        : null,
    };
  };

  // ============================================
  // MESSAGE AS NODE OPERATIONS
  // ============================================

  const getLastMessageNode = async (
    threadId: string,
  ): Promise<KnowledgeNode | undefined> => {
    const result = await db.query<KnowledgeNode>(
      `SELECT * FROM "nodes" 
       WHERE "source_type" = 'thread' AND "source_id" = $1 AND "type" = 'message'
       ORDER BY "created_at" DESC
       LIMIT 1`,
      [threadId],
    );
    return result.rows[0];
  };

  const createMessageNode = async (
    message: MessageInsert,
    previousMessageId?: string,
    namespace?: string,
  ): Promise<KnowledgeNode> => {
    const messageId = (message.id ?? ulid()) as string;
    const timestamp = new Date().toISOString();
    const threadId = message.threadId as string;
    const senderId = message.senderId as string;
    const senderType = message.senderType as string;
    const tenantNamespace = namespace ??
      (await getThreadById(threadId))?.namespace as string | undefined;
    if (!tenantNamespace) {
      throw new Error(
        `Cannot create message for thread ${threadId}: tenant namespace is required`,
      );
    }

    // Create message as node
    const messageNode = await createNode({
      id: messageId,
      namespace: tenantNamespace,
      type: "message",
      name: `${senderType}:${senderId}:${timestamp}`,
      content: (message.content ?? "") as string,
      data: {
        messageId,
        threadId,
        senderId,
        senderType,
        senderUserId: message.senderUserId ?? null,
        externalId: message.externalId ?? null,
        toolCallId: message.toolCallId ?? null,
        toolCalls: message.toolCalls ?? null,
        reasoning:
          ((message as Record<string, unknown>).reasoning as string | null) ??
            null,
        metadata: message.metadata ?? null,
      },
      sourceType: "thread",
      sourceId: threadId,
    });

    // Link previous message to the current message when available.
    if (previousMessageId) {
      await createEdge({
        sourceNodeId: previousMessageId,
        targetNodeId: messageNode.id as string,
        type: GRAPH_EDGE.DERIVED_FROM,
      });
    }

    await createEdge({
      sourceNodeId: threadId,
      targetNodeId: messageNode.id as string,
      type: GRAPH_EDGE.HAS_MESSAGE,
    });

    // Link participant node to message (if sender is a user with externalId).
    if (senderType === "user" && senderId) {
      try {
        const participantNode = await getParticipantNode(
          senderId,
          tenantNamespace,
        );
        if (participantNode) {
          await createEdge({
            sourceNodeId: participantNode.id as string,
            targetNodeId: messageNode.id as string,
            type: GRAPH_EDGE.SENT_BY,
          });
        }
      } catch {
        // Ignore errors - user node might not exist yet
      }
    }

    return messageNode;
  };

  const getMessageHistoryFromGraph = async (
    threadId: string,
    limit?: number,
  ): Promise<Message[]> => {
    const page = await getMessageHistoryPageFromGraph(
      threadId,
      limit !== undefined ? { limit } : undefined,
    );
    return page.data;
  };

  const getMessageHistoryPageFromGraph = async (
    threadId: string,
    options?: MessageHistoryPageOptions,
  ): Promise<MessageHistoryPage> => {
    const limit = typeof options?.limit === "number" && options.limit > 0
      ? Math.floor(options.limit)
      : undefined;
    const before =
      typeof options?.before === "string" && options.before.length > 0
        ? options.before
        : null;

    type MessageNodeRow = KnowledgeNode & { messageKey?: string };

    if (before) {
      const cursorResult = await db.query<MessageNodeRow>(
        `SELECT *, COALESCE("data"->>'messageId', "id") AS "messageKey"
         FROM "nodes"
         WHERE "source_type" = 'thread'
           AND "source_id" = $1
           AND "type" = 'message'
           AND (COALESCE("data"->>'messageId', "id") = $2 OR "id" = $2)
         LIMIT 1`,
        [threadId, before],
      );
      const cursor = cursorResult.rows[0];
      if (!cursor) {
        return emptyMessageHistoryPage();
      }
      const cursorCreatedAt = (
        cursor as MessageNodeRow & { created_at?: Date | string | null }
      ).created_at ?? cursor.createdAt;
      if (!cursorCreatedAt) {
        return emptyMessageHistoryPage();
      }

      const limitClause = limit !== undefined ? `LIMIT $4` : "";
      const params = limit !== undefined
        ? [threadId, cursorCreatedAt, cursor.id, limit + 1]
        : [threadId, cursorCreatedAt, cursor.id];
      const result = await db.query<MessageNodeRow>(
        `SELECT *, COALESCE("data"->>'messageId', "id") AS "messageKey"
         FROM "nodes"
         WHERE "source_type" = 'thread'
           AND "source_id" = $1
           AND "type" = 'message'
           AND (
             "created_at" < $2
             OR ("created_at" = $2 AND "id" < $3)
           )
         ORDER BY "created_at" DESC, "id" DESC
         ${limitClause}`,
        params,
      );

      const hasMoreBefore = limit !== undefined
        ? result.rows.length > limit
        : false;
      const rows =
        (limit !== undefined ? result.rows.slice(0, limit) : result.rows)
          .reverse();
      const data = rows.map(nodeToMessage);

      return {
        data,
        pageInfo: {
          hasMoreBefore,
          ...getPageEdgeMessageIds(data),
        },
      };
    }

    const limitClause = limit !== undefined ? `LIMIT $2` : "";
    const params = limit !== undefined ? [threadId, limit + 1] : [threadId];
    const result = await db.query<KnowledgeNode>(
      `SELECT * FROM "nodes"
       WHERE "source_type" = 'thread' AND "source_id" = $1 AND "type" = 'message'
       ORDER BY "created_at" DESC, "id" DESC
       ${limitClause}`,
      params,
    );

    const hasMoreBefore = limit !== undefined
      ? result.rows.length > limit
      : false;
    const rows =
      (limit !== undefined ? result.rows.slice(0, limit) : result.rows)
        .reverse();
    const data = rows.map(nodeToMessage);

    return {
      data,
      pageInfo: {
        hasMoreBefore,
        ...getPageEdgeMessageIds(data),
      },
    };
  };

  // ============================================
  // CHUNK AS NODE OPERATIONS
  // ============================================

  const searchChunksFromGraph = async (
    options: ChunkSearchOptions,
  ): Promise<ChunkSearchResult[]> => {
    const { embedding, namespace, namespaces, limit = 10, threshold = 0.5 } =
      options;

    if (!embedding || embedding.length === 0) {
      return [];
    }

    const searchNamespace = namespace ?? namespaces?.[0];
    if (!searchNamespace) {
      throw new Error("RAG search requires tenant namespace");
    }

    const scopedDocumentIds = await resolveDocumentIdsForScope(
      searchNamespace,
      options.scope,
    );

    const params: unknown[] = [`[${embedding.join(",")}]`];
    let scopeClause = "";

    params.push(searchNamespace);
    const namespaceIdx = params.length;

    if (scopedDocumentIds) {
      if (scopedDocumentIds.length === 0) return [];
      params.push(scopedDocumentIds);
      scopeClause = `AND "source_id" = ANY($${params.length})`;
    }

    params.push(threshold);
    const thresholdIdx = params.length;

    params.push(limit);
    const limitIdx = params.length;

    const result = await db.query<{
      id: string;
      namespace: string;
      content: string;
      data: Record<string, unknown>;
      similarity: number;
      source_id: string;
    }>(
      `SELECT 
        "id",
        "namespace",
        "content",
        "data",
        "source_id",
        1 - ("embedding" <=> $1::vector) as similarity
      FROM "nodes"
      WHERE "type" = 'chunk'
        AND "namespace" = $${namespaceIdx}
        AND "embedding" IS NOT NULL
        AND 1 - ("embedding" <=> $1::vector) > $${thresholdIdx}
        ${scopeClause}
      ORDER BY "embedding" <=> $1::vector
      LIMIT $${limitIdx}`,
      params,
    );

    return result.rows.map((row) => {
      const data = row.data ?? {};
      return {
        id: row.id,
        content: row.content,
        namespace: row.namespace,
        chunkIndex: (data.chunkIndex ?? 0) as number,
        similarity: row.similarity,
        tokenCount: (data.tokenCount ?? null) as number | null,
        metadata: data,
        document: {
          id: row.source_id ?? (data.documentId as string),
          title: (data.title ?? null) as string | null,
          sourceUri: null,
          sourceType: "document",
          mimeType: null,
        },
      };
    });
  };

  const resolveDocumentIdsForScope = async (
    namespace: string,
    scope?: RagScope,
  ): Promise<string[] | null> => {
    if (!scope) return null;

    const roots = new Set<string>();
    if (scope.threadId) roots.add(scope.threadId);
    if (scope.agentId) roots.add(scope.agentId);
    for (const id of scope.knowledgeSpaceIds ?? []) roots.add(id);
    const explicitDocuments = new Set(scope.documentIds ?? []);

    if (roots.size === 0 && explicitDocuments.size === 0) return null;

    const discovered = new Set(explicitDocuments);
    if (roots.size > 0) {
      const rootIds = Array.from(roots);
      const direct = await db.query<{ id: string }>(
        `SELECT DISTINCT d."id"
         FROM "edges" e
         INNER JOIN "nodes" d ON d."id" = e."target_node_id"
         WHERE e."source_node_id" = ANY($1)
           AND e."type" = ANY($2)
           AND d."namespace" = $3
           AND d."type" = 'document'`,
        [
          rootIds,
          [GRAPH_EDGE.HAS_DOCUMENT, GRAPH_EDGE.CAN_ACCESS],
          namespace,
        ],
      );
      for (const row of direct.rows) discovered.add(row.id);

      const viaKnowledgeSpace = await db.query<{ id: string }>(
        `SELECT DISTINCT d."id"
         FROM "edges" access
         INNER JOIN "nodes" ks ON ks."id" = access."target_node_id"
         INNER JOIN "edges" docs ON docs."source_node_id" = ks."id"
         INNER JOIN "nodes" d ON d."id" = docs."target_node_id"
         WHERE access."source_node_id" = ANY($1)
           AND access."type" = ANY($2)
           AND ks."namespace" = $3
           AND ks."type" = 'knowledge_space'
           AND docs."type" = $4
           AND d."namespace" = $3
           AND d."type" = 'document'`,
        [
          rootIds,
          [GRAPH_EDGE.USES_KNOWLEDGE_SPACE, GRAPH_EDGE.CAN_ACCESS],
          namespace,
          GRAPH_EDGE.HAS_DOCUMENT,
        ],
      );
      for (const row of viaKnowledgeSpace.rows) discovered.add(row.id);
    }

    return Array.from(discovered);
  };

  const getThreadsForParticipant = async (
    participantId: string,
    options?: {
      namespace?: string;
      status?: Thread["status"] | "all";
      limit?: number;
      offset?: number;
      order?: "asc" | "desc";
    },
  ): Promise<Thread[]> => {
    const statusFilter = options?.status ?? "active";
    const order = options?.order === "asc" ? "ASC" : "DESC";
    const participantNode = await getParticipantNode(
      participantId,
      options?.namespace,
    );
    const participantNodeId = participantNode?.id as string | undefined;

    const params: unknown[] = [participantId, GRAPH_EDGE.PARTICIPATES_IN];
    const whereParts: string[] = [
      `(
        t."participants" @> jsonb_build_array($1::text)
        OR EXISTS (
          SELECT 1
          FROM "edges" e
          WHERE e."target_node_id" = t."id"
            AND e."type" = $2
            AND (
              e."source_node_id" = $1
              ${participantNodeId ? `OR e."source_node_id" = $3` : ""}
            )
        )
      )`,
    ];
    let index = 3;
    if (participantNodeId) {
      params.push(participantNodeId);
      index = 4;
    }
    if (options?.namespace) {
      whereParts.push(`t."namespace" = $${index}`);
      params.push(options.namespace);
      index += 1;
    }
    if (statusFilter !== "all") {
      whereParts.push(`t."status" = $${index}`);
      params.push(statusFilter);
      index += 1;
    }

    let limitClause = "";
    if (typeof options?.limit === "number") {
      limitClause = `LIMIT $${index}`;
      params.push(options.limit);
      index += 1;
    }

    let offsetClause = "";
    if (typeof options?.offset === "number") {
      offsetClause = `OFFSET $${index}`;
      params.push(options.offset);
      index += 1;
    }

    const result = await db.query<Thread>(
      `SELECT t.*
       FROM "threads" t
       WHERE ${whereParts.join(" AND ")}
       ORDER BY t."updatedAt" ${order}
       ${limitClause}
       ${offsetClause}`.trim(),
      params,
    );

    const threads = result.rows as Thread[];
    return (await Promise.all(
      threads.map((thread) => hydrateThreadFromNode(thread)),
    )).filter((thread): thread is Thread => thread !== undefined);
  };

  const getMessagesForThread = async (
    threadId: string,
    options?: {
      limit?: number;
      offset?: number;
      order?: "asc" | "desc";
    },
  ): Promise<Message[]> => {
    const order = options?.order === "desc" ? "DESC" : "ASC";
    const params: unknown[] = [threadId];
    let limitClause = "";
    let offsetClause = "";
    if (typeof options?.limit === "number") {
      params.push(options.limit);
      limitClause = `LIMIT $${params.length}`;
    }
    if (typeof options?.offset === "number") {
      params.push(options.offset);
      offsetClause = `OFFSET $${params.length}`;
    }
    const result = await db.query<KnowledgeNode>(
      `SELECT * FROM "nodes"
       WHERE "source_type" = 'thread' AND "source_id" = $1 AND "type" = 'message'
       ORDER BY "created_at" ${order}
       ${limitClause} ${offsetClause}`.trim(),
      params,
    );
    return result.rows.map(nodeToMessage);
  };

  const deleteMessagesForThread = async (threadId: string): Promise<void> => {
    await deleteNodesBySource("thread", threadId);
  };

  const peekCoalescableCandidates = async (
    threadId: string,
    currentEventId: string,
    namespace?: string,
  ): Promise<Queue[]> => {
    const params: unknown[] = [threadId, currentEventId];
    let namespaceClause = "";
    if (namespace !== undefined) {
      params.push(namespace);
      namespaceClause = `AND "namespace" = $${params.length}`;
    }
    const result = await db.query<Queue>(
      `SELECT * FROM "events"
       WHERE "threadId" = $1
         AND "id" != $2
         AND "status" = 'pending'
         AND "eventType" = 'NEW_MESSAGE'
         ${namespaceClause}
       ORDER BY "createdAt" ASC`,
      params,
    );
    return result.rows as Queue[];
  };

  const claimAndCompleteEventsBatch = async (
    ids: string[],
  ): Promise<string[]> => {
    if (ids.length === 0) return [];
    const result = await db.query<{ id: string }>(
      `UPDATE "events"
       SET "status" = 'completed', "updatedAt" = NOW()
       WHERE "id" = ANY($1)
         AND "status" = 'pending'
       RETURNING "id"`,
      [ids],
    );
    return result.rows.map((r) => r.id);
  };

  const archiveThread = async (
    threadId: string,
    summary: string,
  ): Promise<Thread | null> => {
    const updated = await crud.threads.update({ id: threadId }, {
      status: "archived",
      summary,
    }) as Thread | null;
    if (!updated) return null;
    await ensureThreadNode(updated, { status: "archived", summary });
    return (await hydrateThreadFromNode(updated)) ?? updated;
  };

  const updateThread = async (
    threadId: string,
    updates: Partial<ThreadInsert>,
    options: ThreadMutationOptions = {},
  ): Promise<Thread | null> => {
    return await domainMutation(async () => {
      const before = await crud.threads.findOne({ id: threadId }) as
        | Thread
        | null;
      if (!before) return { result: null };

      const { metadata, ...tableUpdates } = updates;
      const hasTableUpdates = Object.keys(tableUpdates).length > 0;
      const thread = hasTableUpdates
        ? await crud.threads.update({ id: threadId }, tableUpdates) as
          | Thread
          | null
        : before;
      if (!thread) return { result: null };

      await ensureThreadNode(thread, {
        ...tableUpdates,
        ...(updates.metadata !== undefined ? { metadata } : {}),
      });
      const hydrated = (await hydrateThreadFromNode(thread)) ?? thread;
      return {
        result: hydrated,
        event: {
          threadId: String(hydrated.id),
          subjectType: "thread",
          subjectId: String(hydrated.id),
          operation: "updated",
          before: before as unknown as Record<string, unknown>,
          after: hydrated as unknown as Record<string, unknown>,
          patch: updates,
          traceId: options.traceId ?? null,
          causationId: options.causationId ?? null,
          namespace: typeof hydrated.namespace === "string"
            ? hydrated.namespace
            : options.namespace ?? null,
        },
      };
    });
  };

  const deleteThread = async (threadId: string): Promise<void> => {
    await deleteMessagesForThread(threadId);
    await db.query(`DELETE FROM "events" WHERE "threadId" = $1`, [threadId]);
    await crud.threads.delete({ id: threadId });
  };

  // ============================================
  // PARTICIPANT NODE OPERATIONS (Unified users & agents)
  // ============================================

  const upsertParticipantNode = async (
    externalId: string,
    participantType: "human" | "agent" | "job",
    namespace: string | null,
    data: {
      name?: string | null;
      email?: string | null; // humans only
      agentId?: string | null; // agents only
      metadata?: Record<string, unknown> | null;
    },
  ): Promise<KnowledgeNode> => {
    if (!namespace) {
      throw new Error("Participant namespace is required");
    }
    // Try to find existing participant node
    const existing = await getParticipantNode(externalId, namespace);

    if (existing) {
      // Update existing participant
      const currentData = (existing.data ?? {}) as Record<string, unknown>;
      const newData = { ...currentData };
      let hasChanges = false;

      if (data.name !== undefined && currentData.name !== data.name) {
        newData.name = data.name;
        hasChanges = true;
      }
      if (data.email !== undefined && currentData.email !== data.email) {
        newData.email = data.email;
        hasChanges = true;
      }
      if (data.agentId !== undefined && currentData.agentId !== data.agentId) {
        newData.agentId = data.agentId;
        hasChanges = true;
      }
      if (data.metadata !== undefined) {
        // Merge metadata rather than replace (for agent memory persistence)
        newData.metadata = {
          ...(currentData.metadata as Record<string, unknown> ?? {}),
          ...data.metadata,
        };
        hasChanges = true;
      }
      // Ensure participantType is set (for migration of existing nodes)
      if (currentData.participantType !== participantType) {
        newData.participantType = participantType;
        hasChanges = true;
      }

      if (hasChanges) {
        const updated = await updateNode(existing.id as string, {
          data: newData,
          name: data.name ?? existing.name,
        });
        return updated ?? existing;
      }
      return existing;
    }

    // Create new participant node
    const participantNode = await createNode({
      namespace,
      type: "participant",
      name: data.name ?? externalId,
      content: null,
      data: {
        externalId,
        participantType,
        name: data.name ?? null,
        email: data.email ?? null,
        agentId: data.agentId ?? null,
        metadata: data.metadata ?? null,
      },
      sourceType: participantType === "human" ? "user" : participantType,
      sourceId: externalId,
    });

    return participantNode;
  };

  const getParticipantNode = async (
    externalId: string,
    namespace?: string | null,
  ): Promise<KnowledgeNode | undefined> => {
    if (!namespace) return undefined;
    const result = await db.query<KnowledgeNode>(
      `SELECT * FROM "nodes" 
       WHERE "type" = 'participant'
       AND "namespace" = $1
       AND ("data"->>'externalId' = $2 OR "source_id" = $2)
       LIMIT 1`,
      [namespace, externalId],
    );
    if (result.rows[0]) {
      return mapNodeRow(result.rows[0]);
    }

    return undefined;
  };

  const listLegacyParticipantGraphNodes = async (
    options?: { namespace?: string; limit?: number },
  ): Promise<KnowledgeNode[]> => {
    const cap = Math.min(Math.max(options?.limit ?? 50_000, 1), 100_000);
    if (options?.namespace) {
      const result = await db.query<KnowledgeNode>(
        `SELECT * FROM "nodes"
         WHERE "type" IN ('participant', 'user') AND "namespace" = $1
         ORDER BY "created_at" ASC
         LIMIT $2`,
        [options.namespace, cap],
      );
      return result.rows.map(mapNodeRow);
    }
    const result = await db.query<KnowledgeNode>(
      `SELECT * FROM "nodes"
       WHERE "type" IN ('participant', 'user')
       ORDER BY "namespace", "created_at" ASC
       LIMIT $1`,
      [cap],
    );
    return result.rows.map(mapNodeRow);
  };

  // RAG Operations (graph-only)

  const nodeToDocument = (node: KnowledgeNode): Document => {
    const data = (node.data ?? {}) as Record<string, unknown>;
    return {
      id: node.id as string,
      namespace: node.namespace,
      externalId: (data.externalId as string | null) ?? null,
      sourceType: (data.sourceType as Document["sourceType"]) ?? "text",
      sourceUri: (data.sourceUri as string | null) ?? null,
      title: (data.title as string | null) ?? null,
      mimeType: (data.mimeType as string | null) ?? null,
      contentHash: (data.contentHash as string) ?? "",
      assetId: (data.assetId as string | null) ?? null,
      status: (data.status as Document["status"]) ?? "pending",
      chunkCount: (data.chunkCount as number | null) ?? null,
      errorMessage: (data.errorMessage as string | null) ?? null,
      metadata: (data.metadata as Record<string, unknown> | null) ?? null,
      createdAt: node.createdAt as string | undefined,
      updatedAt: node.updatedAt as string | undefined,
    };
  };

  const createDocument = async (
    doc: Omit<NewDocument, "id"> & { id?: string },
  ): Promise<Document> => {
    if (!doc.namespace) {
      throw new Error("Document namespace is required");
    }
    const docNode = await createNode({
      id: doc.id,
      namespace: doc.namespace,
      type: "document",
      name: doc.title ?? doc.sourceUri ?? doc.contentHash ?? "untitled",
      data: {
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
      },
      sourceType: "document",
      sourceId: null,
    });

    const metadata = doc.metadata ?? {};
    const scope = typeof metadata === "object"
      ? (metadata as Record<string, unknown>).scope as RagScope | undefined
      : undefined;
    const linkTargets = new Set<string>();
    if (scope?.threadId) linkTargets.add(scope.threadId);
    if (scope?.agentId) linkTargets.add(scope.agentId);
    for (const id of scope?.knowledgeSpaceIds ?? []) linkTargets.add(id);
    for (const targetId of linkTargets) {
      await createEdge({
        sourceNodeId: targetId,
        targetNodeId: docNode.id as string,
        type: GRAPH_EDGE.HAS_DOCUMENT,
      });
    }

    return nodeToDocument(docNode);
  };

  const getDocumentById = async (id: string): Promise<Document | undefined> => {
    const node = await getNodeById(id);
    if (!node || node.type !== "document") return undefined;
    return nodeToDocument(node);
  };

  const getDocumentByHash = async (
    hash: string,
    namespace: string,
  ): Promise<Document | undefined> => {
    const result = await db.query<KnowledgeNode>(
      `SELECT * FROM "nodes"
       WHERE "type" = 'document'
         AND "namespace" = $1
         AND "data"->>'contentHash' = $2
       LIMIT 1`,
      [namespace, hash],
    );
    const node = result.rows[0];
    return node ? nodeToDocument(node) : undefined;
  };

  const updateDocumentStatus = async (
    id: string,
    status: Document["status"],
    errorMessage?: string,
    chunkCount?: number,
  ): Promise<void> => {
    const node = await getNodeById(id);
    if (!node) return;
    const data = { ...(node.data as Record<string, unknown> ?? {}), status };
    if (errorMessage !== undefined) {
      (data as Record<string, unknown>).errorMessage = errorMessage;
    }
    if (chunkCount !== undefined) {
      (data as Record<string, unknown>).chunkCount = chunkCount;
    }
    await updateNode(id, { data });
  };

  const deleteDocument = async (id: string): Promise<void> => {
    // Delete chunk nodes linked to this document, then delete the document node
    await deleteNodesBySource("document", id);
    await deleteNode(id);
  };

  const deleteChunksByDocumentId = async (
    documentId: string,
  ): Promise<void> => {
    await deleteNodesBySource("document", documentId);
  };

  const createChunks = async (
    chunks: Array<Omit<NewDocumentChunk, "id"> & { id?: string }>,
  ): Promise<DocumentChunk[]> => {
    if (chunks.length === 0) return [];

    const created: DocumentChunk[] = [];
    for (const chunk of chunks) {
      const chunkNode = await createNode({
        id: chunk.id,
        namespace: chunk.namespace,
        type: "chunk",
        name: `${chunk.documentId}:${chunk.chunkIndex}`,
        content: chunk.content,
        embedding: chunk.embedding ?? null,
        data: {
          documentId: chunk.documentId,
          chunkIndex: chunk.chunkIndex,
          tokenCount: chunk.tokenCount ?? null,
          startPosition: chunk.startPosition ?? null,
          endPosition: chunk.endPosition ?? null,
          metadata: chunk.metadata ?? null,
        },
        sourceType: "document",
        sourceId: chunk.documentId,
      });
      await createEdge({
        sourceNodeId: chunk.documentId,
        targetNodeId: chunkNode.id as string,
        type: GRAPH_EDGE.HAS_CHUNK,
      });
      created.push({
        id: chunkNode.id as string,
        documentId: chunk.documentId,
        namespace: chunk.namespace,
        chunkIndex: chunk.chunkIndex,
        content: chunk.content,
        tokenCount: chunk.tokenCount ?? null,
        embedding: chunk.embedding ?? null,
        startPosition: chunk.startPosition ?? null,
        endPosition: chunk.endPosition ?? null,
        metadata: chunk.metadata ?? null,
        createdAt: chunkNode.createdAt as string | undefined,
        updatedAt: chunkNode.updatedAt as string | undefined,
      });
    }
    return created;
  };

  const searchChunks = async (
    options: ChunkSearchOptions,
  ): Promise<ChunkSearchResult[]> => {
    return searchChunksFromGraph(options);
  };

  const getNamespaceStats = async (): Promise<NamespaceStats[]> => {
    const result = await db.query<{
      namespace: string;
      documentCount: string;
      chunkCount: string;
      lastUpdated: Date | null;
    }>(
      `SELECT 
        n."namespace",
        COUNT(DISTINCT CASE WHEN n."type" = 'document' THEN n."id" END) as "documentCount",
        COUNT(DISTINCT CASE WHEN n."type" = 'chunk' THEN n."id" END) as "chunkCount",
        MAX(n."updated_at") as "lastUpdated"
      FROM "nodes" n
      WHERE n."type" IN ('document', 'chunk')
      GROUP BY n."namespace"
      ORDER BY n."namespace"`,
    );

    return result.rows.map((row) => ({
      namespace: row.namespace,
      documentCount: parseInt(String(row.documentCount), 10),
      chunkCount: parseInt(String(row.chunkCount), 10),
      lastUpdated: row.lastUpdated,
    }));
  };

  // ============================================
  // KNOWLEDGE GRAPH OPERATIONS
  // ============================================

  const createNode = async (
    node: Omit<NewKnowledgeNode, "id"> & { id?: string },
  ): Promise<KnowledgeNode> => {
    // Generate ULID if not provided
    const nodeId = node.id ?? ulid();
    // Use raw SQL for vector embedding support
    const embeddingStr = node.embedding
      ? `[${node.embedding.join(",")}]`
      : null;

    const result = await db.query<KnowledgeNode>(
      `INSERT INTO "nodes" (
        "id", "namespace", "type", "name", "embedding", "content", "data", 
        "source_type", "source_id", "created_at", "updated_at"
      ) VALUES (
        $1, $2, $3, $4, $5::vector, $6, $7, $8, $9, NOW(), NOW()
      ) RETURNING *`,
      [
        nodeId,
        node.namespace,
        node.type,
        node.name,
        embeddingStr,
        node.content ?? null,
        node.data ?? {},
        node.sourceType ?? null,
        node.sourceId ?? null,
      ],
    );
    return result.rows[0];
  };

  const createNodes = async (
    nodes: Array<Omit<NewKnowledgeNode, "id"> & { id?: string }>,
  ): Promise<KnowledgeNode[]> => {
    if (nodes.length === 0) return [];

    const created: KnowledgeNode[] = [];
    for (const node of nodes) {
      const result = await createNode(node);
      created.push(result);
    }
    return created;
  };

  // Helper to map snake_case node rows to camelCase KnowledgeNode
  const mapNodeRow = (row: Record<string, unknown>): KnowledgeNode => ({
    id: row.id as string,
    namespace: row.namespace as string,
    type: row.type as string,
    name: (row.name ?? "") as string,
    content: row.content as string | null,
    embedding: row.embedding as number[] | null,
    data: row.data as Record<string, unknown> | null,
    sourceType: (row.source_type ?? row.sourceType) as string | null,
    sourceId: (row.source_id ?? row.sourceId) as string | null,
    createdAt: row.created_at as Date ?? row.createdAt as Date,
    updatedAt: row.updated_at as Date ?? row.updatedAt as Date,
  });

  const getNodesByNamespace = async (
    namespace: string,
    type?: string,
  ): Promise<KnowledgeNode[]> => {
    if (type) {
      const result = await db.query<Record<string, unknown>>(
        `SELECT * FROM "nodes" WHERE "namespace" = $1 AND "type" = $2 ORDER BY "created_at" DESC`,
        [namespace, type],
      );
      return result.rows.map(mapNodeRow);
    }
    const result = await db.query<Record<string, unknown>>(
      `SELECT * FROM "nodes" WHERE "namespace" = $1 ORDER BY "created_at" DESC`,
      [namespace],
    );
    return result.rows.map(mapNodeRow);
  };

  const getNodeById = async (
    id: string,
  ): Promise<KnowledgeNode | undefined> => {
    const result = await db.query<Record<string, unknown>>(
      `SELECT * FROM "nodes" WHERE "id" = $1`,
      [id],
    );
    if (result.rows.length === 0) return undefined;
    return mapNodeRow(result.rows[0]);
  };

  const updateNode = async (
    id: string,
    updates: Partial<NewKnowledgeNode>,
  ): Promise<KnowledgeNode | undefined> => {
    const setClauses: string[] = [`"updated_at" = NOW()`];
    const params: unknown[] = [];
    let paramIdx = 1;

    if (updates.namespace !== undefined) {
      setClauses.push(`"namespace" = $${paramIdx++}`);
      params.push(updates.namespace);
    }
    if (updates.type !== undefined) {
      setClauses.push(`"type" = $${paramIdx++}`);
      params.push(updates.type);
    }
    if (updates.name !== undefined) {
      setClauses.push(`"name" = $${paramIdx++}`);
      params.push(updates.name);
    }
    if (updates.embedding !== undefined) {
      setClauses.push(`"embedding" = $${paramIdx++}::vector`);
      params.push(
        updates.embedding ? `[${updates.embedding.join(",")}]` : null,
      );
    }
    if (updates.content !== undefined) {
      setClauses.push(`"content" = $${paramIdx++}`);
      params.push(updates.content);
    }
    if (updates.data !== undefined) {
      setClauses.push(`"data" = $${paramIdx++}`);
      params.push(updates.data);
    }
    if (updates.sourceType !== undefined) {
      setClauses.push(`"source_type" = $${paramIdx++}`);
      params.push(updates.sourceType);
    }
    if (updates.sourceId !== undefined) {
      setClauses.push(`"source_id" = $${paramIdx++}`);
      params.push(updates.sourceId);
    }

    params.push(id);

    const result = await db.query<KnowledgeNode>(
      `UPDATE "nodes" SET ${
        setClauses.join(", ")
      } WHERE "id" = $${paramIdx} RETURNING *`,
      params,
    );
    return result.rows[0];
  };

  const deleteNode = async (id: string): Promise<void> => {
    await db.query(`DELETE FROM "nodes" WHERE "id" = $1`, [id]);
  };

  const deleteNodesBySource = async (
    sourceType: string,
    sourceId: string,
  ): Promise<void> => {
    await db.query(
      `DELETE FROM "nodes" WHERE "source_type" = $1 AND "source_id" = $2`,
      [sourceType, sourceId],
    );
  };

  const createEdge = async (
    edge: Omit<NewKnowledgeEdge, "id"> & { id?: string },
  ): Promise<KnowledgeEdge> => {
    // Generate ULID if not provided
    const edgeId = edge.id ?? ulid();
    const result = await db.query<KnowledgeEdge>(
      `INSERT INTO "edges" (
        "id", "source_node_id", "target_node_id", "type", "data", "weight", "created_at"
      ) VALUES (
        $1, $2, $3, $4, $5, $6, NOW()
      ) RETURNING *`,
      [
        edgeId,
        edge.sourceNodeId,
        edge.targetNodeId,
        edge.type,
        edge.data ?? {},
        edge.weight ?? 1.0,
      ],
    );
    return result.rows[0];
  };

  const createEdges = async (
    edges: Array<Omit<NewKnowledgeEdge, "id"> & { id?: string }>,
  ): Promise<KnowledgeEdge[]> => {
    if (edges.length === 0) return [];

    const created: KnowledgeEdge[] = [];
    for (const edge of edges) {
      const result = await createEdge(edge);
      created.push(result);
    }
    return created;
  };

  const getEdgesForNode = async (
    nodeId: string,
    direction: "in" | "out" | "both" = "both",
    types?: string[],
  ): Promise<KnowledgeEdge[]> => {
    let whereClause = "";
    const params: unknown[] = [nodeId];

    if (direction === "out") {
      whereClause = `"source_node_id" = $1`;
    } else if (direction === "in") {
      whereClause = `"target_node_id" = $1`;
    } else {
      whereClause = `("source_node_id" = $1 OR "target_node_id" = $1)`;
    }

    if (types && types.length > 0) {
      params.push(types);
      whereClause += ` AND "type" = ANY($${params.length})`;
    }

    type EdgeRow = {
      id: string;
      source_node_id: string;
      target_node_id: string;
      type: string;
      data: Record<string, unknown> | null;
      weight: number | null;
      created_at: Date;
    };

    const mapEdgeRow = (row: EdgeRow): KnowledgeEdge => ({
      id: row.id,
      sourceNodeId: row.source_node_id,
      targetNodeId: row.target_node_id,
      type: row.type,
      data: row.data,
      weight: row.weight,
      createdAt: row.created_at,
    });

    const result = await db.query<EdgeRow>(
      `SELECT * FROM "edges" WHERE ${whereClause} ORDER BY "created_at" DESC`,
      params,
    );

    return result.rows.map(mapEdgeRow);
  };

  const getEdgeById = async (
    id: string,
  ): Promise<KnowledgeEdge | undefined> => {
    type EdgeRow = {
      id: string;
      source_node_id: string;
      target_node_id: string;
      type: string;
      data: Record<string, unknown> | null;
      weight: number | null;
      created_at: Date;
    };

    const result = await db.query<EdgeRow>(
      `SELECT * FROM "edges" WHERE "id" = $1`,
      [id],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      id: row.id,
      sourceNodeId: row.source_node_id,
      targetNodeId: row.target_node_id,
      type: row.type,
      data: row.data,
      weight: row.weight,
      createdAt: row.created_at,
    };
  };

  const deleteEdge = async (id: string): Promise<void> => {
    await db.query(`DELETE FROM "edges" WHERE "id" = $1`, [id]);
  };

  const deleteEdgesForNode = async (nodeId: string): Promise<void> => {
    await db.query(
      `DELETE FROM "edges" WHERE "source_node_id" = $1 OR "target_node_id" = $1`,
      [nodeId],
    );
  };

  const searchNodes = async (
    options: GraphQueryOptions,
  ): Promise<GraphQueryResult[]> => {
    const {
      embedding,
      namespaces,
      nodeTypes,
      limit = 10,
      minSimilarity = 0.5,
    } = options;

    if (!embedding || embedding.length === 0) {
      // No embedding provided, return empty (or could do a text search)
      return [];
    }

    const params: unknown[] = [`[${embedding.join(",")}]`];
    let namespaceClause = "";
    let typeClause = "";

    if (namespaces && namespaces.length > 0) {
      params.push(namespaces);
      namespaceClause = `AND "namespace" = ANY($${params.length})`;
    }

    if (nodeTypes && nodeTypes.length > 0) {
      params.push(nodeTypes);
      typeClause = `AND "type" = ANY($${params.length})`;
    }

    params.push(minSimilarity);
    const thresholdIdx = params.length;

    params.push(limit);
    const limitIdx = params.length;

    const result = await db.query<KnowledgeNode & { similarity: number }>(
      `SELECT 
        *,
        1 - ("embedding" <=> $1::vector) as similarity
      FROM "nodes"
      WHERE "embedding" IS NOT NULL
        AND 1 - ("embedding" <=> $1::vector) > $${thresholdIdx}
        ${namespaceClause}
        ${typeClause}
      ORDER BY "embedding" <=> $1::vector
      LIMIT $${limitIdx}`,
      params,
    );

    return result.rows.map((row) => ({
      node: row,
      similarity: row.similarity,
      depth: 0,
      path: [],
    }));
  };

  const traverseGraph = async (
    startNodeId: string,
    edgeTypes?: string[],
    maxDepth: number = 2,
  ): Promise<TraversalResult> => {
    // Iterative BFS traversal (compatible with PGLite)
    const visited = new Set<string>();
    const allNodes: KnowledgeNode[] = [];
    const allEdges: KnowledgeEdge[] = [];
    let frontier = [startNodeId];

    // Raw SQL result type with snake_case columns
    type EdgeRow = {
      id: string;
      source_node_id: string;
      target_node_id: string;
      type: string;
      data: Record<string, unknown> | null;
      weight: number | null;
      created_at: Date;
    };

    for (let depth = 0; depth <= maxDepth && frontier.length > 0; depth++) {
      // Get nodes at current frontier
      const nodeResult = await db.query<KnowledgeNode>(
        `SELECT * FROM "nodes" WHERE "id" = ANY($1)`,
        [frontier],
      );

      for (const node of nodeResult.rows) {
        if (!visited.has(node.id as string)) {
          visited.add(node.id as string);
          allNodes.push(node);
        }
      }

      if (depth >= maxDepth) break;

      // Get edges from frontier nodes
      let edgeQuery = `
        SELECT * FROM "edges" 
        WHERE ("source_node_id" = ANY($1) OR "target_node_id" = ANY($1))
      `;
      const params: unknown[] = [frontier];

      if (edgeTypes && edgeTypes.length > 0) {
        params.push(edgeTypes);
        edgeQuery += ` AND "type" = ANY($2)`;
      }

      const edgeResult = await db.query<EdgeRow>(edgeQuery, params);

      // Collect next frontier
      const nextFrontier = new Set<string>();
      for (const row of edgeResult.rows) {
        // Convert snake_case to camelCase for KnowledgeEdge type
        const edge: KnowledgeEdge = {
          id: row.id,
          sourceNodeId: row.source_node_id,
          targetNodeId: row.target_node_id,
          type: row.type,
          data: row.data,
          weight: row.weight,
          createdAt: row.created_at,
        };

        if (!allEdges.some((e) => e.id === edge.id)) {
          allEdges.push(edge);
        }
        // Add connected nodes to next frontier
        if (!visited.has(edge.sourceNodeId)) {
          nextFrontier.add(edge.sourceNodeId);
        }
        if (!visited.has(edge.targetNodeId)) {
          nextFrontier.add(edge.targetNodeId);
        }
      }

      frontier = Array.from(nextFrontier);
    }

    return { nodes: allNodes, edges: allEdges };
  };

  const findRelatedNodes = async (
    nodeId: string,
    depth: number = 1,
  ): Promise<KnowledgeNode[]> => {
    const result = await traverseGraph(nodeId, undefined, depth);
    // Exclude the starting node
    return result.nodes.filter((n) => n.id !== nodeId);
  };

  const transaction = async <T>(
    fn: (ops: DatabaseOperations) => Promise<T>,
  ): Promise<T> => {
    const run = (db as unknown as {
      __copilotzTransaction?: <R>(fn: () => Promise<R>) => Promise<R>;
    }).__copilotzTransaction;
    if (typeof run !== "function") {
      return await fn(operations);
    }
    return await run(() => fn(operations));
  };

  const appendOutboxEvent = async (
    event: OutboxEventInput,
  ): Promise<Queue> => {
    if (event.dedupeKey) {
      const existing = await crud.events.findOne({
        dedupeKey: event.dedupeKey,
      } as Record<string, unknown>) as Queue | null;
      if (existing) return existing;
    }

    const ttlMs = typeof event.ttlMs === "number" && event.ttlMs > 0
      ? Math.floor(event.ttlMs)
      : null;
    const expiresAt = event.expiresAt
      ? toIsoString(event.expiresAt)
      : ttlMs
      ? new Date(Date.now() + ttlMs).toISOString()
      : null;

    const createEvent = crud.events.create as unknown as (
      data: Record<string, unknown>,
    ) => Promise<Queue>;
    const row = await createEvent({
      threadId: event.threadId,
      eventType: event.eventType,
      payload: sanitizePostgresParam(event.payload ?? {}),
      parentEventId: event.parentEventId ?? null,
      traceId: event.traceId ?? null,
      priority: event.priority ?? null,
      ttlMs,
      expiresAt: expiresAt ? new Date(expiresAt) : null,
      status: event.status ?? "completed",
      metadata: event.metadata ? sanitizePostgresParam(event.metadata) : null,
      namespace: event.namespace ?? null,
      subjectType: event.subjectType ?? null,
      subjectId: event.subjectId ?? null,
      operation: event.operation ?? null,
      causationId: event.causationId ?? event.parentEventId ?? null,
      correlationId: event.correlationId ?? event.traceId ?? null,
      dedupeKey: event.dedupeKey ?? null,
      input: event.input === undefined
        ? null
        : sanitizePostgresParam(event.input),
      before: event.before === undefined
        ? null
        : sanitizePostgresParam(event.before),
      after: event.after === undefined
        ? null
        : sanitizePostgresParam(event.after),
      patch: event.patch === undefined
        ? null
        : sanitizePostgresParam(event.patch),
    });
    return row;
  };

  const eventTypeFor = (
    subjectType: string,
    operation: string,
  ): string => `${subjectType}.${operation}`;

  const lifecycleEvent = async (
    args: DomainLifecycleEventInput,
  ): Promise<Queue> =>
    await appendOutboxEvent({
      ...args,
      eventType: eventTypeFor(args.subjectType, args.operation),
      payload: args.payload ?? {
        input: args.input,
        before: args.before,
        after: args.after,
        patch: args.patch,
      } as Record<string, unknown>,
    });

  const domainMutation = async <T>(
    fn: () => Promise<DomainMutationCommit<T>>,
  ): Promise<T> =>
    await transaction(async () => {
      const { result, event } = await fn();
      if (event) await lifecycleEvent(event);
      return result;
    });

  const graphTopicThreadId = (options: GraphMutationOptions): string => {
    const threadId = options.threadId?.trim();
    if (!threadId) {
      throw new Error(
        "Graph mutation requires a threadId queue topic. Use ops.unsafeGraph only for explicit raw graph writes.",
      );
    }
    return threadId;
  };

  const graphMutationEventBase = (
    options: GraphMutationOptions,
    subjectType: string,
    subjectId: string,
    operation: LifecycleOperation,
  ) => ({
    threadId: graphTopicThreadId(options),
    subjectType,
    subjectId,
    operation,
    traceId: options.traceId ?? null,
    causationId: options.causationId ?? null,
    correlationId: options.correlationId ?? null,
    namespace: options.namespace ?? null,
    metadata: options.metadata ?? null,
  });

  const createGraphNode = async (
    node: Omit<NewKnowledgeNode, "id"> & { id?: string },
    options: GraphMutationOptions,
  ): Promise<KnowledgeNode> =>
    await domainMutation(async () => {
      const created = await createNode(node);
      const after = await getNodeById(String(created.id)) ?? created;
      const subjectType = String(after.type ?? node.type ?? "node");
      return {
        result: after,
        event: {
          ...graphMutationEventBase(
            options,
            subjectType,
            String(after.id),
            "created",
          ),
          namespace: options.namespace ?? after.namespace ?? node.namespace ??
            null,
          input: node,
          after,
        },
      };
    });

  const updateGraphNode = async (
    id: string,
    updates: Partial<NewKnowledgeNode>,
    options: GraphMutationOptions,
  ): Promise<KnowledgeNode | undefined> =>
    await domainMutation(async () => {
      const before = await getNodeById(id);
      if (!before) return { result: undefined };
      const updated = await updateNode(id, updates);
      const after = updated ? await getNodeById(id) ?? updated : undefined;
      return {
        result: after,
        event: after
          ? {
            ...graphMutationEventBase(
              options,
              String(after.type ?? before.type ?? "node"),
              id,
              "updated",
            ),
            namespace: options.namespace ?? after.namespace ??
              before.namespace ?? null,
            before,
            after,
            patch: updates,
          }
          : null,
      };
    });

  const deleteGraphNode = async (
    id: string,
    options: GraphMutationOptions,
  ): Promise<void> =>
    await domainMutation(async () => {
      const before = await getNodeById(id);
      if (!before) return { result: undefined };
      await deleteNode(id);
      return {
        result: undefined,
        event: {
          ...graphMutationEventBase(
            options,
            String(before.type ?? "node"),
            id,
            "deleted",
          ),
          namespace: options.namespace ?? before.namespace ?? null,
          before,
          after: null,
        },
      };
    });

  const createGraphEdge = async (
    edge: Omit<NewKnowledgeEdge, "id"> & { id?: string },
    options: GraphMutationOptions,
  ): Promise<KnowledgeEdge> =>
    await domainMutation(async () => {
      const created = await createEdge(edge);
      const after = await getEdgeById(String(created.id)) ?? created;
      return {
        result: after,
        event: {
          ...graphMutationEventBase(
            options,
            "edge",
            String(after.id),
            "created",
          ),
          input: edge,
          after,
          metadata: {
            ...(options.metadata ?? {}),
            edgeType: after.type ?? edge.type,
          },
        },
      };
    });

  const deleteGraphEdge = async (
    id: string,
    options: GraphMutationOptions,
  ): Promise<void> =>
    await domainMutation(async () => {
      const before = await getEdgeById(id);
      if (!before) return { result: undefined };
      await deleteEdge(id);
      return {
        result: undefined,
        event: {
          ...graphMutationEventBase(options, "edge", id, "deleted"),
          before,
          after: null,
          metadata: {
            ...(options.metadata ?? {}),
            edgeType: before.type,
          },
        },
      };
    });

  const mergeNodeData = (
    node: KnowledgeNode,
    patch: Record<string, unknown>,
  ): Record<string, unknown> => ({
    ...((node.data && typeof node.data === "object") ? node.data : {}),
    ...patch,
  });

  const runSenderExternalId = (
    sender?: Record<string, unknown> | null,
  ): string | null => {
    const candidates = [
      sender?.externalId,
      sender?.id,
      sender?.email,
      sender?.name,
    ];
    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate.trim().length > 0) {
        return candidate.trim();
      }
    }
    return null;
  };

  const createLlmAttemptParticipantEdges = async (
    input: {
      namespace: string;
      attemptNodeId: string;
      agentId?: string | null;
      runSender?: Record<string, unknown> | null;
    },
  ): Promise<void> => {
    const edges: Array<{
      sourceNodeId: string;
      targetNodeId: string;
      type: string;
    }> = [];

    if (input.agentId) {
      const agent = await getParticipantNode(input.agentId, input.namespace);
      if (agent?.id) {
        edges.push({
          sourceNodeId: agent.id as string,
          targetNodeId: input.attemptNodeId,
          type: GRAPH_EDGE.USED_LLM,
        });
      }
    }

    const senderId = runSenderExternalId(input.runSender);
    if (senderId) {
      const initiator = await getParticipantNode(senderId, input.namespace);
      if (initiator?.id) {
        edges.push({
          sourceNodeId: initiator.id as string,
          targetNodeId: input.attemptNodeId,
          type: GRAPH_EDGE.INITIATED_LLM_USAGE,
        });
      }
    }

    for (const edge of edges) {
      await createEdge(edge).catch(() => undefined);
    }
  };

  const getNodeBySource = async (
    namespace: string,
    type: string,
    sourceType: string,
    sourceId: string,
  ): Promise<KnowledgeNode | undefined> => {
    const result = await db.query<Record<string, unknown>>(
      `SELECT *
       FROM "nodes"
       WHERE "namespace" = $1
         AND "type" = $2
         AND "source_type" = $3
         AND "source_id" = $4
       ORDER BY "created_at" ASC
       LIMIT 1`,
      [namespace, type, sourceType, sourceId],
    );
    return result.rows[0] ? mapNodeRow(result.rows[0]) : undefined;
  };

  const createThreadGraphNode = async (
    thread: Thread,
    options?: {
      metadata?: Record<string, unknown> | null;
      namespace?: string | null;
    },
  ): Promise<KnowledgeNode> => {
    return await domainMutation(async () => {
      const threadId = String(thread.id);
      const namespace = options?.namespace ?? thread.namespace ?? "default";
      const existing = await getNodeBySource(
        namespace,
        "thread",
        "thread",
        threadId,
      );
      if (existing) return { result: existing };

      const node = await createNode({
        namespace,
        type: "thread",
        name: String(thread.name ?? threadId),
        content: thread.summary ?? thread.description ?? null,
        sourceType: "thread",
        sourceId: threadId,
        data: {
          threadId,
          externalId: thread.externalId ?? null,
          status: thread.status ?? null,
          parentThreadId: thread.parentThreadId ?? null,
          rootThreadId: thread.rootThreadId ?? thread.id,
          participants: thread.participants ?? null,
          metadata: options?.metadata ?? thread.metadata ?? null,
        },
      });

      return {
        result: node,
        event: {
          threadId,
          subjectType: "thread",
          subjectId: node.id as string,
          operation: "created",
          after: node,
          namespace,
        },
      };
    });
  };

  const createDomainMessage = async (
    message: MessageInsert,
    namespace?: string | null,
    options?: { traceId?: string | null; causationId?: string | null },
  ): Promise<Message> =>
    await domainMutation(async () => {
      const created = await createMessage(message, namespace ?? undefined);
      return {
        result: created,
        event: {
          threadId: created.threadId,
          subjectType: "message",
          subjectId: created.id,
          operation: "created",
          input: message,
          after: created as unknown as Record<string, unknown>,
          traceId: options?.traceId ?? null,
          causationId: options?.causationId ?? null,
          namespace,
        },
      };
    });

  const appendMessageSegments = async (
    messageId: string,
    segments: unknown[],
    options?: {
      threadId?: string | null;
      namespace?: string | null;
      traceId?: string | null;
      causationId?: string | null;
    },
  ): Promise<KnowledgeNode | undefined> =>
    await domainMutation(async () => {
      const node = await getNodeById(messageId);
      if (!node) return { result: undefined };
      const previous = node;
      const data = mergeNodeData(node, {
        segments: [
          ...(((node.data as Record<string, unknown> | null)
            ?.segments as unknown[]) ?? []),
          ...segments,
        ],
      });
      const updated = await updateNode(messageId, { data });
      return {
        result: updated,
        event: options?.threadId && updated
          ? {
            threadId: options.threadId,
            subjectType: "message",
            subjectId: messageId,
            operation: "updated",
            before: previous,
            after: updated,
            patch: { segments },
            traceId: options.traceId ?? null,
            causationId: options.causationId ?? null,
            namespace: options.namespace ?? null,
          }
          : null,
      };
    });

  const createLlmAttempt = async (
    input: LlmAttemptInput,
  ): Promise<KnowledgeNode> =>
    await domainMutation(async () => {
      const now = new Date().toISOString();
      const node = await createNode({
        id: input.id,
        namespace: input.namespace ?? "default",
        type: "llm_attempt",
        name: `${input.agentName ?? input.agentId ?? "agent"}:${
          input.provider ?? "provider"
        }/${input.model ?? "model"}`,
        sourceType: "llm_attempt",
        sourceId: input.eventId ?? input.id ?? null,
        data: {
          threadId: input.threadId,
          messageId: input.messageId ?? null,
          eventId: input.eventId ?? null,
          agentId: input.agentId ?? null,
          agentName: input.agentName ?? null,
          provider: input.provider ?? null,
          model: input.model ?? null,
          config: input.config ?? null,
          messages: input.messages ?? null,
          tools: input.tools ?? null,
          status: input.status ?? "processing",
          attemptIndex: input.attemptIndex ?? 0,
          parentAttemptId: input.parentAttemptId ?? null,
          runSender: input.runSender ?? null,
          startedAt: now,
          metadata: input.metadata ?? null,
        },
      });
      if (input.messageId) {
        await createEdge({
          sourceNodeId: input.messageId,
          targetNodeId: node.id as string,
          type: GRAPH_EDGE.HAS_LLM_ATTEMPT,
        });
      }
      await createLlmAttemptParticipantEdges({
        namespace: input.namespace ?? "default",
        attemptNodeId: node.id as string,
        agentId: input.agentId ?? null,
        runSender: input.runSender ?? null,
      });
      return {
        result: node,
        event: {
          threadId: input.threadId,
          subjectType: "llm_attempt",
          subjectId: node.id as string,
          operation: "created",
          input,
          after: node,
          causationId: input.eventId ?? null,
          namespace: input.namespace ?? null,
        },
      };
    });

  const updateLlmAttempt = async (
    id: string,
    patch: LlmAttemptPatch,
    operation = "updated",
    options?: {
      threadId?: string | null;
      traceId?: string | null;
      causationId?: string | null;
      namespace?: string | null;
    },
  ): Promise<KnowledgeNode | undefined> =>
    await domainMutation(async () => {
      const previous = await getNodeById(id);
      if (!previous) return { result: undefined };
      const dataPatch: Record<string, unknown> = {
        ...patch,
        ...(patch.startedAt ? { startedAt: toIsoString(patch.startedAt) } : {}),
        ...(patch.finishedAt
          ? { finishedAt: toIsoString(patch.finishedAt) }
          : {}),
        ...(patch.metricsFinalizedAt
          ? { metricsFinalizedAt: toIsoString(patch.metricsFinalizedAt) }
          : {}),
      };
      const updated = await updateNode(id, {
        content: patch.answer ?? patch.partialAnswer ?? previous.content ??
          null,
        data: mergeNodeData(previous, dataPatch),
      });
      return {
        result: updated,
        event: options?.threadId && updated
          ? {
            threadId: options.threadId,
            subjectType: "llm_attempt",
            subjectId: id,
            operation,
            before: previous,
            after: updated,
            patch: dataPatch,
            traceId: options.traceId ?? null,
            causationId: options.causationId ?? null,
            namespace: options.namespace ?? null,
          }
          : null,
      };
    });

  const createToolExecution = async (
    input: ToolExecutionInput,
  ): Promise<KnowledgeNode> =>
    await domainMutation(async () => {
      const now = new Date().toISOString();
      const node = await createNode({
        id: input.id,
        namespace: input.namespace ?? "default",
        type: "tool_execution",
        name: String(input.tool.name ?? input.tool.id ?? input.toolCallId),
        sourceType: "tool_execution",
        sourceId: input.toolCallId,
        data: {
          threadId: input.threadId,
          messageId: input.messageId ?? null,
          eventId: input.eventId ?? null,
          agentId: input.agentId ?? null,
          agentName: input.agentName ?? null,
          toolCallId: input.toolCallId,
          tool: input.tool,
          args: input.args ?? null,
          status: input.status ?? "processing",
          startedAt: now,
          metadata: input.metadata ?? null,
        },
      });
      if (input.messageId) {
        await createEdge({
          sourceNodeId: input.messageId,
          targetNodeId: node.id as string,
          type: GRAPH_EDGE.HAS_TOOL_EXECUTION,
        });
      }
      return {
        result: node,
        event: {
          threadId: input.threadId,
          subjectType: "tool_execution",
          subjectId: node.id as string,
          operation: "created",
          input,
          after: node,
          causationId: input.eventId ?? null,
          namespace: input.namespace ?? null,
        },
      };
    });

  const updateToolExecution = async (
    id: string,
    patch: ToolExecutionPatch,
    operation = "updated",
    options?: {
      threadId?: string | null;
      traceId?: string | null;
      causationId?: string | null;
      namespace?: string | null;
    },
  ): Promise<KnowledgeNode | undefined> =>
    await domainMutation(async () => {
      const previous = await getNodeById(id);
      if (!previous) return { result: undefined };
      const dataPatch: Record<string, unknown> = {
        ...patch,
        ...(patch.startedAt ? { startedAt: toIsoString(patch.startedAt) } : {}),
        ...(patch.finishedAt
          ? { finishedAt: toIsoString(patch.finishedAt) }
          : {}),
      };
      const updated = await updateNode(id, {
        data: mergeNodeData(previous, dataPatch),
      });
      return {
        result: updated,
        event: options?.threadId && updated
          ? {
            threadId: options.threadId,
            subjectType: "tool_execution",
            subjectId: id,
            operation,
            before: previous,
            after: updated,
            patch: dataPatch,
            traceId: options.traceId ?? null,
            causationId: options.causationId ?? null,
            namespace: options.namespace ?? null,
          }
          : null,
      };
    });

  const getToolExecutionOutput = async (
    id: string,
    threadId: string,
  ): Promise<
    { node: KnowledgeNode; output: unknown; projectedOutput?: unknown } | null
  > => {
    const node = await getNodeById(id);
    if (!node || node.type !== "tool_execution") return null;
    const data = node.data && typeof node.data === "object"
      ? node.data as Record<string, unknown>
      : {};
    if (data.threadId !== threadId) return null;
    return {
      node,
      output: data.output,
      ...(data.projectedOutput !== undefined
        ? { projectedOutput: data.projectedOutput }
        : {}),
    };
  };

  const createAssetNode = async (
    input: {
      id?: string;
      threadId: string;
      ref?: string | null;
      mime?: string | null;
      by?: string | null;
      toolCallId?: string | null;
      metadata?: Record<string, unknown> | null;
      namespace?: string | null;
    },
  ): Promise<KnowledgeNode> =>
    await domainMutation(async () => {
      const node = await createNode({
        id: input.id,
        namespace: input.namespace ?? "default",
        type: "asset",
        name: input.ref ?? input.id ?? "asset",
        sourceType: "asset",
        sourceId: input.id ?? input.ref ?? null,
        data: {
          threadId: input.threadId,
          ref: input.ref ?? null,
          mime: input.mime ?? null,
          by: input.by ?? null,
          toolCallId: input.toolCallId ?? null,
          metadata: input.metadata ?? null,
        },
      });
      return {
        result: node,
        event: {
          threadId: input.threadId,
          subjectType: "asset",
          subjectId: node.id as string,
          operation: "created",
          input,
          after: node,
          namespace: input.namespace ?? null,
        },
      };
    });

  const forkThread = async (
    input: ThreadForkInput,
    options: ThreadMutationOptions = {},
  ): Promise<Thread> =>
    await domainMutation(async () => {
      const source = await getThreadById(input.sourceThreadId);
      if (!source) {
        throw new Error(`Source thread not found: ${input.sourceThreadId}`);
      }

      const { sourceThreadId: _sourceThreadId, ...forkInput } = input;
      const threadId = typeof forkInput.id === "string"
        ? forkInput.id
        : undefined;
      const rootThreadId = forkInput.rootThreadId ?? source.rootThreadId ??
        source.id;
      const forked = await findOrCreateThread(threadId, {
        ...forkInput,
        namespace: forkInput.namespace ?? source.namespace ??
          options.namespace ??
          null,
        name: forkInput.name ?? `Fork of ${source.name ?? source.id}`,
        participants: forkInput.participants ?? source.participants ?? null,
        parentThreadId: source.id as string,
        rootThreadId: rootThreadId as string,
        status: forkInput.status ?? "active",
        mode: forkInput.mode ?? source.mode ?? "immediate",
      }, options);

      return {
        result: forked,
        event: {
          threadId: String(forked.id),
          subjectType: "thread",
          subjectId: String(forked.id),
          operation: "forked",
          input,
          before: source as unknown as Record<string, unknown>,
          after: forked as unknown as Record<string, unknown>,
          traceId: options.traceId ?? null,
          causationId: options.causationId ?? null,
          namespace: typeof forked.namespace === "string"
            ? forked.namespace
            : options.namespace ?? null,
        },
      };
    });

  const mutate: DomainMutationOperations = {
    threads: {
      create: (threadId, threadData, options) =>
        findOrCreateThread(threadId, threadData, options),
      update: (threadId, updates, options) =>
        updateThread(threadId, updates, options),
      fork: forkThread,
      ensureGraphNode: createThreadGraphNode,
    },
    messages: {
      create: createDomainMessage,
      appendSegments: appendMessageSegments,
    },
    llmAttempts: {
      create: createLlmAttempt,
      update: (id, patch, options) =>
        updateLlmAttempt(id, patch, "updated", options),
      complete: (id, patch, options) =>
        updateLlmAttempt(
          id,
          { ...patch, status: patch.status ?? "completed" },
          "completed",
          options,
        ),
      fail: (id, patch, options) =>
        updateLlmAttempt(
          id,
          { ...patch, status: patch.status ?? "failed" },
          "failed",
          options,
        ),
    },
    toolExecutions: {
      create: createToolExecution,
      update: (id, patch, options) =>
        updateToolExecution(id, patch, "updated", options),
      complete: (id, patch, options) =>
        updateToolExecution(
          id,
          { ...patch, status: patch.status ?? "completed" },
          "completed",
          options,
        ),
      fail: (id, patch, options) =>
        updateToolExecution(
          id,
          { ...patch, status: patch.status ?? "failed" },
          "failed",
          options,
        ),
      getOutput: getToolExecutionOutput,
    },
    assets: {
      create: createAssetNode,
    },
    graph: {
      createNode: createGraphNode,
      updateNode: updateGraphNode,
      deleteNode: deleteGraphNode,
      createEdge: createGraphEdge,
      deleteEdge: deleteGraphEdge,
    },
  };

  const unsafeGraph: UnsafeGraphOperations = {
    createNode,
    createNodes,
    getNodeById,
    getNodesByNamespace,
    updateNode,
    deleteNode,
    deleteNodesBySource,
    createEdge,
    createEdges,
    getEdgesForNode,
    deleteEdge,
    deleteEdgesForNode,
    searchNodes,
    traverseGraph,
    findRelatedNodes,
  };

  operations = {
    crud,
    query: db.query.bind(db),
    transaction,
    outbox: {
      append: appendOutboxEvent,
    },
    mutate,
    unsafeGraph,
    addToQueue,
    getQueueItemById,
    getQueueItemsByTraceId,
    getNewerInterruptingEvent,
    hasNewerHumanInput,
    overwritePendingAgentContinuations,
    getProcessingQueueItem,
    getThreadActivity,
    getNextPendingQueueItem,
    updateQueueItemStatus,
    mergeQueueItemMetadata,
    acquireThreadWorkerLease,
    renewThreadWorkerLease,
    isThreadWorkerLeaseOwner,
    releaseThreadWorkerLease,
    releaseThreadWorkerLeaseIfNoPendingWork,
    getThreadWorkerLeaseConfig,
    recoverThreadProcessingQueueItems,
    getMessageHistory,
    getThreadsForParticipant,
    getMessagesForThread,
    deleteMessagesForThread,
    getThreadById,
    getThreadByExternalId,
    findOrCreateThread,
    updateThread,
    deleteThread,
    createMessage,
    archiveThread,
    peekCoalescableCandidates,
    claimAndCompleteEventsBatch,
    // Participant node operations (unified users & agents)
    upsertParticipantNode,
    getParticipantNode,
    listLegacyParticipantGraphNodes,
    // Message as node operations
    createMessageNode,
    getMessageHistoryFromGraph,
    getMessageHistoryPageFromGraph,
    getLastMessageNode,
    // Chunk as node operations
    searchChunksFromGraph,
    // RAG operations (legacy)
    createDocument,
    getDocumentById,
    getDocumentByHash,
    updateDocumentStatus,
    deleteDocument,
    createChunks,
    searchChunks,
    getNamespaceStats,
    deleteChunksByDocumentId,
    // Knowledge graph operations
    createNode,
    createNodes,
    getNodeById,
    getNodesByNamespace,
    updateNode,
    deleteNode,
    deleteNodesBySource,
    createEdge,
    createEdges,
    getEdgesForNode,
    deleteEdge,
    deleteEdgesForNode,
    searchNodes,
    traverseGraph,
    findRelatedNodes,
  };
  return operations;
}
