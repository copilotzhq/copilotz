import type { KnowledgeNode } from "@/database/schemas/index.ts";
import type { CopilotzDb, Message } from "@/types/index.ts";
import { estimateTextTokens } from "@/runtime/tokens/index.ts";
import { GRAPH_EDGE } from "@/runtime/graph/edges.ts";

export type LongTermMemoryStatus = "pending" | "ready" | "failed";

interface LongTermMemoryDataBase {
  schemaVersion: "1" | "2";
  strategy: string;
  status: LongTermMemoryStatus;
  threadId: string;
  sequence: number;
  agentId: string;
  sourceStartMessageId: string;
  sourceEndMessageId: string;
  contentHash?: string | null;
  tokenEstimate?: number | null;
  error?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
}

export interface LongTermMemoryDataV1 extends LongTermMemoryDataBase {
  schemaVersion: "1";
  memorySpaceId: string;
}

export interface LongTermMemoryDataV2 extends LongTermMemoryDataBase {
  schemaVersion: "2";
  readMemorySpaceIds: string[];
  writeMemorySpaceIds: string[];
  defaultWriteMemorySpaceId: string;
}

export type LongTermMemoryData =
  | LongTermMemoryDataV1
  | LongTermMemoryDataV2;

export interface LongTermMemoryRecord {
  node: KnowledgeNode;
  data: LongTermMemoryData;
}

export type MemorySpaceAccessMode = "read" | "read_write";

export interface ThreadMemorySpaceAccess {
  node: KnowledgeNode;
  access: MemorySpaceAccessMode;
  defaultWrite: boolean;
  edgeId: string | null;
}

export interface LongTermMemoryRange {
  messages: Message[];
  estimatedTokens: number;
  retainedEstimatedTokens: number;
  retainedMessageCount: number;
  sourceStartMessageId: string;
  sourceEndMessageId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mapNodeRow(row: Record<string, unknown>): KnowledgeNode {
  return {
    id: String(row.id),
    namespace: String(row.namespace),
    type: String(row.type),
    name: typeof row.name === "string" ? row.name : "",
    content: typeof row.content === "string" ? row.content : null,
    embedding: Array.isArray(row.embedding) ? row.embedding as number[] : null,
    data: isRecord(row.data) ? row.data : {},
    sourceType: typeof row.source_type === "string"
      ? row.source_type
      : typeof row.sourceType === "string"
      ? row.sourceType
      : null,
    sourceId: typeof row.source_id === "string"
      ? row.source_id
      : typeof row.sourceId === "string"
      ? row.sourceId
      : null,
    createdAt: (row.created_at ?? row.createdAt) as Date | string,
    updatedAt: (row.updated_at ?? row.updatedAt) as Date | string,
  } as KnowledgeNode;
}

export function getLongTermMemoryData(
  node: KnowledgeNode | undefined | null,
): LongTermMemoryData | null {
  if (!node || node.type !== "long_term_memory" || !isRecord(node.data)) {
    return null;
  }
  const data = node.data;
  const status = data.status;
  const schemaVersion = data.schemaVersion;
  if (
    (schemaVersion !== "1" && schemaVersion !== "2") ||
    typeof data.strategy !== "string" ||
    (status !== "pending" && status !== "ready" && status !== "failed") ||
    typeof data.threadId !== "string" ||
    typeof data.sequence !== "number" ||
    typeof data.agentId !== "string" ||
    typeof data.sourceStartMessageId !== "string" ||
    typeof data.sourceEndMessageId !== "string"
  ) {
    return null;
  }
  if (schemaVersion === "1" && typeof data.memorySpaceId !== "string") {
    return null;
  }
  const readMemorySpaceIds = isStringArray(data.readMemorySpaceIds)
    ? data.readMemorySpaceIds
    : null;
  const writeMemorySpaceIds = isStringArray(data.writeMemorySpaceIds)
    ? data.writeMemorySpaceIds
    : null;
  if (
    schemaVersion === "2" &&
    (
      !readMemorySpaceIds ||
      !writeMemorySpaceIds ||
      readMemorySpaceIds.length === 0 ||
      writeMemorySpaceIds.length === 0 ||
      !writeMemorySpaceIds.every((id) => readMemorySpaceIds.includes(id)) ||
      typeof data.defaultWriteMemorySpaceId !== "string" ||
      !writeMemorySpaceIds.includes(data.defaultWriteMemorySpaceId)
    )
  ) {
    return null;
  }
  return data as unknown as LongTermMemoryData;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) &&
    value.every((entry) => typeof entry === "string" && entry.length > 0);
}

async function findLongTermMemory(
  db: CopilotzDb,
  threadId: string,
  namespace: string,
  agentId: string,
  status: LongTermMemoryStatus,
): Promise<LongTermMemoryRecord | null> {
  const result = await db.query<Record<string, unknown>>(
    `SELECT *
     FROM "nodes"
     WHERE "namespace" = $1
       AND "type" = 'long_term_memory'
       AND "source_type" = 'thread'
       AND "source_id" = $2
       AND "data"->>'status' = $3
       AND "data"->>'agentId' = $4
     ORDER BY (("data"->>'sequence')::bigint) DESC, "created_at" DESC, "id" DESC
     LIMIT 1`,
    [namespace, threadId, status, agentId],
  );
  const row = result.rows[0];
  if (!row) return null;
  const node = mapNodeRow(row);
  const data = getLongTermMemoryData(node);
  return data ? { node, data } : null;
}

export async function getLatestReadyLongTermMemory(
  db: CopilotzDb,
  threadId: string,
  namespace: string,
  agentId: string,
): Promise<LongTermMemoryRecord | null> {
  return await findLongTermMemory(db, threadId, namespace, agentId, "ready");
}

export async function getPendingLongTermMemory(
  db: CopilotzDb,
  threadId: string,
  namespace: string,
  agentId: string,
): Promise<LongTermMemoryRecord | null> {
  return await findLongTermMemory(db, threadId, namespace, agentId, "pending");
}

export async function getNextLongTermMemorySequence(
  db: CopilotzDb,
  threadId: string,
  namespace: string,
  agentId: string,
): Promise<number> {
  const result = await db.query<{ sequence: number | string | null }>(
    `SELECT MAX((NULLIF("data"->>'sequence', ''))::bigint) AS "sequence"
     FROM "nodes"
     WHERE "namespace" = $1
       AND "type" = 'long_term_memory'
       AND "source_type" = 'thread'
       AND "source_id" = $2
       AND "data"->>'agentId' = $3`,
    [namespace, threadId, agentId],
  );
  const current = Number(result.rows[0]?.sequence ?? 0);
  return Number.isFinite(current) ? current + 1 : 1;
}

export async function findMemorySpace(
  db: CopilotzDb,
  threadId: string,
  namespace: string,
): Promise<KnowledgeNode | null> {
  const spaces = await resolveThreadMemorySpaces(db, threadId, namespace);
  return spaces.find((space) => space.defaultWrite)?.node ??
    spaces.find((space) => space.access === "read_write")?.node ??
    spaces[0]?.node ??
    null;
}

export async function resolveThreadMemorySpaces(
  db: CopilotzDb,
  threadId: string,
  namespace: string,
): Promise<ThreadMemorySpaceAccess[]> {
  const result = await db.query<Record<string, unknown>>(
    `SELECT n.*, e."id" AS "edge_id", e."type" AS "edge_type",
            e."data" AS "edge_data", e."created_at" AS "edge_created_at"
     FROM "edges" e
     JOIN "nodes" n ON n."id" = e."target_node_id"
     WHERE e."source_node_id" = $1
       AND e."type" = ANY($2)
       AND n."namespace" = $3
       AND n."type" = 'memory_space'
     ORDER BY (e."type" = 'uses_memory_space') DESC,
              e."created_at" DESC, e."id" DESC`,
    [
      threadId,
      [GRAPH_EDGE.USES_MEMORY_SPACE, GRAPH_EDGE.OWNS_MEMORY_SPACE],
      namespace,
    ],
  );

  const bySpaceId = new Map<string, ThreadMemorySpaceAccess>();
  for (const row of result.rows) {
    const node = mapNodeRow(row);
    const id = String(node.id);
    const edgeType = typeof row.edge_type === "string" ? row.edge_type : "";
    const edgeData = isRecord(row.edge_data) ? row.edge_data : {};
    const access: MemorySpaceAccessMode = edgeType ===
          GRAPH_EDGE.OWNS_MEMORY_SPACE ||
        edgeData.access === "read_write"
      ? "read_write"
      : "read";
    const candidate: ThreadMemorySpaceAccess = {
      node,
      access,
      defaultWrite: access === "read_write" &&
        (edgeType === GRAPH_EDGE.OWNS_MEMORY_SPACE ||
          edgeData.defaultWrite === true),
      edgeId: typeof row.edge_id === "string" ? row.edge_id : null,
    };
    if (!bySpaceId.has(id)) {
      bySpaceId.set(id, candidate);
    }
  }

  const legacy = await db.query<Record<string, unknown>>(
    `SELECT *
     FROM "nodes"
     WHERE "namespace" = $1
       AND "type" = 'memory_space'
       AND "source_type" = 'thread'
       AND "source_id" = $2
     ORDER BY "created_at" ASC, "id" ASC`,
    [namespace, threadId],
  );
  for (const row of legacy.rows) {
    const node = mapNodeRow(row);
    if (!bySpaceId.has(String(node.id))) {
      bySpaceId.set(String(node.id), {
        node,
        access: "read_write",
        defaultWrite: bySpaceId.size === 0,
        edgeId: null,
      });
    }
  }

  const spaces = [...bySpaceId.values()];
  const explicitDefault = spaces.find((space) =>
    space.defaultWrite && space.access === "read_write"
  );
  const effectiveDefault = explicitDefault ??
    spaces.find((space) => space.access === "read_write");
  return spaces
    .map((space) => ({
      ...space,
      defaultWrite: space === effectiveDefault,
    }))
    .sort((left, right) =>
      Number(right.defaultWrite) - Number(left.defaultWrite) ||
      String(left.node.name).localeCompare(String(right.node.name)) ||
      String(left.node.id).localeCompare(String(right.node.id))
    );
}

export function getCheckpointMemorySpaceIds(
  data: LongTermMemoryData,
): {
  readMemorySpaceIds: string[];
  writeMemorySpaceIds: string[];
  defaultWriteMemorySpaceId: string;
} {
  if (data.schemaVersion === "1") {
    return {
      readMemorySpaceIds: [data.memorySpaceId],
      writeMemorySpaceIds: [data.memorySpaceId],
      defaultWriteMemorySpaceId: data.memorySpaceId,
    };
  }
  return {
    readMemorySpaceIds: [...data.readMemorySpaceIds],
    writeMemorySpaceIds: [...data.writeMemorySpaceIds],
    defaultWriteMemorySpaceId: data.defaultWriteMemorySpaceId,
  };
}

export function isLongTermMemoryAccessible(
  data: LongTermMemoryData,
  spaces: ThreadMemorySpaceAccess[],
): boolean {
  const readableIds = new Set(spaces.map((space) => String(space.node.id)));
  return getCheckpointMemorySpaceIds(data).readMemorySpaceIds.every((id) =>
    readableIds.has(id)
  );
}

function estimateRangeMessageTokens(message: Message): number {
  const metadata = isRecord(message.metadata) ? message.metadata : {};
  const parts = [
    message.senderType,
    message.senderId,
    typeof message.content === "string" ? message.content : "",
    Array.isArray(message.toolCalls) ? JSON.stringify(message.toolCalls) : "",
    Array.isArray(metadata.toolCalls) ? JSON.stringify(metadata.toolCalls) : "",
    typeof message.reasoning === "string" ? message.reasoning : "",
  ].filter((part) => part.length > 0);
  return estimateTextTokens(parts.join("\n"));
}

export async function selectLongTermMemoryRange(args: {
  messages: Message[];
  triggerMessageId: string;
  previous: LongTermMemoryRecord | null;
  triggerEstimatedTokens: number;
  retainRecentEstimatedTokens?: number;
}): Promise<LongTermMemoryRange | null> {
  const {
    messages: inputMessages,
    triggerMessageId,
    previous,
    triggerEstimatedTokens,
    retainRecentEstimatedTokens = 0,
  } = args;
  const selectedNewestFirst: Message[] = [];
  let estimatedTokens = 0;
  let foundPreviousBoundary = previous === null;
  const triggerIndex = inputMessages.findIndex((message) =>
    message.id === triggerMessageId
  );
  if (triggerIndex < 0) return null;

  for (let index = triggerIndex; index >= 0; index--) {
    const message = inputMessages[index];
    if (
      previous &&
      message.id === previous.data.sourceEndMessageId
    ) {
      foundPreviousBoundary = true;
      break;
    }
    selectedNewestFirst.push(message);
    estimatedTokens += estimateRangeMessageTokens(message);
    if (!previous && estimatedTokens >= triggerEstimatedTokens) break;
  }

  if (
    (previous && !foundPreviousBoundary) ||
    estimatedTokens < triggerEstimatedTokens ||
    selectedNewestFirst.length === 0
  ) {
    return null;
  }

  const selectedMessages = selectedNewestFirst.reverse();
  let retainedEstimatedTokens = 0;
  let retainedMessageCount = 0;

  if (retainRecentEstimatedTokens > 0) {
    const units: Message[][] = [];
    for (const message of selectedMessages) {
      if (message.senderType === "tool" && units.length > 0) {
        units[units.length - 1].push(message);
      } else {
        units.push([message]);
      }
    }
    for (
      let index = units.length - 1;
      index >= 0 && retainedEstimatedTokens < retainRecentEstimatedTokens;
      index--
    ) {
      const unit = units[index];
      retainedEstimatedTokens += unit.reduce(
        (sum, message) => sum + estimateRangeMessageTokens(message),
        0,
      );
      retainedMessageCount += unit.length;
    }
  }

  const messages = retainedMessageCount > 0
    ? selectedMessages.slice(0, -retainedMessageCount)
    : selectedMessages;
  if (messages.length === 0) return null;

  return {
    messages,
    estimatedTokens,
    retainedEstimatedTokens,
    retainedMessageCount,
    sourceStartMessageId: messages[0].id,
    sourceEndMessageId: messages.at(-1)!.id,
  };
}

export function sliceMessagesAfterLongTermMemory<
  T extends { id?: string },
>(
  messages: T[],
  memory: LongTermMemoryRecord | null,
): T[] {
  if (!memory) return messages;
  const boundaryIndex = messages.findIndex((message) =>
    message.id === memory.data.sourceEndMessageId
  );
  return boundaryIndex >= 0 ? messages.slice(boundaryIndex + 1) : messages;
}
