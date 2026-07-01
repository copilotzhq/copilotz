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

type ProjectableMessage = Omit<Message, "id"> & { id?: string };

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

function mapMessageNode(row: Record<string, unknown>): Message {
  const node = mapNodeRow(row);
  const data = isRecord(node.data) ? node.data : {};
  return {
    id: String(data.messageId ?? node.id),
    threadId: String(data.threadId ?? node.sourceId ?? ""),
    senderId: String(data.senderId ?? ""),
    senderType: data.senderType as Message["senderType"],
    senderUserId: typeof data.senderUserId === "string"
      ? data.senderUserId
      : null,
    externalId: typeof data.externalId === "string" ? data.externalId : null,
    content: typeof node.content === "string"
      ? node.content
      : typeof data.content === "string"
      ? data.content
      : "",
    toolCallId: typeof data.toolCallId === "string" ? data.toolCallId : null,
    toolCalls: Array.isArray(data.toolCalls) ? data.toolCalls : null,
    reasoning: typeof data.reasoning === "string" ? data.reasoning : null,
    metadata: isRecord(data.metadata) ? data.metadata : null,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
  };
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

function stringifyToolOutput(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value ?? "");
  }
}

function stringifyToolArgs(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return String(value ?? "");
  }
}

export function projectMessageForSharedMemory(
  message: ProjectableMessage,
  maxToolResultEstimatedTokens = 2_500,
): string {
  const metadata = isRecord(message.metadata) ? message.metadata : {};
  if (
    metadata.visibility === "private" ||
    metadata.visibility === "requester_only"
  ) {
    return "";
  }

  if (message.senderType === "tool") {
    const calls = Array.isArray(metadata.toolCalls) ? metadata.toolCalls : [];
    const projected = calls.flatMap((call): string[] => {
      if (!isRecord(call)) return [];
      const visibility = call.visibility === "public"
        ? "public"
        : call.visibility === "requester_only"
        ? "requester_only"
        : "public_status";
      if (visibility === "requester_only") return [];
      const tool = isRecord(call.tool) ? call.tool : {};
      const name = String(tool.name ?? tool.id ?? "tool");
      const status = typeof call.status === "string"
        ? call.status
        : "completed";
      if (visibility === "public_status") {
        return [`[Tool ${name}: ${status}]`];
      }
      const output = stringifyToolOutput(call.output ?? call.error ?? "");
      let capped = output;
      if (
        maxToolResultEstimatedTokens > 0 &&
        estimateTextTokens(capped) > maxToolResultEstimatedTokens
      ) {
        let length = Math.min(
          capped.length,
          maxToolResultEstimatedTokens * 4,
        );
        while (
          length > 0 &&
          estimateTextTokens(capped.slice(0, length)) >
            maxToolResultEstimatedTokens
        ) {
          length = Math.floor(length * 0.88);
        }
        capped = capped.slice(0, length);
      }
      return [`[Tool ${name}: ${status}] ${capped}`.trim()];
    });
    return projected.join("\n");
  }

  if (
    message.senderType !== "user" &&
    message.senderType !== "agent" &&
    message.senderType !== "job"
  ) {
    return "";
  }

  const content = typeof message.content === "string"
    ? message.content.trim()
    : "";
  const toolCalls = message.senderType === "agent" &&
      Array.isArray(message.toolCalls)
    ? message.toolCalls.flatMap((call): string[] => {
      if (!isRecord(call) || call.visibility === "requester_only") return [];
      const tool = isRecord(call.tool) ? call.tool : {};
      const name = String(tool.name ?? tool.id ?? "tool");
      return [`[Tool call ${name}] ${stringifyToolArgs(call.args)}`.trim()];
    })
    : [];
  return [
    content ? `[${message.senderType}:${message.senderId}] ${content}` : "",
    ...toolCalls,
  ].filter(Boolean).join("\n");
}

export async function selectLongTermMemoryRange(args: {
  db: CopilotzDb;
  threadId: string;
  triggerMessageId: string;
  previous: LongTermMemoryRecord | null;
  triggerEstimatedTokens: number;
  retainRecentEstimatedTokens?: number;
  maxToolResultEstimatedTokens?: number;
  pageSize?: number;
}): Promise<LongTermMemoryRange | null> {
  const {
    db,
    threadId,
    triggerMessageId,
    previous,
    triggerEstimatedTokens,
    retainRecentEstimatedTokens = 0,
    maxToolResultEstimatedTokens,
    pageSize = 100,
  } = args;
  const selectedNewestFirst: Message[] = [];
  let estimatedTokens = 0;
  let before: string | null = null;
  let foundPreviousBoundary = previous === null;
  let reachedTriggerMessage = false;

  while (true) {
    const page = await db.ops.getMessageHistoryPageFromGraph(threadId, {
      limit: pageSize,
      before,
    });
    if (page.data.length === 0) break;

    for (let index = page.data.length - 1; index >= 0; index--) {
      const message = page.data[index];
      if (!reachedTriggerMessage) {
        if (message.id !== triggerMessageId) continue;
        reachedTriggerMessage = true;
      }
      if (
        previous &&
        message.id === previous.data.sourceEndMessageId
      ) {
        foundPreviousBoundary = true;
        break;
      }
      selectedNewestFirst.push(message);
      estimatedTokens += estimateTextTokens(
        projectMessageForSharedMemory(message, maxToolResultEstimatedTokens),
      );
      if (!previous && estimatedTokens >= triggerEstimatedTokens) break;
    }

    if (
      (previous && foundPreviousBoundary) ||
      (!previous && estimatedTokens >= triggerEstimatedTokens) ||
      !page.pageInfo.hasMoreBefore
    ) {
      break;
    }
    before = page.pageInfo.oldestMessageId;
  }

  if (
    !reachedTriggerMessage ||
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
        (sum, message) =>
          sum +
          estimateTextTokens(
            projectMessageForSharedMemory(
              message,
              maxToolResultEstimatedTokens,
            ),
          ),
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

export async function loadMessagesInLongTermMemoryRange(
  db: CopilotzDb,
  threadId: string,
  sourceStartMessageId: string,
  sourceEndMessageId: string,
): Promise<Message[]> {
  const result = await db.query<Record<string, unknown>>(
    `WITH start_boundary AS (
       SELECT "created_at", "id"
       FROM "nodes"
       WHERE "type" = 'message'
         AND "source_type" = 'thread'
         AND "source_id" = $1
         AND COALESCE("data"->>'messageId', "id") = $2
       LIMIT 1
     ),
     end_boundary AS (
       SELECT "created_at", "id"
       FROM "nodes"
       WHERE "type" = 'message'
         AND "source_type" = 'thread'
         AND "source_id" = $1
         AND COALESCE("data"->>'messageId', "id") = $3
       LIMIT 1
     )
     SELECT n.*
     FROM "nodes" n, start_boundary s, end_boundary e
     WHERE n."type" = 'message'
       AND n."source_type" = 'thread'
       AND n."source_id" = $1
       AND (
         n."created_at" > s."created_at"
         OR (n."created_at" = s."created_at" AND n."id" >= s."id")
       )
       AND (
         n."created_at" < e."created_at"
         OR (n."created_at" = e."created_at" AND n."id" <= e."id")
       )
     ORDER BY n."created_at" ASC, n."id" ASC`,
    [threadId, sourceStartMessageId, sourceEndMessageId],
  );
  return result.rows.map(mapMessageNode);
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
