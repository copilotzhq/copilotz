import type { DurableContentInput } from "@copilotz/copilotz/content";
import type { CollectionRecord } from "@copilotz/copilotz/collections";
import {
  defineFeature,
  type FeatureAction,
  type FeatureDefinition,
  type FeatureExecuteContext,
} from "@copilotz/copilotz/features";
import type { EventVisibility } from "@copilotz/copilotz/events";
import { asRecord, requiredText } from "./content-policy.ts";

export const MESSAGE_FEATURE_ID = "copilotz.core.message";

type MessageRevisionResult = Readonly<{
  message: CollectionRecord;
  rootMessageId: string;
  previousRevisionMessageId: string;
  revisionIndex: number;
}>;

async function revise(
  input: unknown,
  context: FeatureExecuteContext,
): Promise<MessageRevisionResult> {
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
  const recipientIds = Array.isArray(previous.recipientIds)
    ? previous.recipientIds.filter((value): value is string =>
      typeof value === "string"
    )
    : [];
  return await context.transaction(async (tx) => {
    const supplied = data.content as DurableContentInput | undefined;
    if (supplied === undefined) {
      throw new TypeError("Edited content is required.");
    }
    const created = await tx.collections.message.create({
      id,
      threadId,
      senderId: sender.id,
      recipientIds,
      content: supplied,
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
    await tx.collections.thread.update({
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
    return Object.freeze({
      message: created,
      rootMessageId: revision.rootMessageId,
      previousRevisionMessageId: previous.id,
      revisionIndex: revision.revisionIndex,
    });
  });
}

const reviseInput = {
  type: "object",
  additionalProperties: true,
  properties: {
    id: { type: "string" },
    threadId: { type: "string" },
    messageId: { type: "string" },
    content: {},
    metadata: { type: "object" },
    visibility: { type: "object" },
  },
  required: ["id", "threadId", "messageId", "content"],
} as const;

type MessageFeature = FeatureDefinition<{
  revise: FeatureAction<
    typeof reviseInput,
    MessageRevisionResult
  >;
}>;

const messageFeatureDefinition: MessageFeature = defineFeature({
  id: MESSAGE_FEATURE_ID,
  actions: {
    revise: {
      inputSchema: reviseInput,
      execute: revise,
    },
  },
});

export const messageFeature: MessageFeature = messageFeatureDefinition;
