import type { KnowledgeNode } from "@/database/schemas/index.ts";
import type { CopilotzDb, Message } from "@/types/index.ts";

export type LongTermMemoryStatus = "pending" | "ready" | "failed";

export interface LongTermMemoryData {
  schemaVersion: "1";
  strategy: string;
  status: LongTermMemoryStatus;
  threadId: string;
  memorySpaceId: string;
  sequence: number;
  agentId: string;
  sourceStartMessageId: string;
  sourceEndMessageId: string;
  contentHash?: string | null;
  tokenEstimate?: number | null;
  error?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
}

export interface LongTermMemoryRecord {
  node: KnowledgeNode;
  data: LongTermMemoryData;
}

export interface LongTermMemoryRange {
  messages: Message[];
  characterCount: number;
  retainedCharacterCount: number;
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
  if (
    data.schemaVersion !== "1" ||
    typeof data.strategy !== "string" ||
    (status !== "pending" && status !== "ready" && status !== "failed") ||
    typeof data.threadId !== "string" ||
    typeof data.memorySpaceId !== "string" ||
    typeof data.sequence !== "number" ||
    typeof data.agentId !== "string" ||
    typeof data.sourceStartMessageId !== "string" ||
    typeof data.sourceEndMessageId !== "string"
  ) {
    return null;
  }
  return data as unknown as LongTermMemoryData;
}

async function findLongTermMemory(
  db: CopilotzDb,
  threadId: string,
  namespace: string,
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
     ORDER BY (("data"->>'sequence')::bigint) DESC, "created_at" DESC, "id" DESC
     LIMIT 1`,
    [namespace, threadId, status],
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
): Promise<LongTermMemoryRecord | null> {
  return await findLongTermMemory(db, threadId, namespace, "ready");
}

export async function getPendingLongTermMemory(
  db: CopilotzDb,
  threadId: string,
  namespace: string,
): Promise<LongTermMemoryRecord | null> {
  return await findLongTermMemory(db, threadId, namespace, "pending");
}

export async function getNextLongTermMemorySequence(
  db: CopilotzDb,
  threadId: string,
  namespace: string,
): Promise<number> {
  const result = await db.query<{ sequence: number | string | null }>(
    `SELECT MAX((NULLIF("data"->>'sequence', ''))::bigint) AS "sequence"
     FROM "nodes"
     WHERE "namespace" = $1
       AND "type" = 'long_term_memory'
       AND "source_type" = 'thread'
       AND "source_id" = $2`,
    [namespace, threadId],
  );
  const current = Number(result.rows[0]?.sequence ?? 0);
  return Number.isFinite(current) ? current + 1 : 1;
}

export async function findMemorySpace(
  db: CopilotzDb,
  threadId: string,
  namespace: string,
): Promise<KnowledgeNode | null> {
  const result = await db.query<Record<string, unknown>>(
    `SELECT *
     FROM "nodes"
     WHERE "namespace" = $1
       AND "type" = 'memory_space'
       AND "source_type" = 'thread'
       AND "source_id" = $2
     ORDER BY "created_at" ASC, "id" ASC
     LIMIT 1`,
    [namespace, threadId],
  );
  return result.rows[0] ? mapNodeRow(result.rows[0]) : null;
}

function stringifyToolOutput(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value ?? "");
  }
}

export function projectMessageForSharedMemory(
  message: Message,
  maxToolResultChars = 10_000,
): string {
  const metadata = isRecord(message.metadata) ? message.metadata : {};
  if (
    metadata.visibility === "requester_only" ||
    metadata.visibility === "private"
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
      const capped = maxToolResultChars > 0
        ? output.slice(0, maxToolResultChars)
        : output;
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
  if (!content) return "";
  return `[${message.senderType}:${message.senderId}] ${content}`;
}

export async function selectLongTermMemoryRange(args: {
  db: CopilotzDb;
  threadId: string;
  triggerMessageId: string;
  previous: LongTermMemoryRecord | null;
  triggerChars: number;
  retainRecentChars?: number;
  maxToolResultChars?: number;
  pageSize?: number;
}): Promise<LongTermMemoryRange | null> {
  const {
    db,
    threadId,
    triggerMessageId,
    previous,
    triggerChars,
    retainRecentChars = 0,
    maxToolResultChars,
    pageSize = 100,
  } = args;
  const selectedNewestFirst: Message[] = [];
  let characterCount = 0;
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
      characterCount += projectMessageForSharedMemory(
        message,
        maxToolResultChars,
      ).length;
      if (!previous && characterCount >= triggerChars) break;
    }

    if (
      (previous && foundPreviousBoundary) ||
      (!previous && characterCount >= triggerChars) ||
      !page.pageInfo.hasMoreBefore
    ) {
      break;
    }
    before = page.pageInfo.oldestMessageId;
  }

  if (
    !reachedTriggerMessage ||
    (previous && !foundPreviousBoundary) ||
    characterCount < triggerChars ||
    selectedNewestFirst.length === 0
  ) {
    return null;
  }

  const selectedMessages = selectedNewestFirst.reverse();
  let retainedCharacterCount = 0;
  let retainedMessageCount = 0;

  if (retainRecentChars > 0) {
    for (
      let index = selectedMessages.length - 1;
      index >= 0 && retainedCharacterCount < retainRecentChars;
      index--
    ) {
      retainedCharacterCount += projectMessageForSharedMemory(
        selectedMessages[index],
        maxToolResultChars,
      ).length;
      retainedMessageCount++;
    }
  }

  const messages = retainedMessageCount > 0
    ? selectedMessages.slice(0, -retainedMessageCount)
    : selectedMessages;
  if (messages.length === 0) return null;

  return {
    messages,
    characterCount,
    retainedCharacterCount,
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
