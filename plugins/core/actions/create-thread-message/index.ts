import type { EventVisibility } from "@copilotz/copilotz/core";
/** Defines the atomic Core thread-message Action and domain helper. @module */
import type {
  CollectionMutationRef,
  CollectionRecord,
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
import { decodeContent } from "@copilotz/copilotz/content";
import { asRecord, requiredText } from "../../shared/validation.ts";
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
/** Idempotent Core domain write, usable without creating a child Action receipt. */
export async function createThreadMessage(
  input: unknown,
  context: Pick<ActionContext, "collections" | "content" | "transaction">,
): Promise<CollectionRecord> {
  const data = asRecord(input);
  const id = requiredText(data.id, "Message ID");
  const threadId = requiredText(data.threadId, "Thread ID");
  const sender = asSender(data.sender);
  const recipientIds = stringArray(data.recipientIds);
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
  const [existingSender, thread] = await Promise.all([
    findParticipant(context.collections, sender),
    threadCollection.get({ id: threadId }),
  ]);
  if (!thread) {
    throw new Error(`Thread '${threadId}' was not found.`);
  }
  const existingParticipantIds = stringArray(thread.participantIds);
  const content = decodeContent(data.content ?? []);
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
      identity: { metadata },
      metadata: {
        core: {
          threadId,
          routing: { senderId: ensured.id, recipientIds: [...recipientIds] },
          visibility: messageVisibility,
        },
      },
    };
    const created = await collections.message.create({
      id,
      threadId,
      senderId: ensured.id,
      recipientIds: [...recipientIds],
      content,
      metadata,
      visibility: messageVisibility,
      ...(historyScopeId ? { historyScopeId } : {}),
    }, options);
    if (!existingParticipantIds.includes(ensured.id)) {
      await addSenderToThreadInTransaction(collections, threadId, ensured.id);
    }
    return created;
  });
  const created = await context.collections.message.get({ id });
  if (!created) {
    throw new Error(`Message '${id}' was not created.`);
  }
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
