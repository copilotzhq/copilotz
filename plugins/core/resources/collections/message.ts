import {
  defineCollection,
  relation,
  type CollectionDefinition,
} from "@copilotz/copilotz/collections";
import {
  contentSequenceSchema,
  metadataSchema,
  timestampsSchema,
} from "./schema.ts";

export type MessageRevision = Readonly<{
  rootMessageId: string;
  previousRevisionMessageId: string;
  revisionIndex: number;
  revisedAt: string;
}>;

export type MessageBranch = Readonly<{
  rootMessageId: string;
  headMessageId: string;
  previousRevisionMessageId: string;
  revisionIndex: number;
}>;

export type MessageRecord = Readonly<{
  id: string;
  revision?: MessageRevision;
}>;

/** Builds revision fields for a new `message.created` row. */
export function messageRevisionFrom(
  previous: MessageRecord,
  revisedAt: string,
): MessageRevision {
  return Object.freeze({
    rootMessageId: previous.revision?.rootMessageId ?? previous.id,
    previousRevisionMessageId: previous.id,
    revisionIndex: (previous.revision?.revisionIndex ?? 0) + 1,
    revisedAt,
  });
}

/** Active-branch view over a thread's messages. Not a conversation helper. */
export function projectActiveMessageBranch<T extends MessageRecord>(
  messages: readonly T[],
  branch: MessageBranch | undefined,
): readonly T[] {
  if (!branch) return messages;
  const rootIndex = messages.findIndex((message) =>
    message.id === branch.rootMessageId
  );
  const headIndex = messages.findIndex((message) =>
    message.id === branch.headMessageId
  );
  if (rootIndex < 0 || headIndex <= rootIndex) return messages;
  return Object.freeze([
    ...messages.slice(0, rootIndex),
    messages[headIndex],
    ...messages.slice(headIndex + 1),
  ]);
}

export const messageCollection: CollectionDefinition = defineCollection({
  name: "message",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      id: { type: "string" },
      namespace: { type: "string" },
      threadId: { type: "string" },
      senderId: { type: "string" },
      recipientIds: {
        type: "array",
        items: { type: "string" },
      },
      content: contentSequenceSchema,
      metadata: metadataSchema,
      revision: {
        type: "object",
        additionalProperties: false,
        properties: {
          rootMessageId: { type: "string" },
          previousRevisionMessageId: { type: "string" },
          revisionIndex: { type: "integer" },
          revisedAt: { type: "string" },
        },
        required: [
          "rootMessageId",
          "previousRevisionMessageId",
          "revisionIndex",
          "revisedAt",
        ],
      },
      ...timestampsSchema,
    },
    required: [
      "id",
      "namespace",
      "threadId",
      "senderId",
      "recipientIds",
      "content",
      "metadata",
      "createdAt",
      "updatedAt",
    ],
  } as const,
  defaults: {
    recipientIds: [],
    content: [],
    metadata: {},
  },
  identity: {
    sourceType: "thread",
    sourceField: "threadId",
  },
  relations: {
    thread: relation.belongsTo("thread", "threadId", "has_message"),
    sender: relation.belongsTo("participant", "senderId", "sent_by"),
  },
  queries: {
    byThreadId: {
      filter({ input }) {
        return { threadId: String(input.threadId ?? "") };
      },
    },
    revisions: {
      filter({ input }) {
        return {
          "revision.rootMessageId": String(input.rootMessageId ?? ""),
        };
      },
    },
  },
});
