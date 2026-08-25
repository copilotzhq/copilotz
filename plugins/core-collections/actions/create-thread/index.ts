/** Defines the Core thread-creation Action. @module */

import type { CollectionRecord } from "@copilotz/copilotz/collections";
import {
  type ActionContext,
  type ActionDefinition,
  defineAction,
} from "@copilotz/copilotz/actions";
import type { ParticipantInput } from "../../internal/contracts.ts";
import {
  ensureParticipantInTransaction,
  findParticipant,
} from "../create-thread-message/index.ts";
import { asRecord } from "../internal/content-policy.ts";

export const CREATE_THREAD_ACTION_ID = "copilotz.core.thread.create";

const inputSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    id: { type: "string" },
    participants: { type: "array", items: { type: "object" } },
    metadata: { type: "object" },
  },
} as const;

export const createThreadAction: ActionDefinition<
  unknown,
  CollectionRecord,
  ActionContext,
  typeof inputSchema,
  undefined
> = defineAction({
  id: CREATE_THREAD_ACTION_ID,
  inputSchema,
  async execute(input, context) {
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
  },
});
