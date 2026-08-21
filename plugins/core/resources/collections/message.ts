import {
  type CollectionDefinition,
  defineCollection,
  relation,
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
  content: { fields: ["content"] },
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
    history: {
      async select({ input, read }) {
        const threadId = String(input.threadId ?? "").trim();
        if (!threadId) throw new TypeError("Thread ID must be non-empty.");
        const after = typeof input.after === "string" && input.after.trim()
          ? input.after.trim()
          : undefined;
        const before = typeof input.before === "string" && input.before.trim()
          ? input.before.trim()
          : undefined;
        if (after && before) {
          throw new TypeError(
            "Message history accepts either after or before, not both.",
          );
        }
        const order = input.order === "desc" ? "desc" : "asc";
        const records = await read.list("message", {
          where: { threadId },
          order: { field: "createdAt", direction: "asc" },
          limit: 1_000,
        }) as readonly MessageRecord[];
        const thread = await read.get("thread", threadId);
        const projected = input.view === "all"
          ? records
          : projectActiveMessageBranch(
            records,
            thread?.activeMessageBranch as MessageBranch | undefined,
          );
        let bounded = [...projected];
        const cursorId = after ?? before;
        if (cursorId) {
          const cursor = projected.findIndex((message) =>
            message.id === cursorId
          );
          if (cursor < 0) {
            throw new Error(
              `Message cursor '${cursorId}' was not found in the ${
                input.view === "all" ? "all" : "active"
              } history for thread '${threadId}'.`,
            );
          }
          bounded = after
            ? bounded.slice(cursor + 1)
            : bounded.slice(0, cursor);
        }
        if (order === "desc") bounded.reverse();
        const limit = Number(input.limit ?? 100);
        if (!Number.isSafeInteger(limit) || limit <= 0) {
          throw new TypeError(
            "Message history limit must be a positive integer.",
          );
        }
        return Object.freeze(bounded.slice(0, Math.min(limit, 1_000)));
      },
    },
  },
});
