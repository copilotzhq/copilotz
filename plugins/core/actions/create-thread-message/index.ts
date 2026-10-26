import { coreThreadObservationMetadata } from "../../shared/events/index.ts";
import type { EventVisibility } from "@copilotz/copilotz/core";
/** Defines the atomic Core thread-message Action and domain helper. @module */
import type {
  CollectionMutationRef,
  CollectionRecord,
  ScopedCollection,
  ScopedCollectionCallOptions,
  ScopedCollections,
} from "@copilotz/copilotz/collections";
import type {
  ParticipantInput,
  ParticipantType,
} from "../../shared/contracts.ts";
import type {} from "@copilotz/copilotz/events";
import {
  type ActionContext,
  type ActionDefinition,
  type ActionTransactionContext,
  defineAction,
} from "@copilotz/copilotz/actions";
import { decodeGeneratedContent } from "@copilotz/copilotz/content";
import { asRecord, requiredText } from "../../shared/validation.ts";
import { retryCoreMutation } from "../../shared/retry-mutation.ts";
export const CREATE_THREAD_MESSAGE_ACTION_ID =
  "copilotz.core.thread-message.create";
export type ThreadMessageSender = CollectionRecord | ParticipantInput;
const PARTICIPANT_TYPES = new Set<ParticipantType>([
  "human",
  "agent",
  "tool",
  "job",
]);
function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function stringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    return ([] as const);
  }
  return (value.filter((item): item is string =>
    typeof item === "string" && Boolean(item.trim())
  ));
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
  if (!kind) {
    return undefined;
  }
  if (kind === "public") {
    return { kind: "public" };
  }
  if (kind === "internal") {
    return { kind: "internal" };
  }
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
      ...(optionalText(record.initiatorId)
        ? { initiatorId: optionalText(record.initiatorId) }
        : {}),
      requesterId: requiredText(
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
  if (!collection) {
    throw new Error("Collection 'participant' is not bound.");
  }
  const id = optionalText(
    typeof input === "object" && input
      ? (input as {
        id?: unknown;
      }).id
      : undefined,
  );
  if (id) {
    const existing = await collection.get({ id });
    if (existing) {
      return existing;
    }
  }
  const fields = senderFields(input);
  const externalId = fields.externalId?.trim();
  if (externalId && collection.queries.byExternalId) {
    const [byExternal] = await collection.queries.byExternalId({
      externalId,
    });
    if (byExternal) {
      return byExternal;
    }
  }
  return null;
}
/**
 * Who a message that names no recipients addresses: the Thread's agent
 * participants other than the sender, in membership order. A Thread without
 * agents yields none.
 */
export async function threadAgentRecipients(
  participants: Pick<ScopedCollection, "get">,
  thread: CollectionRecord,
  senderId?: string,
): Promise<readonly CollectionRecord[]> {
  const members = await Promise.all(
    stringArray(thread.participantIds)
      .filter((id) => id !== senderId)
      .map((id) => participants.get({ id })),
  );
  return members.filter((member): member is CollectionRecord =>
    member?.participantType === "agent"
  );
}
export async function ensureParticipantInTransaction(
  collections: ActionTransactionContext["collections"],
  input: ThreadMessageSender,
  existing: CollectionRecord | null,
  threadId?: string,
  eventMetadata?: Readonly<Record<string, unknown>>,
): Promise<CollectionMutationRef> {
  if (existing) {
    return ({ id: existing.id } as const);
  }
  const collection = collections.participant;
  if (!collection) {
    throw new Error("Collection 'participant' is not bound.");
  }
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
        ...(threadId
          ? {
            metadata: {
              ...coreThreadObservationMetadata(threadId),
              core: {
                threadId,
              },
            },
          }
          : {}),
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
    ...(eventMetadata ? { identity: { metadata: eventMetadata } } : {}),
    metadata: {
      ...coreThreadObservationMetadata(threadId),
      core: {
        threadId,
      },
    },
  });
}
function asSender(value: unknown): ThreadMessageSender {
  const record = asRecord(value);
  if (!record.id && !record.externalId) {
    throw new TypeError("Sender id or externalId must be non-empty.");
  }
  return record as ThreadMessageSender;
}
type ThreadMembership = Readonly<{
  participants: readonly ParticipantInput[];
  recipients: readonly (
    | Readonly<{ participantId: string }>
    | Readonly<{ externalId: string }>
  )[];
}>;
function threadMembership(value: unknown): ThreadMembership {
  if (value === undefined) return { participants: [], recipients: [] };
  const record = asRecord(value);
  if (!Array.isArray(record.participants)) {
    throw new TypeError("Membership participants must be an array.");
  }
  const participantsByExternalId = new Map<string, ParticipantInput>();
  for (const value of record.participants) {
    const participant = asSender(value);
    const fields = senderFields(participant);
    const externalId = fields.externalId.trim();
    if (!externalId) {
      throw new TypeError("Membership participant externalId is required.");
    }
    if (participantsByExternalId.has(externalId)) {
      throw new TypeError(
        `Membership participant '${externalId}' is duplicated.`,
      );
    }
    participantsByExternalId.set(externalId, {
      ...fields,
      externalId,
    });
  }
  const recipientInputs = record.recipients === undefined
    ? []
    : record.recipients;
  if (
    !Array.isArray(recipientInputs)
  ) {
    throw new TypeError("Membership recipients must be an array.");
  }
  const recipients = recipientInputs.map((input) => {
    const recipient = asRecord(input);
    const participantId = optionalText(recipient.participantId);
    const externalId = optionalText(recipient.externalId);
    if (Boolean(participantId) === Boolean(externalId)) {
      throw new TypeError(
        "Membership recipient must identify one participant or external ID.",
      );
    }
    if (externalId && !participantsByExternalId.has(externalId)) {
      throw new TypeError(
        `Recipient participant '${externalId}' is not in the membership batch.`,
      );
    }
    return participantId ? { participantId } : { externalId: externalId! };
  });
  const participants = [...participantsByExternalId.keys()].sort().map((id) =>
    participantsByExternalId.get(id)!
  );
  return { participants, recipients };
}
/** One Message prepared from a fresh conversation snapshot. */
type PreparedThreadMessage = Readonly<{
  id: string;
  threadId: string;
  sender: ThreadMessageSender;
  existingSender: CollectionRecord | null;
  senderExternalId: string;
  membership: ThreadMembership;
  existingMembershipParticipants: readonly (CollectionRecord | null)[];
  threadParticipantIds: readonly string[];
  recipientIds: readonly string[];
  defaultRecipientIds: readonly string[];
  content: ReturnType<typeof decodeGeneratedContent>;
  metadata: Record<string, unknown>;
  messageVisibility: EventVisibility;
  historyScopeId?: string;
}>;

async function prepareThreadMessage(
  input: unknown,
  context: Pick<ActionContext, "collections">,
): Promise<PreparedThreadMessage> {
  const data = asRecord(input);
  const id = requiredText(data.id, "Message ID");
  const threadId = requiredText(data.threadId, "Thread ID");
  const sender = asSender(data.sender);
  const recipientIds = stringArray(data.recipientIds);
  const membership = threadMembership(data.membership);
  // Explicit recipients win, including an explicit empty list.
  const namesRecipients = data.recipientIds !== undefined ||
    asRecord(data.membership).recipients !== undefined;
  const eventVisibility = visibility(data.visibility);
  const messageVisibility = eventVisibility ?? { kind: "public" as const };
  const historyScopeId = optionalText(data.historyScopeId);
  if (historyScopeId && messageVisibility.kind !== "internal") {
    throw new TypeError("Scoped Message history requires internal visibility.");
  }
  const metadata = structuredClone(asRecord(data.metadata));
  const threadCollection = context.collections.thread;
  if (!threadCollection) {
    throw new Error("Collection 'thread' is not bound.");
  }
  const [existingSender, thread, existingMembershipParticipants] = await Promise
    .all([
      findParticipant(context.collections, sender),
      threadCollection.get({ id: threadId }),
      Promise.all(
        membership.participants.map((participant) =>
          findParticipant(context.collections, participant)
        ),
      ),
    ]);
  if (!thread) {
    throw new Error(`Thread '${threadId}' was not found.`);
  }
  const defaultRecipientIds = namesRecipients
    ? []
    : (await threadAgentRecipients(
      context.collections.participant,
      thread,
      optionalText(existingSender?.id),
    )).map((recipient) => recipient.id);
  return {
    id,
    threadId,
    sender,
    existingSender,
    senderExternalId: optionalText(existingSender?.externalId) ??
      optionalText(sender.externalId) ?? optionalText(sender.id) ?? "",
    membership,
    existingMembershipParticipants,
    threadParticipantIds: stringArray(thread.participantIds),
    recipientIds,
    defaultRecipientIds,
    content: decodeGeneratedContent(data.content ?? []),
    metadata,
    messageVisibility,
    ...(historyScopeId ? { historyScopeId } : {}),
  };
}

/** What earlier Messages of one transaction already wrote. */
type MessageBatch = {
  participants: Map<string, Promise<CollectionMutationRef>>;
  members: Map<string, Set<string>>;
};

async function writeThreadMessage(
  message: PreparedThreadMessage,
  collections: ActionTransactionContext["collections"],
  batch: MessageBatch,
): Promise<unknown> {
  if (!collections.message) {
    throw new Error("Collection 'message' is not bound.");
  }
  if (!collections.thread) {
    throw new Error("Collection 'thread' is not bound.");
  }
  const { id, threadId, membership } = message;
  // A participant new to this transaction is created once, however many of
  // its Messages the batch writes.
  const ensure = (
    participant: ThreadMessageSender,
    existing: CollectionRecord | null,
  ): Promise<CollectionMutationRef> => {
    if (existing) return Promise.resolve({ id: existing.id } as const);
    const key = senderFields(participant).externalId?.trim() ?? "";
    let ensured = batch.participants.get(key);
    if (!ensured) {
      ensured = ensureParticipantInTransaction(
        collections,
        participant,
        existing,
        threadId,
      );
      batch.participants.set(key, ensured);
    }
    return ensured;
  };
  const ensured = await ensure(message.sender, message.existingSender);
  const memberRefs = await Promise.all(
    membership.participants.map((participant, index) =>
      participant.externalId === message.senderExternalId
        ? Promise.resolve(ensured)
        : ensure(
          participant,
          message.existingMembershipParticipants[index] ?? null,
        )
    ),
  );
  const memberIdByExternalId = new Map(
    membership.participants.map((participant, index) => [
      participant.externalId,
      memberRefs[index].id,
    ]),
  );
  const messageRecipientIds = [
    ...new Set([
      ...message.recipientIds,
      ...message.defaultRecipientIds,
      ...membership.recipients.map((recipient) =>
        "participantId" in recipient
          ? recipient.participantId
          : memberIdByExternalId.get(recipient.externalId)!
      ),
    ]),
  ];
  let members = batch.members.get(threadId);
  if (!members) {
    members = new Set(message.threadParticipantIds);
    batch.members.set(threadId, members);
  }
  // The sender joins with the batch. Most messages add nobody new, so the
  // thread is written only when someone is not yet a member.
  const joining = [
    ...new Set([ensured.id, ...memberRefs.map((member) => member.id)]),
  ].filter((participantId) => !members.has(participantId));
  if (joining.length) {
    await collections.thread.commands.ensureMembership({
      id: threadId,
      participantIds: joining.sort(),
    }, {
      operationKey: `message-membership:${id}`,
      metadata: {
        ...coreThreadObservationMetadata(threadId),
        core: { threadId },
      },
    });
    for (const participantId of joining) members.add(participantId);
  }
  const options: ScopedCollectionCallOptions = {
    identity: { metadata: message.metadata },
    metadata: {
      ...coreThreadObservationMetadata(threadId),
      core: {
        threadId,
        routing: {
          senderId: ensured.id,
          recipientIds: [...messageRecipientIds],
        },
        visibility: message.messageVisibility,
      },
    },
  };
  const created = await collections.message.create({
    id,
    threadId,
    senderId: ensured.id,
    recipientIds: [...messageRecipientIds],
    content: message.content,
    metadata: message.metadata,
    visibility: message.messageVisibility,
    ...(message.historyScopeId
      ? { historyScopeId: message.historyScopeId }
      : {}),
  }, options);
  // A visible message is activity: the thread's updatedAt moves with it,
  // in the same transaction, so recent lists reorder. Internal work does not.
  if (message.messageVisibility.kind !== "internal") {
    await collections.thread.commands.recordMessage({
      id: threadId,
      messageId: id,
    }, {
      operationKey: `message-activity:${id}`,
      metadata: {
        ...coreThreadObservationMetadata(threadId),
        core: { threadId },
      },
    });
  }
  return created;
}

/** One atomic write of every Message, in order, from fresh snapshots. */
async function createThreadMessagesAttempt(
  inputs: readonly unknown[],
  context: Pick<ActionContext, "collections" | "content" | "transaction">,
): Promise<CollectionRecord[]> {
  const prepared = await Promise.all(
    inputs.map((input) => prepareThreadMessage(input, context)),
  );
  const written = await context.transaction(async (tx) => {
    const batch: MessageBatch = { participants: new Map(), members: new Map() };
    const created: unknown[] = [];
    for (const message of prepared) {
      created.push(await writeThreadMessage(message, tx.collections, batch));
    }
    return created;
  });
  // The committed create already returns the canonical record; read it back
  // only when the write path returned something else.
  return await Promise.all(prepared.map(async ({ id }, index) => {
    const value = (written as unknown[] | undefined)?.[index];
    const created = value && typeof value === "object" &&
        (value as CollectionRecord).id === id &&
        typeof (value as CollectionRecord).createdAt === "string"
      ? value as CollectionRecord
      : await context.collections.message.get({ id });
    if (!created) {
      throw new Error(`Message '${id}' was not created.`);
    }
    return created;
  }));
}
/** Idempotent Core domain write of several Messages in one transaction, in
 * order. Re-read after known rollback: parallel Tool/Ask branches can update
 * membership or activity while another message is being prepared. */
export async function createThreadMessages(
  inputs: readonly unknown[],
  context: Pick<ActionContext, "collections" | "content" | "transaction">,
): Promise<CollectionRecord[]> {
  return await retryCoreMutation(() =>
    createThreadMessagesAttempt(inputs, context)
  );
}
/** Idempotent Core domain write, usable without creating a child Action receipt. */
export async function createThreadMessage(
  input: unknown,
  context: Pick<ActionContext, "collections" | "content" | "transaction">,
): Promise<CollectionRecord> {
  return (await createThreadMessages([input], context))[0];
}
const createInputSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    id: { type: "string" },
    threadId: { type: "string" },
    sender: { type: "object" },
    recipientIds: { type: "array", items: { type: "string" } },
    membership: {
      type: "object",
      additionalProperties: false,
      properties: {
        participants: { type: "array", items: { type: "object" } },
        recipients: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              participantId: { type: "string", minLength: 1 },
              externalId: { type: "string", minLength: 1 },
            },
            oneOf: [
              { required: ["participantId"] },
              { required: ["externalId"] },
            ],
          },
        },
      },
      required: ["participants"],
    },
    content: {},
    metadata: { type: "object" },
    visibility: { type: "object" },
    historyScopeId: { type: "string" },
  },
  required: ["id", "threadId", "sender"],
} as const;
async function executeCreateThreadMessage(
  input: unknown,
  context: ActionContext,
): Promise<CollectionRecord> {
  return await createThreadMessage(input, context);
}
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
export default createThreadMessageAction;
