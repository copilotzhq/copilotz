import type { DurableContentInput } from "@copilotz/copilotz/content";
import type {
  FeatureContext,
  FeatureResource,
} from "@copilotz/copilotz/features";
import type { EventVisibility } from "@copilotz/copilotz/events";
import { asRecord, contentSequence, requiredText } from "./content-policy.ts";

export const MESSAGE_FEATURE_ID = "copilotz.core.message";

async function revise(input: unknown, context: FeatureContext) {
  const data = asRecord(input);
  const id = requiredText(data.id, "Message revision ID");
  const threadId = requiredText(data.threadId, "Thread ID");
  const previousId = requiredText(data.messageId, "Message ID");
  const previous = await context.collections.message.get({ id: previousId });
  if (!previous) throw new Error(`Message '${previousId}' was not found.`);
  if (previous.threadId !== threadId) {
    throw new Error(
      `Message '${previousId}' does not belong to thread '${threadId}'.`,
    );
  }
  const sender = await context.collections.participant.get({
    id: requiredText(previous.senderId, "Message sender ID"),
  });
  if (!sender) throw new Error(`Message '${previousId}' sender was not found.`);
  if (sender.participantType !== "human") {
    throw new Error("Only human messages can be revised.");
  }
  const existing = await context.collections.message.get({ id });
  const priorRevision = asRecord(previous.revision);
  const existingRevision = asRecord(existing?.revision);
  const revision = Object.freeze({
    rootMessageId: typeof priorRevision.rootMessageId === "string"
      ? priorRevision.rootMessageId
      : previous.id,
    previousRevisionMessageId: previous.id,
    revisionIndex: Number(priorRevision.revisionIndex ?? 0) + 1,
    revisedAt: typeof existingRevision.revisedAt === "string"
      ? existingRevision.revisedAt
      : new Date().toISOString(),
  });
  const supplied = data.content as DurableContentInput | undefined;
  if (supplied === undefined) {
    throw new TypeError("Edited content is required.");
  }
  const materialized = !Array.isArray(supplied);
  const content = !materialized
    ? contentSequence(supplied)
    : await context.content.materialize(supplied, {
      origin: {
        scope: { type: "thread", id: threadId },
        producer: { type: "message", id },
      },
    });
  const recipientIds = Array.isArray(previous.recipientIds)
    ? previous.recipientIds.filter((value): value is string =>
      typeof value === "string"
    )
    : [];
  const created = await context.collections.message.create({
    id,
    threadId,
    senderId: sender.id,
    recipientIds,
    content,
    metadata: structuredClone(
      Object.keys(asRecord(data.metadata)).length
        ? asRecord(data.metadata)
        : asRecord(previous.metadata),
    ),
    revision,
  }, {
    threadId,
    routing: { senderId: sender.id, recipientIds },
    visibility: (data.visibility as EventVisibility | undefined) ?? {
      kind: "public",
    },
  });
  await context.collections.thread.update({
    id: threadId,
    set: {
      activeMessageBranch: {
        rootMessageId: revision.rootMessageId,
        headMessageId: id,
        previousRevisionMessageId: previous.id,
        revisionIndex: revision.revisionIndex,
      },
    },
  }, { threadId });
  if (materialized && content.length) {
    await context.content.linkOwner(id, content);
  }
  return Object.freeze({
    message: created,
    rootMessageId: revision.rootMessageId,
    previousRevisionMessageId: previous.id,
    revisionIndex: revision.revisionIndex,
  });
}

export const messageFeature: FeatureResource = Object.freeze({
  id: MESSAGE_FEATURE_ID,
  alias: "message",
  actions: Object.freeze({ revise }),
});
