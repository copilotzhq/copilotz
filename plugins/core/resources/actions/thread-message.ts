import type {
  CollectionMutationRef,
  CollectionRecord,
  ScopedCollectionCallOptions,
  ScopedCollections,
} from "@copilotz/copilotz/collections";
import type { ParticipantInput, ParticipantType } from "../../contracts.ts";
import type { EventVisibility } from "@copilotz/copilotz/events";
import {
  type ActionContext,
  type ActionDefinition,
  type ActionTransactionContext,
  defineAction,
} from "@copilotz/copilotz/actions";
import { prepareActionContent } from "./content-policy.ts";

export const CREATE_THREAD_MESSAGE_ACTION_ID =
  "copilotz.core.thread-message.create";

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

function participantType(value: unknown): ParticipantType {
  if (
    typeof value === "string" && PARTICIPANT_TYPES.has(value as ParticipantType)
  ) {
    return value as ParticipantType;
  }
  throw new TypeError(
    "Sender participantType must be human, agent, tool, or job.",
  );
}

function visibility(value: unknown): EventVisibility | undefined {
  const record = asRecord(value);
  const kind = optionalText(record.kind);
  if (!kind) return undefined;
  if (kind === "public") return { kind: "public" };
  if (kind === "internal") return { kind: "internal" };
  if (kind === "participants") {
    return {
      kind: "participants",
      participantIds: stringArray(record.participantIds),
    };
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
      requesterId: requireText(
        record.requesterId,
        "Tool visibility requesterId",
      ),
    };
  }
  throw new TypeError(`Unknown visibility kind '${kind}'.`);
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

export async function findParticipant(
  collections: ScopedCollections,
  input: ThreadMessageSender,
): Promise<CollectionRecord | null> {
  const collection = collections.participant;
  if (!collection) throw new Error("Collection 'participant' is not bound.");
  const id = optionalText(
    typeof input === "object" && input
      ? (input as { id?: unknown }).id
      : undefined,
  );
  if (id) {
    const existing = await collection.get({ id });
    if (existing) return existing;
  }
  const fields = senderFields(input);
  const externalId = fields.externalId?.trim();
  if (externalId && collection.queries.byExternalId) {
    const [byExternal] = await collection.queries.byExternalId({
      externalId,
    });
    if (byExternal) return byExternal;
  }
  return null;
}

export async function ensureParticipantInTransaction(
  collections: ActionTransactionContext["collections"],
  input: ThreadMessageSender,
  existing: CollectionRecord | null,
  threadId?: string,
  eventMetadata?: Readonly<Record<string, unknown>>,
): Promise<CollectionMutationRef> {
  if (existing) return Object.freeze({ id: existing.id });
  const collection = collections.participant;
  if (!collection) throw new Error("Collection 'participant' is not bound.");
  const fields = senderFields(input);
  const externalId = fields.externalId?.trim();
  if (!externalId) {
    throw new TypeError("Sender externalId must be non-empty.");
  }
  const created = await collection.create(
    {
      ...(fields.id?.trim() ? { id: fields.id.trim() } : {}),
      externalId,
      participantType: fields.participantType,
      ...(fields.name ? { name: fields.name } : {}),
      ...(fields.email ? { email: fields.email } : {}),
      ...(fields.agentId ? { agentId: fields.agentId } : {}),
      metadata: structuredClone(fields.metadata ?? {}),
    },
    threadId || eventMetadata
      ? {
        ...(threadId ? { threadId } : {}),
        ...(eventMetadata ? { identity: { metadata: eventMetadata } } : {}),
      }
      : undefined,
  );
  return created;
}

export async function addSenderToThreadInTransaction(
  collections: ActionTransactionContext["collections"],
  threadId: string,
  senderId: string,
  eventMetadata?: Readonly<Record<string, unknown>>,
): Promise<void> {
  await collections.thread.commands.addParticipant({
    id: threadId,
    participantId: senderId,
  }, {
    threadId,
    ...(eventMetadata ? { identity: { metadata: eventMetadata } } : {}),
  });
}

function asSender(value: unknown): ThreadMessageSender {
  const record = asRecord(value);
  if (!record.id && !record.externalId) {
    throw new TypeError("Sender id or externalId must be non-empty.");
  }
  return record as ThreadMessageSender;
}

async function executeCreateThreadMessage(
  input: unknown,
  context: ActionContext,
): Promise<CollectionRecord> {
  const data = asRecord(input);
  const id = requireText(data.id, "Message ID");
  const threadId = requireText(data.threadId, "Thread ID");
  const sender = asSender(data.sender);
  const recipientIds = stringArray(data.recipientIds);
  const eventVisibility = visibility(data.visibility);
  const metadata = structuredClone(asRecord(data.metadata));
  const threadCollection = context.collections.thread;
  if (!threadCollection) {
    throw new Error("Collection 'thread' is not bound.");
  }
  const [existingSender, thread] = await Promise.all([
    findParticipant(context.collections, sender),
    threadCollection.get({ id: threadId }),
  ]);
  if (!thread) throw new Error(`Thread '${threadId}' was not found.`);
  const existingParticipantIds = stringArray(thread.participantIds);
  const content = await prepareActionContent(
    data.content ?? [],
    context,
    "message-content",
  );
  await context.transaction(async (tx) => {
    const collections = tx.collections;
    if (!collections.message) {
      throw new Error("Collection 'message' is not bound.");
    }
    if (!collections.thread) {
      throw new Error("Collection 'thread' is not bound.");
    }
    const ensured = await ensureParticipantInTransaction(
      collections,
      sender,
      existingSender,
      threadId,
    );
    const options: ScopedCollectionCallOptions = {
      threadId,
      routing: { senderId: ensured.id, recipientIds: [...recipientIds] },
      visibility: eventVisibility ?? { kind: "public" },
      identity: { metadata },
    };
    const created = await collections.message.create({
      id,
      threadId,
      senderId: ensured.id,
      recipientIds: [...recipientIds],
      content,
      metadata,
    }, options);
    if (!existingParticipantIds.includes(ensured.id)) {
      await addSenderToThreadInTransaction(
        collections,
        threadId,
        ensured.id,
      );
    }
    return created;
  });
  const created = await context.collections.message.get({ id });
  if (!created) throw new Error(`Message '${id}' was not created.`);
  return created;
}

const createInputSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    id: { type: "string" },
    threadId: { type: "string" },
    sender: { type: "object" },
    recipientIds: { type: "array", items: { type: "string" } },
    content: {},
    metadata: { type: "object" },
    visibility: { type: "object" },
  },
  required: ["id", "threadId", "sender"],
} as const;

export const createThreadMessageAction: ActionDefinition<
  unknown,
  CollectionRecord,
  ActionContext,
  typeof createInputSchema,
  undefined
> = defineAction({
  id: CREATE_THREAD_MESSAGE_ACTION_ID,
  inputSchema: createInputSchema,
  execute: executeCreateThreadMessage,
});
