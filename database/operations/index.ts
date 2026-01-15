import type {
  Message,
  NewMessage,
  NewQueue,
  NewTask,
  NewThread,
  Queue,
  Task,
  Thread,
  User,
  Document,
  NewDocument,
  DocumentChunk,
  NewDocumentChunk,
  KnowledgeNode,
  NewKnowledgeNode,
  KnowledgeEdge,
  NewKnowledgeEdge,
} from "../schemas/index.ts";
import type { DbInstance } from "../index.ts";

const MAX_EXPIRED_CLEANUP_BATCH = 100;
const EXPIRED_RETENTION_INTERVAL = "1 day";


type MessageInsert =
  & Omit<NewMessage, "id">
  & { id?: string };
type ThreadInsert = NewThread;
type TaskInsert = NewTask;

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
}

// RAG types
export interface ChunkSearchOptions {
  query?: string;
  embedding?: number[];
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

export interface DatabaseOperations {
  crud: DbInstance["crud"];
  addToQueue: (threadId: string, event: QueueEventInput) => Promise<NewQueue>;
  getProcessingQueueItem: (threadId: string) => Promise<Queue | undefined>;
  getNextPendingQueueItem: (threadId: string) => Promise<Queue | undefined>;
  updateQueueItemStatus: (queueId: string, status: Queue["status"]) => Promise<void>;
  getMessageHistory: (threadId: string, userId: string, limit?: number) => Promise<Message[]>;
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
  getThreadById: (threadId: string) => Promise<Thread | undefined>;
  getThreadByExternalId: (externalId: string) => Promise<Thread | undefined>;
  findOrCreateThread: (threadId: string | undefined, threadData: ThreadInsert) => Promise<Thread>;
  createMessage: (message: MessageInsert) => Promise<Message>;
  getTaskById: (taskId: string) => Promise<Task | undefined>;
  createTask: (taskData: TaskInsert) => Promise<Task>;
  getUserByExternalId: (externalId: string) => Promise<User | undefined>;
  archiveThread: (threadId: string, summary: string) => Promise<Thread | null>;
  
  // RAG operations (legacy - use graph operations for new code)
  createDocument: (doc: Omit<NewDocument, "id"> & { id?: string }) => Promise<Document>;
  getDocumentById: (id: string) => Promise<Document | undefined>;
  getDocumentByHash: (hash: string, namespace: string) => Promise<Document | undefined>;
  updateDocumentStatus: (id: string, status: Document["status"], errorMessage?: string, chunkCount?: number) => Promise<void>;
  deleteDocument: (id: string) => Promise<void>;
  createChunks: (chunks: Array<Omit<NewDocumentChunk, "id"> & { id?: string }>) => Promise<DocumentChunk[]>;
  searchChunks: (options: ChunkSearchOptions) => Promise<ChunkSearchResult[]>;
  getNamespaceStats: () => Promise<NamespaceStats[]>;
  deleteChunksByDocumentId: (documentId: string) => Promise<void>;

  // ============================================
  // KNOWLEDGE GRAPH OPERATIONS
  // ============================================
  
  // Node CRUD
  createNode: (node: Omit<NewKnowledgeNode, "id"> & { id?: string }) => Promise<KnowledgeNode>;
  createNodes: (nodes: Array<Omit<NewKnowledgeNode, "id"> & { id?: string }>) => Promise<KnowledgeNode[]>;
  getNodeById: (id: string) => Promise<KnowledgeNode | undefined>;
  getNodesByNamespace: (namespace: string, type?: string) => Promise<KnowledgeNode[]>;
  updateNode: (id: string, updates: Partial<NewKnowledgeNode>) => Promise<KnowledgeNode | undefined>;
  deleteNode: (id: string) => Promise<void>;
  deleteNodesBySource: (sourceType: string, sourceId: string) => Promise<void>;
  
  // Edge CRUD
  createEdge: (edge: Omit<NewKnowledgeEdge, "id"> & { id?: string }) => Promise<KnowledgeEdge>;
  createEdges: (edges: Array<Omit<NewKnowledgeEdge, "id"> & { id?: string }>) => Promise<KnowledgeEdge[]>;
  getEdgesForNode: (nodeId: string, direction?: "in" | "out" | "both", types?: string[]) => Promise<KnowledgeEdge[]>;
  deleteEdge: (id: string) => Promise<void>;
  deleteEdgesForNode: (nodeId: string) => Promise<void>;
  
  // Graph queries
  searchNodes: (options: GraphQueryOptions) => Promise<GraphQueryResult[]>;
  traverseGraph: (startNodeId: string, edgeTypes?: string[], maxDepth?: number) => Promise<TraversalResult>;
  findRelatedNodes: (nodeId: string, depth?: number) => Promise<KnowledgeNode[]>;
}

const toIsoString = (
  value: Date | string | null | undefined,
): string | null => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

export function createOperations(db: DbInstance): DatabaseOperations {
  const { crud } = db;

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
      payload: event.payload,
      parentEventId: event.parentEventId ?? null,
      traceId: event.traceId ?? null,
      priority: event.priority ?? null,
      ttlMs,
      expiresAt: expiresAt ? new Date(expiresAt) : null,
      status: event.status ?? "pending",
      metadata: event.metadata ?? null,
    };

    const newQueueItem = await crud.events.create(insertQueueItem);

    await cleanupExpiredQueueItems();
    return newQueueItem;
  };

  const getProcessingQueueItem = async (
    threadId: string,
  ): Promise<Queue | undefined> => {
    const item = await crud.events.findOne({
      threadId,
      status: "processing",
    }) as Queue | null;
    return item ?? undefined;
  };

  const getNextPendingQueueItem = async (
    threadId: string,
  ): Promise<Queue | undefined> => {
    while (true) {
      const [candidate] = await crud.events.find({
        threadId,
        status: "pending",
      }, {
        limit: 1,
        sort: [
          ["priority", "desc"],
          ["createdAt", "asc"],
          ["id", "asc"],
        ],
      });

      if (!candidate) {
        await cleanupExpiredQueueItems();
        return undefined;
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

  const getThreadById = async (
    threadId: string,
  ): Promise<Thread | undefined> => {
    const thread = await crud.threads.findOne({
      id: threadId,
      status: "active",
    }) as Thread | null;
    return thread ?? undefined;
  };

  const getThreadByExternalId = async (
    externalId: string,
  ): Promise<Thread | undefined> => {
    const thread = await crud.threads.findOne({ externalId, status: "active" }) as Thread | null;
    return thread ?? undefined;
  };

  const findOrCreateThread = async (
    threadId: string | undefined,
    threadData: ThreadInsert,
  ): Promise<Thread> => {
    let existing: Thread | null = null;
    if (threadId) {
      existing = await crud.threads.findOne({ id: threadId }) as Thread | null;
    } else if (typeof threadData.externalId === "string" && threadData.externalId) {
      existing = await crud.threads.findOne({ externalId: threadData.externalId }) as Thread | null;
    }

    const normalizeParticipants = (participants?: string[] | null) => {
      if (!Array.isArray(participants)) return participants ?? null;
      return Array.from(new Set(participants));
    };

    if (!existing) {
      const participants = normalizeParticipants(threadData.participants);
      const baseInsert = {
        name: threadData.name,
        externalId: threadData.externalId ?? null,
        description: threadData.description ?? null,
        participants,
        initialMessage: threadData.initialMessage ?? null,
        mode: threadData.mode ?? "immediate",
        status: threadData.status ?? "active",
        summary: threadData.summary ?? null,
        parentThreadId: threadData.parentThreadId ?? null,
        metadata: threadData.metadata ?? null
      };
      const created = await crud.threads.create(
        threadId ? { id: threadId, ...baseInsert } : baseInsert
      ) as Thread;
      return created;
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

    if (threadData.metadata !== undefined) {
      const normalizedMetadata = threadData.metadata ?? null;
      if (
        JSON.stringify(existing.metadata ?? null) !==
        JSON.stringify(normalizedMetadata)
      ) {
        updates.metadata = normalizedMetadata;
      }
    }

    if (Object.keys(updates).length === 0) {
      return existing;
    }

    const updated = await crud.threads.update({ id: threadId }, updates);
    return (updated ?? existing) as Thread;
  };

  const createMessage = async (message: MessageInsert): Promise<Message> => {
    const created = await crud.messages.create({
      threadId: message.threadId,
      senderId: message.senderId,
      senderType: message.senderType,
      senderUserId: message.senderUserId ?? undefined,
      externalId: message.externalId ?? undefined,
      content: message.content ?? undefined,
      toolCallId: message.toolCallId ?? undefined,
      toolCalls: message.toolCalls ?? undefined,
      metadata: message.metadata ?? undefined,
    });
    return created as Message;
  };

  const getMessageHistory = async (
    threadId: string,
    userId: string,
    limit = 50,
  ): Promise<Message[]> => {
    const allMessages: { message: Message, threadLevel: number }[] = [];
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
        ? thread.participants.filter((participant: string): participant is string =>
          typeof participant === "string"
        )
        : [];
      if (!participants.includes(userId)) {
        break;
      }

      const threadMessages = await crud.messages.find({
        threadId: currentThreadId,
      });

      for (const msg of threadMessages) {
        allMessages.push({ message: msg as Message, threadLevel: level });
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

  const getThreadsForParticipant = async (
    participantId: string,
    options?: {
      status?: Thread["status"] | "all";
      limit?: number;
      offset?: number;
      order?: "asc" | "desc";
    },
  ): Promise<Thread[]> => {
    const statusFilter = options?.status ?? "active";
    const order = options?.order === "asc" ? "ASC" : "DESC";

    const params: unknown[] = [];
    const whereParts: string[] = [];
    let index = 1;

    whereParts.push(`"participants" ? $${index}`);
    params.push(participantId);
    index += 1;

    if (statusFilter !== "all") {
      whereParts.push(`"status" = $${index}`);
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
      `SELECT *
       FROM "threads"
       WHERE ${whereParts.join(" AND ")}
       ORDER BY "updatedAt" ${order}
       ${limitClause}
       ${offsetClause}`.trim(),
      params,
    );

    return result.rows as Thread[];
  };

  const getMessagesForThread = async (
    threadId: string,
    options?: {
      limit?: number;
      offset?: number;
      order?: "asc" | "desc";
    },
  ): Promise<Message[]> => {
    const order = options?.order === "desc" ? "desc" : "asc";
    const messages = await crud.messages.find({ threadId }, {
      limit: options?.limit,
      offset: options?.offset,
      sort: [["createdAt", order]],
    });
    return messages as Message[];
  };

  const getTaskById = async (taskId: string): Promise<Task | undefined> => {
    const task = await crud.tasks.findOne({ id: taskId }) as Task | null;
    return task ?? undefined;
  };

  const createTask = async (taskData: TaskInsert): Promise<Task> => {
    return await crud.tasks.create({
      name: taskData.name,
      externalId: taskData.externalId ?? null,
      goal: taskData.goal,
      successCriteria: taskData.successCriteria ?? null,
      status: taskData.status ?? "pending",
      notes: taskData.notes ?? null,
      metadata: taskData.metadata ?? null,
    }) as Task;
  };

  const getUserByExternalId = async (
    externalId: string,
  ): Promise<User | undefined> => {
    const user = await crud.users.findOne({ externalId }) as User | null;
    return user ?? undefined;
  };

  const archiveThread = async (
    threadId: string,
    summary: string,
  ): Promise<Thread | null> => {
    const updated = await crud.threads.update({ id: threadId }, {
      status: "archived",
      summary,
    }) as Thread | null;
    return updated ?? null;
  };

  // RAG Operations

  const createDocument = async (
    doc: Omit<NewDocument, "id"> & { id?: string },
  ): Promise<Document> => {
    const created = await crud.documents.create({
      namespace: doc.namespace ?? "default",
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
    });
    return created as Document;
  };

  const getDocumentById = async (id: string): Promise<Document | undefined> => {
    const doc = await crud.documents.findOne({ id }) as Document | null;
    return doc ?? undefined;
  };

  const getDocumentByHash = async (
    hash: string,
    namespace: string,
  ): Promise<Document | undefined> => {
    const doc = await crud.documents.findOne({
      contentHash: hash,
      namespace,
    }) as Document | null;
    return doc ?? undefined;
  };

  const updateDocumentStatus = async (
    id: string,
    status: Document["status"],
    errorMessage?: string,
    chunkCount?: number,
  ): Promise<void> => {
    const updates: Partial<Document> = { status };
    if (errorMessage !== undefined) {
      updates.errorMessage = errorMessage;
    }
    if (chunkCount !== undefined) {
      updates.chunkCount = chunkCount;
    }
    await crud.documents.update({ id }, updates);
  };

  const deleteDocument = async (id: string): Promise<void> => {
    // Chunks are deleted via CASCADE in the database
    await crud.documents.delete({ id });
  };

  const deleteChunksByDocumentId = async (documentId: string): Promise<void> => {
    await db.query(
      `DELETE FROM "document_chunks" WHERE "documentId" = $1`,
      [documentId],
    );
  };

  const createChunks = async (
    chunks: Array<Omit<NewDocumentChunk, "id"> & { id?: string }>,
  ): Promise<DocumentChunk[]> => {
    if (chunks.length === 0) return [];

    const created: DocumentChunk[] = [];
    for (const chunk of chunks) {
      // For vector embedding, we need to use raw SQL since omnipg may not handle vector type directly
      if (chunk.embedding && Array.isArray(chunk.embedding)) {
        const embeddingStr = `[${chunk.embedding.join(",")}]`;
        const result = await db.query<DocumentChunk>(
          `INSERT INTO "document_chunks" 
           ("id", "documentId", "namespace", "chunkIndex", "content", "tokenCount", "embedding", "startPosition", "endPosition", "metadata", "createdAt")
           VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6::vector, $7, $8, $9, NOW())
           RETURNING *`,
          [
            chunk.documentId,
            chunk.namespace,
            chunk.chunkIndex,
            chunk.content,
            chunk.tokenCount ?? null,
            embeddingStr,
            chunk.startPosition ?? null,
            chunk.endPosition ?? null,
            chunk.metadata ? JSON.stringify(chunk.metadata) : null,
          ],
        );
        if (result.rows[0]) {
          created.push(result.rows[0]);
        }
      } else {
        const c = await crud.documentChunks.create({
          documentId: chunk.documentId,
          namespace: chunk.namespace,
          chunkIndex: chunk.chunkIndex,
          content: chunk.content,
          tokenCount: chunk.tokenCount ?? null,
          embedding: null,
          startPosition: chunk.startPosition ?? null,
          endPosition: chunk.endPosition ?? null,
          metadata: chunk.metadata ?? null,
        });
        created.push(c as DocumentChunk);
      }
    }
    return created;
  };

  const searchChunks = async (
    options: ChunkSearchOptions,
  ): Promise<ChunkSearchResult[]> => {
    if (!options.embedding || options.embedding.length === 0) {
      return [];
    }

    const embeddingStr = `[${options.embedding.join(",")}]`;
    const limit = options.limit ?? 5;
    const threshold = options.threshold ?? 0.0;
    const namespaces = options.namespaces ?? [];

    const params: unknown[] = [embeddingStr, threshold, limit];
    let namespaceClause = "";
    
    if (namespaces.length > 0) {
      namespaceClause = `AND dc."namespace" = ANY($4::text[])`;
      params.push(namespaces);
    }

    let documentFilterClause = "";
    if (options.documentFilters) {
      const filters = options.documentFilters;
      if (filters.sourceType) {
        params.push(filters.sourceType);
        documentFilterClause += ` AND d."sourceType" = $${params.length}`;
      }
      if (filters.mimeType) {
        params.push(filters.mimeType);
        documentFilterClause += ` AND d."mimeType" = $${params.length}`;
      }
      if (filters.status) {
        params.push(filters.status);
        documentFilterClause += ` AND d."status" = $${params.length}`;
      }
    }

    const result = await db.query<{
      id: string;
      content: string;
      namespace: string;
      chunkIndex: number;
      similarity: number;
      tokenCount: number | null;
      metadata: Record<string, unknown> | null;
      documentId: string;
      documentTitle: string | null;
      documentSourceUri: string | null;
      documentSourceType: string;
      documentMimeType: string | null;
    }>(
      `SELECT 
        dc."id",
        dc."content",
        dc."namespace",
        dc."chunkIndex",
        1 - (dc."embedding" <=> $1::vector) as similarity,
        dc."tokenCount",
        dc."metadata",
        d."id" as "documentId",
        d."title" as "documentTitle",
        d."sourceUri" as "documentSourceUri",
        d."sourceType" as "documentSourceType",
        d."mimeType" as "documentMimeType"
      FROM "document_chunks" dc
      JOIN "documents" d ON dc."documentId" = d."id"
      WHERE dc."embedding" IS NOT NULL
        AND 1 - (dc."embedding" <=> $1::vector) > $2
        ${namespaceClause}
        ${documentFilterClause}
      ORDER BY dc."embedding" <=> $1::vector
      LIMIT $3`,
      params,
    );

    return result.rows.map((row) => ({
      id: row.id,
      content: row.content,
      namespace: row.namespace,
      chunkIndex: row.chunkIndex,
      similarity: row.similarity,
      tokenCount: row.tokenCount,
      metadata: row.metadata,
      document: {
        id: row.documentId,
        title: row.documentTitle,
        sourceUri: row.documentSourceUri,
        sourceType: row.documentSourceType,
        mimeType: row.documentMimeType,
      },
    }));
  };

  const getNamespaceStats = async (): Promise<NamespaceStats[]> => {
    const result = await db.query<{
      namespace: string;
      documentCount: string;
      chunkCount: string;
      lastUpdated: Date | null;
    }>(
      `SELECT 
        d."namespace",
        COUNT(DISTINCT d."id") as "documentCount",
        COUNT(dc."id") as "chunkCount",
        MAX(d."updatedAt") as "lastUpdated"
      FROM "documents" d
      LEFT JOIN "document_chunks" dc ON d."id" = dc."documentId"
      GROUP BY d."namespace"
      ORDER BY d."namespace"`,
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
    node: Omit<NewKnowledgeNode, "id"> & { id?: string }
  ): Promise<KnowledgeNode> => {
    // Use raw SQL for vector embedding support
    const embeddingStr = node.embedding ? `[${node.embedding.join(",")}]` : null;
    
    const result = await db.query<KnowledgeNode>(
      `INSERT INTO "nodes" (
        "namespace", "type", "name", "embedding", "content", "data", 
        "source_type", "source_id", "created_at", "updated_at"
      ) VALUES (
        $1, $2, $3, $4::vector, $5, $6, $7, $8, NOW(), NOW()
      ) RETURNING *`,
      [
        node.namespace,
        node.type,
        node.name,
        embeddingStr,
        node.content ?? null,
        node.data ?? {},
        node.sourceType ?? null,
        node.sourceId ?? null,
      ]
    );
    return result.rows[0];
  };

  const createNodes = async (
    nodes: Array<Omit<NewKnowledgeNode, "id"> & { id?: string }>
  ): Promise<KnowledgeNode[]> => {
    if (nodes.length === 0) return [];
    
    const created: KnowledgeNode[] = [];
    for (const node of nodes) {
      const result = await createNode(node);
      created.push(result);
    }
    return created;
  };

  const getNodeById = async (id: string): Promise<KnowledgeNode | undefined> => {
    const result = await db.query<KnowledgeNode>(
      `SELECT * FROM "nodes" WHERE "id" = $1`,
      [id]
    );
    return result.rows[0];
  };

  const getNodesByNamespace = async (
    namespace: string,
    type?: string
  ): Promise<KnowledgeNode[]> => {
    if (type) {
      const result = await db.query<KnowledgeNode>(
        `SELECT * FROM "nodes" WHERE "namespace" = $1 AND "type" = $2 ORDER BY "created_at" DESC`,
        [namespace, type]
      );
      return result.rows;
    }
    const result = await db.query<KnowledgeNode>(
      `SELECT * FROM "nodes" WHERE "namespace" = $1 ORDER BY "created_at" DESC`,
      [namespace]
    );
    return result.rows;
  };

  const updateNode = async (
    id: string,
    updates: Partial<NewKnowledgeNode>
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
      params.push(updates.embedding ? `[${updates.embedding.join(",")}]` : null);
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
      `UPDATE "nodes" SET ${setClauses.join(", ")} WHERE "id" = $${paramIdx} RETURNING *`,
      params
    );
    return result.rows[0];
  };

  const deleteNode = async (id: string): Promise<void> => {
    await db.query(`DELETE FROM "nodes" WHERE "id" = $1`, [id]);
  };

  const deleteNodesBySource = async (
    sourceType: string,
    sourceId: string
  ): Promise<void> => {
    await db.query(
      `DELETE FROM "nodes" WHERE "source_type" = $1 AND "source_id" = $2`,
      [sourceType, sourceId]
    );
  };

  const createEdge = async (
    edge: Omit<NewKnowledgeEdge, "id"> & { id?: string }
  ): Promise<KnowledgeEdge> => {
    const result = await db.query<KnowledgeEdge>(
      `INSERT INTO "edges" (
        "source_node_id", "target_node_id", "type", "data", "weight", "created_at"
      ) VALUES (
        $1, $2, $3, $4, $5, NOW()
      ) RETURNING *`,
      [
        edge.sourceNodeId,
        edge.targetNodeId,
        edge.type,
        edge.data ?? {},
        edge.weight ?? 1.0,
      ]
    );
    return result.rows[0];
  };

  const createEdges = async (
    edges: Array<Omit<NewKnowledgeEdge, "id"> & { id?: string }>
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
    types?: string[]
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
    
    const result = await db.query<EdgeRow>(
      `SELECT * FROM "edges" WHERE ${whereClause} ORDER BY "created_at" DESC`,
      params
    );
    
    // Convert snake_case to camelCase
    return result.rows.map(row => ({
      id: row.id,
      sourceNodeId: row.source_node_id,
      targetNodeId: row.target_node_id,
      type: row.type,
      data: row.data,
      weight: row.weight,
      createdAt: row.created_at,
    }));
  };

  const deleteEdge = async (id: string): Promise<void> => {
    await db.query(`DELETE FROM "edges" WHERE "id" = $1`, [id]);
  };

  const deleteEdgesForNode = async (nodeId: string): Promise<void> => {
    await db.query(
      `DELETE FROM "edges" WHERE "source_node_id" = $1 OR "target_node_id" = $1`,
      [nodeId]
    );
  };

  const searchNodes = async (
    options: GraphQueryOptions
  ): Promise<GraphQueryResult[]> => {
    const { 
      embedding, 
      namespaces, 
      nodeTypes, 
      limit = 10, 
      minSimilarity = 0.5 
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
      params
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
    maxDepth: number = 2
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
        [frontier]
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
        
        if (!allEdges.some(e => e.id === edge.id)) {
          allEdges.push(edge);
        }
        // Add connected nodes to next frontier
        if (!visited.has(edge.sourceNodeId)) nextFrontier.add(edge.sourceNodeId);
        if (!visited.has(edge.targetNodeId)) nextFrontier.add(edge.targetNodeId);
      }

      frontier = Array.from(nextFrontier);
    }

    return { nodes: allNodes, edges: allEdges };
  };

  const findRelatedNodes = async (
    nodeId: string,
    depth: number = 1
  ): Promise<KnowledgeNode[]> => {
    const result = await traverseGraph(nodeId, undefined, depth);
    // Exclude the starting node
    return result.nodes.filter(n => n.id !== nodeId);
  };

  return {
    crud,
    addToQueue,
    getProcessingQueueItem,
    getNextPendingQueueItem,
    updateQueueItemStatus,
    getMessageHistory,
    getThreadsForParticipant,
    getMessagesForThread,
    getThreadById,
    getThreadByExternalId,
    findOrCreateThread,
    createMessage,
    getTaskById,
    createTask,
    getUserByExternalId,
    archiveThread,
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
}
