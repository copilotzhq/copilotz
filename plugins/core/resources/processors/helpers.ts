import type {
  CollectionRecord,
  ScopedCollection,
} from "@copilotz/copilotz/collections";
import type {
  ContentInput,
  ContentSequence,
  ResolvedContent,
} from "@copilotz/copilotz/content";
import type {
  ConversationMessage,
  ConversationThread,
  Participant,
} from "@copilotz/copilotz/domain";
import type { ProcessorContext } from "@copilotz/copilotz/plugins";
import {
  createWorkflowToolCatalog,
  type WorkflowToolCatalog,
} from "@copilotz/copilotz/tools";
import {
  type MessageBranch,
  projectActiveMessageBranch,
} from "../collections/message.ts";

const defaultToolCatalog = createWorkflowToolCatalog();

export function requiredText(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new TypeError(`${name} must be non-empty.`);
  return normalized;
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function stringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return Object.freeze([]);
  return Object.freeze(
    value.filter((item): item is string =>
      typeof item === "string" && Boolean(item.trim())
    ),
  );
}

export function requireCollection<T extends CollectionRecord>(
  context: Pick<ProcessorContext, "collections">,
  name: string,
): ScopedCollection<T> {
  const bound = context.collections[name] as ScopedCollection<T> | undefined;
  if (!bound) throw new Error(`Collection '${name}' is not bound.`);
  return bound;
}

export function collectionEventRecord(
  event: { data?: unknown },
): CollectionRecord {
  const data = asRecord(event.data);
  const record = asRecord(data.record);
  if (!record.id) throw new Error("Collection event is missing data.record.");
  return record as CollectionRecord;
}

export function mapParticipant(record: CollectionRecord): Participant {
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

export function mapMessage(
  record: CollectionRecord,
  sender: Participant,
): ConversationMessage {
  return Object.freeze({
    id: String(record.id),
    namespace: String(record.namespace),
    threadId: String(record.threadId),
    sender,
    recipientIds: stringArray(record.recipientIds),
    content:
      (Array.isArray(record.content) ? record.content : []) as ContentSequence,
    metadata: asRecord(record.metadata),
    ...(record.revision && typeof record.revision === "object"
      ? { revision: record.revision as ConversationMessage["revision"] }
      : {}),
    createdAt: String(record.createdAt),
    updatedAt: String(record.updatedAt),
  });
}

export function mapThread(
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
    status: String(record.status ?? "active"),
    metadata: asRecord(record.metadata),
    participants,
    ...(record.activeMessageBranch &&
        typeof record.activeMessageBranch === "object"
      ? {
        activeMessageBranch: record
          .activeMessageBranch as ConversationThread["activeMessageBranch"],
      }
      : {}),
    createdAt: String(record.createdAt),
    updatedAt: String(record.updatedAt),
  });
}

export function participantAgentId(participant: CollectionRecord): string {
  return optionalText(participant.agentId) ??
    String(participant.externalId ?? participant.id);
}

export function participantInput(participant: CollectionRecord) {
  return {
    id: String(participant.id),
    externalId: String(participant.externalId ?? participant.id),
    participantType: participant
      .participantType as Participant["participantType"],
    ...(optionalText(participant.name)
      ? { name: optionalText(participant.name) }
      : {}),
    ...(optionalText(participant.email)
      ? { email: optionalText(participant.email) }
      : {}),
    ...(optionalText(participant.agentId)
      ? { agentId: optionalText(participant.agentId) }
      : {}),
    metadata: structuredClone(asRecord(participant.metadata)),
  } as const;
}

export function preparedContent(
  value: { content?: unknown } | unknown,
): unknown {
  if (value && typeof value === "object" && "content" in value) {
    return (value as { content: unknown }).content;
  }
  return value;
}

export async function listThreadMessages(
  context: Pick<ProcessorContext, "collections">,
  threadId: string,
): Promise<readonly CollectionRecord[]> {
  const threads = requireCollection(context, "thread");
  const messages = requireCollection(context, "message");
  const thread = await threads.get({ id: threadId });
  const records = await messages.list({
    where: { threadId },
    order: { field: "createdAt", direction: "asc" },
    limit: 1_000,
  });
  return projectActiveMessageBranch(
    records,
    thread?.activeMessageBranch as MessageBranch | undefined,
  );
}

export function recordThreadId(record: CollectionRecord): string {
  return requiredText(optionalText(record.threadId), "thread id");
}

export function toolField(record: CollectionRecord, field: string): unknown {
  return asRecord(record.tool)[field];
}

export function historyVisibilityOf(record: CollectionRecord): string {
  return optionalText(record.historyVisibility) ?? "public_status";
}

export function toolCatalogFor(): WorkflowToolCatalog {
  return defaultToolCatalog;
}

export function parseJsonText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function resolvedValue(resolved: ResolvedContent): unknown {
  if (resolved.value !== undefined) return resolved.value;
  const text = resolved.text ?? new TextDecoder().decode(resolved.bytes);
  return resolved.ref.kind === "json" ? parseJsonText(text) : text;
}

export function valueContent(value: unknown, role: string): ContentInput {
  if (typeof value === "string") return { type: "text", text: value, role };
  if (value instanceof Uint8Array) {
    return {
      type: "file",
      bytes: value,
      mediaType: "application/octet-stream",
      role,
      disposition: "attachment",
    };
  }
  return { type: "json", value, role };
}

export async function loadParticipant(
  context: Pick<ProcessorContext, "collections">,
  id: string,
): Promise<CollectionRecord | null> {
  return await requireCollection(context, "participant").get({ id });
}
