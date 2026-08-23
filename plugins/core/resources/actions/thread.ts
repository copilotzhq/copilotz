import type { CollectionRecord } from "@copilotz/copilotz/collections";
import {
  type ActionContext,
  type ActionDefinition,
  defineAction,
} from "@copilotz/copilotz/actions";
import type { ParticipantInput } from "../../contracts.ts";
import {
  addSenderToThreadInTransaction,
  ensureParticipantInTransaction,
  findParticipant,
} from "./thread-message.ts";
import { asRecord, requiredText } from "./content-policy.ts";

export const CREATE_THREAD_ACTION_ID = "copilotz.core.thread.create";
export const ADD_THREAD_PARTICIPANT_ACTION_ID =
  "copilotz.core.thread.addParticipant";
export const DELETE_THREAD_MESSAGES_ACTION_ID =
  "copilotz.core.thread.deleteMessages";

async function create(
  input: unknown,
  context: ActionContext,
): Promise<CollectionRecord> {
  const data = asRecord(input);
  const eventMetadata = structuredClone(asRecord(data.metadata));
  const participants = Array.isArray(data.participants)
    ? data.participants.map((item) => asRecord(item) as ParticipantInput)
    : [];
  const threadId = typeof data.id === "string" && data.id.trim()
    ? data.id.trim()
    : undefined;
  const existing = await Promise.all(
    participants.map((participant) =>
      findParticipant(context.collections, participant)
    ),
  );
  const thread = await context.transaction(async (tx) => {
    const ensured = await Promise.all(
      participants.map((participant, index) =>
        ensureParticipantInTransaction(
          tx.collections,
          participant,
          existing[index] ?? null,
          undefined,
          eventMetadata,
        )
      ),
    );
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
  const created = await context.collections.thread.get({ id: thread.id });
  if (!created) throw new Error(`Thread '${thread.id}' was not created.`);
  return created;
}

async function addParticipant(
  input: unknown,
  context: ActionContext,
): Promise<
  Readonly<{
    thread: CollectionRecord | null;
    participant: CollectionRecord;
  }>
> {
  const data = asRecord(input);
  const threadId = requiredText(data.threadId, "Thread ID");
  const participant = asRecord(data.participant) as ParticipantInput;
  const eventMetadata = structuredClone(asRecord(data.eventMetadata));
  const existing = await findParticipant(context.collections, participant);
  const ensured = await context.transaction(async (tx) => {
    const ensured = await ensureParticipantInTransaction(
      tx.collections,
      participant,
      existing,
      threadId,
      eventMetadata,
    );
    await addSenderToThreadInTransaction(
      tx.collections,
      threadId,
      ensured.id,
      eventMetadata,
    );
    return ensured;
  });
  const [thread, participantRecord] = await Promise.all([
    context.collections.thread.get({ id: threadId }),
    context.collections.participant.get({ id: ensured.id }),
  ]);
  if (!participantRecord) {
    throw new Error(`Participant '${ensured.id}' was not created.`);
  }
  return Object.freeze({ thread, participant: participantRecord });
}

type AddThreadParticipantResult = Awaited<ReturnType<typeof addParticipant>>;
type DeleteThreadMessagesResult = Awaited<ReturnType<typeof deleteMessages>>;

async function deleteMessages(
  input: unknown,
  context: ActionContext,
): Promise<Readonly<{ threadId: string; deleted: true }>> {
  const data = asRecord(input);
  const threadId = requiredText(data.threadId, "Thread ID");
  const messages = await context.collections.message.queries.byThreadId({
    threadId,
  });
  await context.transaction(async (tx) => {
    for (const message of messages) {
      await tx.collections.message.delete({ id: message.id }, { threadId });
    }
  });
  return Object.freeze({ threadId, deleted: true as const });
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

export const createThreadAction: ActionDefinition<
  unknown,
  CollectionRecord,
  ActionContext,
  typeof createInput,
  undefined
> = defineAction({
  id: CREATE_THREAD_ACTION_ID,
  inputSchema: createInput,
  execute: create,
});

export const addThreadParticipantAction: ActionDefinition<
  unknown,
  AddThreadParticipantResult,
  ActionContext,
  typeof addParticipantInput,
  undefined
> = defineAction({
  id: ADD_THREAD_PARTICIPANT_ACTION_ID,
  inputSchema: addParticipantInput,
  execute: addParticipant,
});

export const deleteThreadMessagesAction: ActionDefinition<
  unknown,
  DeleteThreadMessagesResult,
  ActionContext,
  typeof deleteMessagesInput,
  undefined
> = defineAction({
  id: DELETE_THREAD_MESSAGES_ACTION_ID,
  inputSchema: deleteMessagesInput,
  execute: deleteMessages,
});
