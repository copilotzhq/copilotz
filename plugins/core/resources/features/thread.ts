import type { CollectionRecord } from "@copilotz/copilotz/collections";
import {
  defineFeature,
  type FeatureAction,
  type FeatureDefinition,
  type FeatureExecuteContext,
} from "@copilotz/copilotz/features";
import type { ParticipantInput } from "@copilotz/copilotz/domain";
import {
  addSenderToThreadInTransaction,
  ensureParticipantInTransaction,
} from "./thread-message.ts";
import { asRecord, requiredText } from "./content-policy.ts";

export const THREAD_FEATURE_ID = "copilotz.core.thread";

async function create(
  input: unknown,
  context: FeatureExecuteContext,
): Promise<CollectionRecord> {
  return await context.transaction(async (tx) => {
    const data = asRecord(input);
    const eventMetadata = structuredClone(asRecord(data.metadata));
    const participants = Array.isArray(data.participants)
      ? data.participants.map((item) => asRecord(item) as ParticipantInput)
      : [];
    const threadId = typeof data.id === "string" && data.id.trim()
      ? data.id.trim()
      : undefined;
    const ensured: CollectionRecord[] = [];
    for (const participant of participants) {
      ensured.push(
        await ensureParticipantInTransaction(
          tx.collections,
          participant,
          undefined,
          eventMetadata,
        ),
      );
    }
    const { participants: _participants, ...fields } = data;
    return await tx.collections.thread.create({
      ...fields,
      ...(threadId ? { id: threadId } : {}),
      participantIds: ensured.map((participant) => participant.id),
      metadata: eventMetadata,
    }, {
      ...(threadId ? { threadId } : {}),
      identity: { metadata: eventMetadata },
    });
  });
}

async function addParticipant(
  input: unknown,
  context: FeatureExecuteContext,
): Promise<
  Readonly<{
    thread: CollectionRecord | null;
    participant: CollectionRecord;
  }>
> {
  return await context.transaction(async (tx) => {
    const data = asRecord(input);
    const threadId = requiredText(data.threadId, "Thread ID");
    const participant = asRecord(data.participant) as ParticipantInput;
    const eventMetadata = structuredClone(asRecord(data.eventMetadata));
    const ensured = await ensureParticipantInTransaction(
      tx.collections,
      participant,
      threadId,
      eventMetadata,
    );
    await addSenderToThreadInTransaction(
      tx.collections,
      threadId,
      ensured.id,
      eventMetadata,
    );
    return Object.freeze({
      thread: await tx.collections.thread.get({ id: threadId }),
      participant: ensured,
    });
  });
}

async function deleteMessages(
  input: unknown,
  context: FeatureExecuteContext,
): Promise<Readonly<{ threadId: string; deleted: true }>> {
  return await context.transaction(async (tx) => {
    const data = asRecord(input);
    const threadId = requiredText(data.threadId, "Thread ID");
    const messages = await tx.collections.message.queries.byThreadId({
      threadId,
    });
    for (const message of messages) {
      await tx.collections.message.delete({ id: message.id }, { threadId });
    }
    return Object.freeze({ threadId, deleted: true as const });
  });
}

const createInput = {
  type: "object",
  additionalProperties: true,
  properties: {
    id: { type: "string" },
    participants: { type: "array", items: { type: "object" } },
    metadata: { type: "object" },
  },
} as const;

const addParticipantInput = {
  type: "object",
  additionalProperties: true,
  properties: {
    threadId: { type: "string" },
    participant: { type: "object" },
    eventMetadata: { type: "object" },
  },
  required: ["threadId", "participant"],
} as const;

const deleteMessagesInput = {
  type: "object",
  additionalProperties: true,
  properties: { threadId: { type: "string" } },
  required: ["threadId"],
} as const;

type ThreadParticipantResult = Awaited<ReturnType<typeof addParticipant>>;
type DeleteMessagesResult = Awaited<ReturnType<typeof deleteMessages>>;
type ThreadFeature = FeatureDefinition<{
  create: FeatureAction<typeof createInput, CollectionRecord>;
  addParticipant: FeatureAction<
    typeof addParticipantInput,
    ThreadParticipantResult
  >;
  deleteMessages: FeatureAction<
    typeof deleteMessagesInput,
    DeleteMessagesResult
  >;
}>;

const threadFeatureDefinition: ThreadFeature = defineFeature({
  id: THREAD_FEATURE_ID,
  actions: {
    create: {
      inputSchema: createInput,
      execute: create,
    },
    addParticipant: {
      inputSchema: addParticipantInput,
      execute: addParticipant,
    },
    deleteMessages: {
      inputSchema: deleteMessagesInput,
      execute: deleteMessages,
    },
  },
});

export const threadFeature: ThreadFeature = threadFeatureDefinition;
