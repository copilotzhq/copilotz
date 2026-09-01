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

type MessageOrderKey = Readonly<{ createdAt: string; id: string }>;

function messageOrderKey(record: HistoryMessageRecord): MessageOrderKey {
  return Object.freeze({
    createdAt: String(record.createdAt ?? ""),
    id: record.id,
  });
}

function compareMessageOrder(
  left: MessageOrderKey,
  right: MessageOrderKey,
): number {
  const createdAt = left.createdAt.localeCompare(right.createdAt);
  return createdAt || left.id.localeCompare(right.id);
}

function isPublicHistoryMessage(record: HistoryMessageRecord): boolean {
  const scope = typeof record.historyScopeId === "string"
    ? record.historyScopeId.trim()
    : "";
  const visibility = record.visibility && typeof record.visibility === "object"
    ? record.visibility as Record<string, unknown>
    : {};
  return !scope && visibility.kind !== "internal";
}

type ActiveBranchWindow = Readonly<{
  root: MessageOrderKey;
  head: MessageOrderKey;
  headMessageId: string;
}>;

async function activeBranchWindow(
  read: Parameters<
    NonNullable<
      NonNullable<typeof messageCollection.queries>[string]["select"]
    >
  >[0]["read"],
  threadId: string,
  branch: MessageBranch | undefined,
): Promise<ActiveBranchWindow | undefined> {
  if (!branch) return undefined;
  const [root, head] = await Promise.all([
    read.get("message", branch.rootMessageId),
    read.get("message", branch.headMessageId),
  ]) as readonly (HistoryMessageRecord | null)[];
  if (
    !root || !head || root.threadId !== threadId || head.threadId !== threadId
  ) return undefined;
  const rootKey = messageOrderKey(root);
  const headKey = messageOrderKey(head);
  if (compareMessageOrder(rootKey, headKey) >= 0) return undefined;
  return Object.freeze({
    root: rootKey,
    head: headKey,
    headMessageId: head.id,
  });
}

function belongsToActiveBranch(
  record: HistoryMessageRecord,
  branch: ActiveBranchWindow | undefined,
): boolean {
  if (!branch) return true;
  const key = messageOrderKey(record);
  return compareMessageOrder(key, branch.root) < 0 ||
    record.id === branch.headMessageId ||
    compareMessageOrder(key, branch.head) > 0;
}

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
        const thread = await read.get("thread", threadId);
        const branch = input.view === "all"
          ? undefined
          : await activeBranchWindow(
            read,
            threadId,
            thread?.activeMessageBranch as MessageBranch | undefined,
          );
        const cursorId = after ?? before;
        if (cursorId) {
          const cursor = await read.get("message", cursorId) as
            | HistoryMessageRecord
            | null;
          if (
            !cursor || cursor.threadId !== threadId ||
            !isPublicHistoryMessage(cursor) ||
            !belongsToActiveBranch(cursor, branch)
          ) {
            throw new Error(
              `Message cursor '${cursorId}' was not found in the ${
                input.view === "all" ? "all" : "active"
              } history for thread '${threadId}'.`,
            );
          }
        }
        const limit = Number(input.limit ?? 100);
        if (!Number.isSafeInteger(limit) || limit <= 0) {
          throw new TypeError(
            "Message history limit must be a positive integer.",
          );
        }
        // Event-native overfetches one record for exact pageInfo.hasMore.
        const selectedLimit = Math.min(limit, 1_001);
        const selected: HistoryMessageRecord[] = [];
        const batchLimit = 1_000;
        const chronologicalAfter = order === "asc" ? after : before;
        const chronologicalBefore = order === "asc" ? before : after;
        let scanAfter = chronologicalAfter;
        while (selected.length < selectedLimit) {
          const page = await read.list("message", {
            where: { threadId },
            order: { field: "createdAt", direction: order },
            ...(scanAfter ? { after: scanAfter } : {}),
            ...(chronologicalBefore ? { before: chronologicalBefore } : {}),
            limit: batchLimit,
          }) as readonly HistoryMessageRecord[];
          for (const record of page) {
            if (
              isPublicHistoryMessage(record) &&
              belongsToActiveBranch(record, branch)
            ) {
              selected.push(record);
              if (selected.length === selectedLimit) break;
            }
          }
          if (page.length < batchLimit) break;
          const next = page.at(-1)?.id;
          if (!next || next === scanAfter) break;
          scanAfter = next;
        }
        return Object.freeze(selected);
      },
    },
  },
});
