import type {
  CollectionRecord,
  ScopedCollectionCallOptions,
  ScopedCollections,
} from "@copilotz/copilotz/collections";
import type {
  ContentSequence,
  DurableContentInput,
} from "@copilotz/copilotz/content";
import type {
  ParticipantInput,
  ParticipantType,
} from "@copilotz/copilotz/domain";
import type { EventVisibility } from "@copilotz/copilotz/events";
import {
  defineFeature,
  type FeatureAction,
  type FeatureDefinition,
  type FeatureExecuteContext,
} from "@copilotz/copilotz/features";

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

export async function ensureParticipantInTransaction(
  collections: ScopedCollections,
  input: ThreadMessageSender,
  threadId?: string,
  eventMetadata?: Readonly<Record<string, unknown>>,
): Promise<CollectionRecord> {
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
  collections: ScopedCollections,
  threadId: string,
  senderId: string,
  eventMetadata?: Readonly<Record<string, unknown>>,
): Promise<void> {
  const thread = await collections.thread.get({ id: threadId });
  if (!thread) throw new Error(`Thread '${threadId}' was not found.`);
  const current = stringArray(thread.participantIds);
  if (current.includes(senderId)) return;
  await collections.thread.update({
    id: threadId,
    set: { participantIds: [...new Set([...current, senderId])] },
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

async function createThreadMessageAction(
  input: unknown,
  context: FeatureExecuteContext,
): Promise<CollectionRecord> {
  const data = asRecord(input);
  const id = requireText(data.id, "Message ID");
  const threadId = requireText(data.threadId, "Thread ID");
  const sender = asSender(data.sender);
  const recipientIds = stringArray(data.recipientIds);
  const eventVisibility = visibility(data.visibility);
  const metadata = structuredClone(asRecord(data.metadata));
  return await context.transaction(async (tx) => {
    const suppliedContent = data.content as DurableContentInput | undefined;
    const content = suppliedContent ?? contentSequence(suppliedContent);
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
    await addSenderToThreadInTransaction(
      collections,
      threadId,
      ensured.id,
    );
    return created;
  });
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

type ThreadMessageFeature = FeatureDefinition<{
  create: FeatureAction<
    typeof createInputSchema,
    CollectionRecord
  >;
}>;

const threadMessageFeatureDefinition: ThreadMessageFeature = defineFeature({
  id: THREAD_MESSAGE_FEATURE_ID,
  actions: {
    create: {
      inputSchema: createInputSchema,
      execute: createThreadMessageAction,
    },
  },
});

export const threadMessageFeature: ThreadMessageFeature =
  threadMessageFeatureDefinition;
