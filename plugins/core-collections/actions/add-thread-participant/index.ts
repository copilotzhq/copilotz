/** Defines the Core add-thread-participant Action. @module */

import type { CollectionRecord } from "@copilotz/copilotz/collections";
import {
  type ActionContext,
  type ActionDefinition,
  defineAction,
} from "@copilotz/copilotz/actions";
import type { ParticipantInput } from "../../internal/contracts.ts";
import {
  addSenderToThreadInTransaction,
  ensureParticipantInTransaction,
  findParticipant,
} from "../create-thread-message/index.ts";
import { asRecord, requiredText } from "../internal/content-policy.ts";

export const ADD_THREAD_PARTICIPANT_ACTION_ID =
  "copilotz.core.thread.addParticipant";

type AddThreadParticipantResult = Readonly<{
  thread: CollectionRecord | null;
  participant: CollectionRecord;
}>;

const inputSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    threadId: { type: "string" },
    participant: { type: "object" },
    eventMetadata: { type: "object" },
  },
  required: ["threadId", "participant"],
} as const;

export const addThreadParticipantAction: ActionDefinition<
  unknown,
  AddThreadParticipantResult,
  ActionContext,
  typeof inputSchema,
  undefined
> = defineAction({
  id: ADD_THREAD_PARTICIPANT_ACTION_ID,
  inputSchema,
  async execute(input, context) {
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
  },
});
