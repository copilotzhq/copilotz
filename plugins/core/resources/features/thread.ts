import type { CollectionRecord } from "@copilotz/copilotz/collections";
import type {
  FeatureContext,
  FeatureResource,
} from "@copilotz/copilotz/features";
import type { ParticipantInput } from "@copilotz/copilotz/domain";
import {
  addSenderToThreadInTransaction,
  ensureParticipantInTransaction,
} from "./thread-message.ts";
import { asRecord, requiredText } from "./content-policy.ts";

export const THREAD_FEATURE_ID = "copilotz.core.thread";

async function create(input: unknown, context: FeatureContext) {
  const data = asRecord(input);
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
        context.collections,
        participant,
        undefined,
      ),
    );
  }
  const { participants: _participants, ...fields } = data;
  return await context.collections.thread.create({
    ...fields,
    ...(threadId ? { id: threadId } : {}),
    participantIds: ensured.map((participant) => participant.id),
    metadata: structuredClone(asRecord(data.metadata)),
  }, threadId ? { threadId } : undefined);
}

async function addParticipant(input: unknown, context: FeatureContext) {
  const data = asRecord(input);
  const threadId = requiredText(data.threadId, "Thread ID");
  const participant = asRecord(data.participant) as ParticipantInput;
  const ensured = await ensureParticipantInTransaction(
    context.collections,
    participant,
    threadId,
  );
  await addSenderToThreadInTransaction(
    context.collections,
    threadId,
    ensured.id,
  );
  return Object.freeze({
    thread: await context.collections.thread.get({ id: threadId }),
    participant: ensured,
  });
}

async function deleteMessages(input: unknown, context: FeatureContext) {
  const data = asRecord(input);
  const threadId = requiredText(data.threadId, "Thread ID");
  const messages = await context.collections.message.queries.byThreadId({
    threadId,
  });
  for (const message of messages) {
    await context.collections.message.delete({ id: message.id }, { threadId });
  }
  return Object.freeze({ threadId, deleted: true as const });
}

export const threadFeature: FeatureResource = Object.freeze({
  id: THREAD_FEATURE_ID,
  alias: "thread",
  actions: Object.freeze({ create, addParticipant, deleteMessages }),
});
