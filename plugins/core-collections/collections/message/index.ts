/** Defines the canonical Core Message Collection. @module */

import {
  type CollectionDefinition,
  defineCollection,
  relation,
} from "@copilotz/copilotz/collections";
import {
  contentSequenceSchema,
  metadataSchema,
  timestampsSchema,
} from "../internal/schema.ts";
import type {
  MessageBranch,
  MessageRevision,
} from "../../internal/contracts.ts";
import { projectActiveMessageBranch } from "../../internal/projections.ts";

export type {
  MessageBranch,
  MessageRevision,
} from "../../internal/contracts.ts";
export { projectActiveMessageBranch } from "../../internal/projections.ts";

export type MessageRecord = Readonly<{
  id: string;
  revision?: MessageRevision;
}>;

type HistoryMessageRecord =
  & MessageRecord
  & Readonly<Record<string, unknown>>;

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
      visibility: { type: "object" },
      historyScopeId: { type: "string" },
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
        }) as readonly HistoryMessageRecord[];
        const thread = await read.get("thread", threadId);
        const projected = input.view === "all"
          ? records
          : projectActiveMessageBranch(
            records,
            thread?.activeMessageBranch as MessageBranch | undefined,
          );
        // Public collection history excludes all internal/scoped messages.
        // Core's private raw readers apply their own exact-scope policy.
        const visible = projected.filter((message) => {
          const scope = typeof message.historyScopeId === "string" &&
              message.historyScopeId.trim()
            ? message.historyScopeId.trim()
            : undefined;
          const visibility =
            message.visibility && typeof message.visibility === "object"
              ? message.visibility as Record<string, unknown>
              : {};
          return !scope && visibility.kind !== "internal";
        });
        let bounded = [...visible];
        const cursorId = after ?? before;
        if (cursorId) {
          const cursor = visible.findIndex((message) =>
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
