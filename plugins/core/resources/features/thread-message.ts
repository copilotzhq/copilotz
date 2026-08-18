import type {
  CollectionMutationIdentity,
  CollectionRecord,
  CollectionTransactionCollections,
  CollectionWriteOptions,
} from "@copilotz/copilotz/collections";
import type { ContentSequence } from "@copilotz/copilotz/content";
import type { ParticipantInput, ParticipantType } from "@copilotz/copilotz/domain";
import type { EventVisibility } from "@copilotz/copilotz/events";
import type { FeatureContext, FeatureResource } from "@copilotz/copilotz/features";

export const THREAD_MESSAGE_FEATURE_ID = "copilotz.core.thread-message";

export type ThreadMessageSender = CollectionRecord | ParticipantInput;

const PARTICIPANT_TYPES = new Set<ParticipantType>([
  "human",
  "agent",
  "tool",
  "job",
]);

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requireText(value: unknown, name: string): string {
  const normalized = optionalText(value);
  if (!normalized) throw new TypeError(`${name} must be non-empty.`);
  return normalized;
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

function participantType(value: unknown): ParticipantType {
  if (typeof value === "string" && PARTICIPANT_TYPES.has(value as ParticipantType)) {
    return value as ParticipantType;
  }
  throw new TypeError("Sender participantType must be human, agent, tool, or job.");
}

function visibility(value: unknown): EventVisibility | undefined {
  const record = asRecord(value);
  const kind = optionalText(record.kind);
  if (!kind) return undefined;
  if (kind === "public") return { kind: "public" };
  if (kind === "internal") return { kind: "internal" };
  if (kind === "participants") {
    return { kind: "participants", participantIds: stringArray(record.participantIds) };
  }
  if (kind === "tool") {
    const policy = optionalText(record.policy);
    if (
      policy !== "requester_only" && policy !== "public_status" &&
      policy !== "public"
    ) {
      throw new TypeError("Tool visibility policy is invalid.");
    }
    return {
      kind: "tool",
      policy,
      requesterId: requireText(record.requesterId, "Tool visibility requesterId"),
    };
  }
  throw new TypeError(`Unknown visibility kind '${kind}'.`);
}

function mutationIdentity(value: unknown): CollectionMutationIdentity | undefined {
  const record = asRecord(value);
  const next = {
    ...(optionalText(record.causationId)
      ? { causationId: optionalText(record.causationId) }
      : {}),
    ...(optionalText(record.correlationId)
      ? { correlationId: optionalText(record.correlationId) }
      : {}),
    ...(optionalText(record.deduplicationId)
      ? { deduplicationId: optionalText(record.deduplicationId) }
      : {}),
    ...(optionalText(record.settlementScopeId)
      ? { settlementScopeId: optionalText(record.settlementScopeId) }
      : {}),
    ...(record.metadata && typeof record.metadata === "object" &&
        !Array.isArray(record.metadata)
      ? { metadata: structuredClone(record.metadata as Record<string, unknown>) }
      : {}),
  };
  return Object.keys(next).length > 0 ? next : undefined;
}

function writeOptions(
  namespace: string,
  extra: Omit<CollectionWriteOptions, "namespace"> = {},
): CollectionWriteOptions {
  return { namespace, ...extra };
}

export function senderFields(input: ThreadMessageSender): ParticipantInput {
  return {
    ...(optionalText(input.id) ? { id: optionalText(input.id) } : {}),
    externalId: String(input.externalId ?? input.id ?? ""),
    participantType: participantType(input.participantType),
    ...(optionalText(input.name) ? { name: optionalText(input.name) } : {}),
    ...("email" in input && optionalText(input.email)
      ? { email: optionalText(input.email) }
      : {}),
    ...("agentId" in input && optionalText(input.agentId)
      ? { agentId: optionalText(input.agentId) }
      : {}),
    metadata: structuredClone(asRecord(input.metadata)),
  };
}

export async function ensureParticipantInTransaction(
  collections: CollectionTransactionCollections,
  namespace: string,
  input: ThreadMessageSender,
  threadId: string,
): Promise<CollectionRecord> {
  const collection = collections.participant;
  if (!collection) throw new Error("Collection 'participant' is not bound.");
  const id = optionalText(
    typeof input === "object" && input ? (input as { id?: unknown }).id : undefined,
  );
  if (id) {
    const existing = await collection.get(id, namespace);
    if (existing) return existing;
  }
  const fields = senderFields(input);
  const externalId = fields.externalId?.trim();
  if (externalId && collection.query.byExternalId) {
    const [byExternal] = await collection.query.byExternalId(namespace, {
      externalId,
    });
    if (byExternal) return byExternal;
  }
  if (!externalId) {
    throw new TypeError("Sender externalId must be non-empty.");
  }
  const created = await collection.create({
    ...(fields.id?.trim() ? { id: fields.id.trim() } : {}),
    externalId,
    participantType: fields.participantType,
    ...(fields.name ? { name: fields.name } : {}),
    ...(fields.email ? { email: fields.email } : {}),
    ...(fields.agentId ? { agentId: fields.agentId } : {}),
    metadata: structuredClone(fields.metadata ?? {}),
  }, writeOptions(namespace, { threadId }));
  return created.record;
}

export async function addSenderToThreadInTransaction(
  collections: CollectionTransactionCollections,
  namespace: string,
  threadId: string,
  senderId: string,
): Promise<void> {
  const thread = await collections.thread.get(threadId, namespace);
  if (!thread) throw new Error(`Thread '${threadId}' was not found.`);
  const current = stringArray(thread.participantIds);
  if (current.includes(senderId)) return;
  await collections.thread.update(threadId, {
    set: { participantIds: [...new Set([...current, senderId])] },
  }, writeOptions(namespace, { threadId }));
}

function asSender(value: unknown): ThreadMessageSender {
  const record = asRecord(value);
  if (!record.id && !record.externalId) {
    throw new TypeError("Sender id or externalId must be non-empty.");
  }
  return record as ThreadMessageSender;
}

async function createThreadMessageAction(
  input: unknown,
  context: FeatureContext,
): Promise<CollectionRecord> {
  const data = asRecord(input);
  const id = requireText(data.id, "Message ID");
  const threadId = requireText(data.threadId, "Thread ID");
  const operationKey = requireText(data.operationKey, "Operation key");
  const sender = asSender(data.sender);
  const recipientIds = stringArray(data.recipientIds);
  const content = contentSequence(data.content);
  const eventVisibility = visibility(data.visibility);
  const identity = mutationIdentity(data.identity);
  const result = await context.transaction({
    operationKey,
    namespace: context.namespace,
    ...(identity ? { identity } : {}),
    execute: async ({ collections }) => {
      if (!collections.message) throw new Error("Collection 'message' is not bound.");
      if (!collections.thread) throw new Error("Collection 'thread' is not bound.");
      const ensured = await ensureParticipantInTransaction(
        collections,
        context.namespace,
        sender,
        threadId,
      );
      const created = await collections.message.create({
        id,
        threadId,
        senderId: ensured.id,
        recipientIds: [...recipientIds],
        content,
        metadata: structuredClone(asRecord(data.metadata)),
      }, writeOptions(context.namespace, {
        threadId,
        routing: { senderId: ensured.id, recipientIds: [...recipientIds] },
        visibility: eventVisibility ?? { kind: "public" },
        ...(identity ? { identity } : {}),
      }));
      await addSenderToThreadInTransaction(
        collections,
        context.namespace,
        threadId,
        ensured.id,
      );
      return created.record;
    },
  });
  return result.value;
}

export const threadMessageFeature: FeatureResource = Object.freeze({
  id: THREAD_MESSAGE_FEATURE_ID,
  actions: Object.freeze({
    create: createThreadMessageAction,
  }),
});
