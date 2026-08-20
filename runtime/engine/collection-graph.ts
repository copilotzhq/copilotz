import type { CollectionRecord } from "../collections/index.ts";
import type { ContentSequence } from "../content/index.ts";
import type {
  ConversationMessage,
  ConversationThread,
  LlmAttempt,
  Participant,
  ToolExecution,
} from "../domain/index.ts";
import type { CopilotzProcessorCapabilities } from "./types.ts";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return Object.freeze([]);
  return Object.freeze(
    value.filter((item): item is string =>
      typeof item === "string" && Boolean(item.trim())
    ),
  );
}

function contentSequence(value: unknown): ContentSequence {
  if (!Array.isArray(value)) return Object.freeze([]);
  return Object.freeze(value) as ContentSequence;
}

export function projectActiveBranch<T extends { id: string }>(
  messages: readonly T[],
  branch: ConversationThread["activeMessageBranch"],
): readonly T[] {
  if (!branch) return messages;
  const rootIndex = messages.findIndex((message) =>
    message.id === branch.rootMessageId
  );
  const headIndex = messages.findIndex((message) =>
    message.id === branch.headMessageId
  );
  if (rootIndex < 0 || headIndex <= rootIndex) return messages;
  return Object.freeze([
    ...messages.slice(0, rootIndex),
    messages[headIndex],
    ...messages.slice(headIndex + 1),
  ]);
}

export function requireScopedCollection(
  context: CopilotzProcessorCapabilities,
  name: string,
) {
  const bound = context.collections[name];
  if (!bound) throw new Error(`Collection '${name}' is not bound.`);
  return bound;
}

export function mapParticipantRecord(record: CollectionRecord): Participant {
  return Object.freeze({
    id: String(record.id),
    namespace: String(record.namespace),
    externalId: String(record.externalId ?? record.id),
    participantType: record.participantType as Participant["participantType"],
    ...(optionalText(record.name) ? { name: optionalText(record.name) } : {}),
    ...(optionalText(record.email)
      ? { email: optionalText(record.email) }
      : {}),
    ...(optionalText(record.agentId)
      ? { agentId: optionalText(record.agentId) }
      : {}),
    metadata: asRecord(record.metadata),
    createdAt: String(record.createdAt),
    updatedAt: String(record.updatedAt),
  });
}

export function mapMessageRecord(
  record: CollectionRecord,
  sender: Participant,
): ConversationMessage {
  return Object.freeze({
    id: String(record.id),
    namespace: String(record.namespace),
    threadId: String(record.threadId),
    sender,
    recipientIds: stringArray(record.recipientIds),
    content: contentSequence(record.content),
    metadata: asRecord(record.metadata),
    ...(record.revision && typeof record.revision === "object"
      ? { revision: record.revision as ConversationMessage["revision"] }
      : {}),
    createdAt: String(record.createdAt),
    updatedAt: String(record.updatedAt),
  });
}

export function mapThreadRecord(
  record: CollectionRecord,
  participants: readonly Participant[],
): ConversationThread {
  return Object.freeze({
    id: String(record.id),
    namespace: String(record.namespace),
    ...(optionalText(record.externalId)
      ? { externalId: optionalText(record.externalId) }
      : {}),
    ...(optionalText(record.name) ? { name: optionalText(record.name) } : {}),
    ...(optionalText(record.description)
      ? { description: optionalText(record.description) }
      : {}),
    status: String(record.status ?? "active"),
    ...(optionalText(record.parentThreadId)
      ? { parentThreadId: optionalText(record.parentThreadId) }
      : {}),
    metadata: asRecord(record.metadata),
    participants,
    ...(record.activeMessageBranch &&
        typeof record.activeMessageBranch === "object"
      ? {
        activeMessageBranch: record
          .activeMessageBranch as ConversationThread["activeMessageBranch"],
      }
      : {}),
    ...(optionalText(record.lastEventId)
      ? { lastEventId: optionalText(record.lastEventId) }
      : {}),
    ...(optionalText(record.lastEventPosition)
      ? { lastEventPosition: optionalText(record.lastEventPosition) }
      : {}),
    ...(optionalText(record.lastEventAt)
      ? { lastEventAt: optionalText(record.lastEventAt) }
      : {}),
    createdAt: String(record.createdAt),
    updatedAt: String(record.updatedAt),
  });
}

export function mapLlmAttemptRecord(record: CollectionRecord): LlmAttempt {
  return Object.freeze({
    id: String(record.id),
    namespace: String(record.namespace),
    threadId: String(record.threadId),
    ...(optionalText(record.messageId)
      ? { messageId: optionalText(record.messageId) }
      : {}),
    ...(optionalText(record.participantId)
      ? { participantId: optionalText(record.participantId) }
      : {}),
    ...(optionalText(record.initiatorParticipantId)
      ? { initiatorParticipantId: optionalText(record.initiatorParticipantId) }
      : {}),
    ...(optionalText(record.agentId)
      ? { agentId: optionalText(record.agentId) }
      : {}),
    ...(optionalText(record.provider)
      ? { provider: optionalText(record.provider) }
      : {}),
    ...(optionalText(record.model)
      ? { model: optionalText(record.model) }
      : {}),
    status: record.status as LlmAttempt["status"],
    attemptIndex: Number(record.attemptIndex ?? 0),
    ...(optionalText(record.parentAttemptId)
      ? { parentAttemptId: optionalText(record.parentAttemptId) }
      : {}),
    inputMessageIds: stringArray(record.inputMessageIds),
    availableToolIds: stringArray(record.availableToolIds),
    content: contentSequence(record.content),
    ...(optionalText(record.finishReason)
      ? { finishReason: optionalText(record.finishReason) }
      : {}),
    ...(record.usage && typeof record.usage === "object"
      ? { usage: record.usage as Record<string, unknown> }
      : {}),
    ...(record.cost && typeof record.cost === "object"
      ? { cost: record.cost as Record<string, unknown> }
      : {}),
    ...(record.safeError && typeof record.safeError === "object"
      ? { safeError: record.safeError as LlmAttempt["safeError"] }
      : {}),
    startedAt: String(record.startedAt ?? record.createdAt),
    ...(optionalText(record.finishedAt)
      ? { finishedAt: optionalText(record.finishedAt) }
      : {}),
    metadata: asRecord(record.metadata),
    createdAt: String(record.createdAt),
    updatedAt: String(record.updatedAt),
  });
}

export function mapToolExecutionRecord(
  record: CollectionRecord,
): ToolExecution {
  return Object.freeze({
    id: String(record.id),
    namespace: String(record.namespace),
    threadId: String(record.threadId),
    ...(optionalText(record.messageId)
      ? { messageId: optionalText(record.messageId) }
      : {}),
    ...(optionalText(record.participantId)
      ? { participantId: optionalText(record.participantId) }
      : {}),
    ...(optionalText(record.agentId)
      ? { agentId: optionalText(record.agentId) }
      : {}),
    toolCallId: String(record.toolCallId),
    tool: asRecord(record.tool),
    status: record.status as ToolExecution["status"],
    content: contentSequence(record.content),
    ...(optionalText(record.historyVisibility)
      ? { historyVisibility: optionalText(record.historyVisibility) }
      : {}),
    ...(record.safeError && typeof record.safeError === "object"
      ? { safeError: record.safeError as ToolExecution["safeError"] }
      : {}),
    startedAt: String(record.startedAt ?? record.createdAt),
    ...(optionalText(record.finishedAt)
      ? { finishedAt: optionalText(record.finishedAt) }
      : {}),
    ...(typeof record.durationMs === "number"
      ? { durationMs: record.durationMs }
      : {}),
    metadata: asRecord(record.metadata),
    createdAt: String(record.createdAt),
    updatedAt: String(record.updatedAt),
  });
}

export async function loadParticipantRecord(
  context: CopilotzProcessorCapabilities,
  id: string,
): Promise<Participant | null> {
  const bound = context.collections.participant;
  if (!bound) return null;
  const record = await bound.get({ id });
  return record ? mapParticipantRecord(record) : null;
}

export async function loadThreadRecord(
  context: CopilotzProcessorCapabilities,
  threadId: string,
): Promise<ConversationThread | null> {
  const threads = context.collections.thread;
  const participants = context.collections.participant;
  if (!threads || !participants) return null;
  const record = await threads.get({ id: threadId });
  if (!record) return null;
  const ids = stringArray(record.participantIds);
  const loaded = await Promise.all(
    ids.map((id) => participants.get({ id })),
  );
  return mapThreadRecord(
    record,
    loaded.filter((item): item is CollectionRecord => item !== null).map(
      mapParticipantRecord,
    ),
  );
}

export async function listThreadMessageRecords(
  context: CopilotzProcessorCapabilities,
  threadId: string,
): Promise<readonly ConversationMessage[]> {
  const messages = requireScopedCollection(context, "message");
  const participants = requireScopedCollection(context, "participant");
  const thread = await loadThreadRecord(context, threadId);
  const records = await messages.list({
    where: { threadId },
    order: { field: "createdAt", direction: "asc" },
    limit: 1_000,
  });
  const hydrated: ConversationMessage[] = [];
  for (const record of records) {
    const sender = await participants.get({ id: String(record.senderId) });
    if (!sender) {
      throw new Error(`Message '${record.id}' sender was not found.`);
    }
    hydrated.push(mapMessageRecord(record, mapParticipantRecord(sender)));
  }
  return projectActiveBranch(hydrated, thread?.activeMessageBranch);
}

export async function loadMessageRecord(
  context: CopilotzProcessorCapabilities,
  id: string,
): Promise<ConversationMessage | null> {
  const record = await requireScopedCollection(context, "message").get({ id });
  if (!record) return null;
  const sender = await requireScopedCollection(context, "participant").get({
    id: String(record.senderId),
  });
  if (!sender) {
    throw new Error(`Message '${id}' sender was not found.`);
  }
  return mapMessageRecord(record, mapParticipantRecord(sender));
}

export async function loadLlmAttemptRecord(
  context: CopilotzProcessorCapabilities,
  id: string,
): Promise<LlmAttempt | null> {
  const record = await requireScopedCollection(context, "llm_attempt").get({
    id,
  });
  return record ? mapLlmAttemptRecord(record) : null;
}

export async function loadToolExecutionRecord(
  context: CopilotzProcessorCapabilities,
  id: string,
): Promise<ToolExecution | null> {
  const record = await requireScopedCollection(context, "tool_execution").get({
    id,
  });
  return record ? mapToolExecutionRecord(record) : null;
}
