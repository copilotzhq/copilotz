/** Defines the canonical Core Message Collection. @module */

import { contentSequenceSchema } from "@copilotz/copilotz/content";
import {
  type CollectionContentOptions,
  type CollectionDefinition,
  type CollectionPredicate,
  defineCollection,
  relation,
} from "@copilotz/copilotz/collections";
import { metadataSchema, timestampsSchema } from "../../shared/schema.ts";
import type { MessageBranch, MessageRevision } from "../../shared/contracts.ts";

export type { MessageBranch, MessageRevision } from "../../shared/contracts.ts";
export { projectActiveMessageBranch } from "../../shared/projections.ts";

export type MessageRecord = Readonly<{
  id: string;
  revision?: MessageRevision;
}>;

type HistoryMessageRecord =
  & MessageRecord
  & Readonly<Record<string, unknown>>;

type MessageOrderKey = Readonly<{ createdAt: string; id: string }>;

function messageOrderKey(record: HistoryMessageRecord): MessageOrderKey {
  return ({
    createdAt: String(record.createdAt ?? ""),
    id: record.id,
  } as const);
}

function compareMessageOrder(
  left: MessageOrderKey,
  right: MessageOrderKey,
): number {
  const createdAt = left.createdAt.localeCompare(right.createdAt);
  return createdAt || left.id.localeCompare(right.id);
}

/** Selection runs in storage, before pagination and optional content reads. */
function publicHistoryFilter(
  viewers?: readonly string[],
  includePrivateToolStatuses = false,
): CollectionPredicate {
  const audience = viewers === undefined ? [] : [
    {
      or: [
        { field: "visibility.kind", exists: false },
        { field: "visibility.kind", eq: "public" },
        {
          and: [
            { field: "visibility.kind", eq: "tool" },
            {
              or: [
                {
                  field: "visibility.policy",
                  in: ["public", "public_status"],
                },
                { field: "visibility.requesterId", in: viewers },
              ],
            },
          ],
        },
        {
          and: [
            { field: "visibility.kind", eq: "participants" },
            { field: "visibility.participantIds", overlaps: viewers },
          ],
        },
        ...(includePrivateToolStatuses
          ? [
            {
              and: [
                { field: "visibility.kind", eq: "tool" },
                { field: "visibility.policy", eq: "requester_only" },
                // A result without these fields cannot be tied to a visible
                // invocation, so keep it out of the status projection scan.
                {
                  field: "metadata.toolStatus",
                  in: ["completed", "failed", "cancelled"],
                },
                { field: "metadata.toolInvocation.id", exists: true },
                {
                  field: "metadata.copilotzWorkflow.sourceMessageId",
                  exists: true,
                },
              ],
            } satisfies CollectionPredicate,
          ]
          : []),
      ],
    } satisfies CollectionPredicate,
  ];
  return {
    and: [
      {
        or: [
          { field: "historyScopeId", exists: false },
          { field: "historyScopeId", isNull: true },
          { field: "historyScopeId", isBlank: true },
        ],
      },
      { field: "visibility.kind", ne: "internal" },
      ...audience,
    ],
  };
}

function orderBoundary(
  key: MessageOrderKey,
  direction: "lt" | "gt",
): CollectionPredicate {
  return {
    or: [
      { field: "createdAt", [direction]: key.createdAt } as CollectionPredicate,
      {
        and: [
          { field: "createdAt", eq: key.createdAt },
          { field: "id", [direction]: key.id } as CollectionPredicate,
        ],
      },
    ],
  };
}

/** Public tool status never grants access to a result body or execution metadata. */
function projectHistoryRecord(
  record: HistoryMessageRecord,
  viewers?: readonly string[],
): HistoryMessageRecord {
  const visibility = record.visibility as Record<string, unknown> | undefined;
  if (
    !viewers || visibility?.kind !== "tool" ||
    visibility.policy !== "public_status" ||
    viewers.includes(String(visibility.requesterId))
  ) return record;
  const metadata = record.metadata as Record<string, unknown>;
  const invocation = metadata.toolInvocation as
    | Record<string, unknown>
    | undefined;
  const workflow = metadata.copilotzWorkflow as
    | Record<string, unknown>
    | undefined;
  const action = metadata.copilotzToolAction as
    | Record<string, unknown>
    | undefined;
  return {
    ...record,
    content: [],
    metadata: {
      toolStatus: metadata.toolStatus,
      toolId: metadata.toolId,
      toolInvocation: { id: invocation?.id, tool: { id: metadata.toolId } },
      copilotzWorkflow: { sourceMessageId: workflow?.sourceMessageId },
      copilotzToolAction: {
        actionRunId: action?.actionRunId,
        planMessageId: action?.planMessageId,
      },
    },
  };
}

function privateToolStatusCandidate(
  record: HistoryMessageRecord,
  viewers: readonly string[] | undefined,
): boolean {
  if (viewers === undefined) return false;
  const visibility = record.visibility as Record<string, unknown> | undefined;
  if (
    visibility?.kind !== "tool" || visibility.policy !== "requester_only" ||
    viewers.includes(String(visibility.requesterId))
  ) return false;
  return true;
}

function statusSourceId(record: HistoryMessageRecord): string | undefined {
  const metadata = record.metadata as Record<string, unknown> | undefined;
  const workflow = metadata?.copilotzWorkflow as
    | Record<string, unknown>
    | undefined;
  return typeof workflow?.sourceMessageId === "string"
    ? workflow.sourceMessageId
    : undefined;
}

function invocationIds(record: HistoryMessageRecord): ReadonlySet<string> {
  const metadata = record.metadata as Record<string, unknown> | undefined;
  const ids = new Set<string>();
  const toolCalls = metadata?.llmToolCalls;
  if (Array.isArray(toolCalls)) {
    for (const value of toolCalls) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        continue;
      }
      const id = (value as Record<string, unknown>).id;
      if (typeof id === "string" && id.trim()) ids.add(id);
    }
  }
  const ask = metadata?.copilotzAsk;
  const askInvocation = ask && typeof ask === "object" && !Array.isArray(ask)
    ? (ask as Record<string, unknown>).toolInvocation
    : undefined;
  const askId = askInvocation && typeof askInvocation === "object" &&
      !Array.isArray(askInvocation)
    ? (askInvocation as Record<string, unknown>).id
    : undefined;
  if (typeof askId === "string" && askId.trim()) ids.add(askId);
  const direct = metadata?.toolInvocation;
  const directId =
    direct && typeof direct === "object" && !Array.isArray(direct)
      ? (direct as Record<string, unknown>).id
      : undefined;
  if (typeof directId === "string" && directId.trim()) ids.add(directId);
  return ids;
}

/**
 * Projects a private result only when its public source Message advertises the
 * same invocation. The result itself is never used as authorization evidence.
 */
function projectPrivateToolStatus(
  record: HistoryMessageRecord,
  parent: HistoryMessageRecord,
): HistoryMessageRecord | undefined {
  const visibility = record.visibility as Record<string, unknown>;
  const metadata = record.metadata as Record<string, unknown>;
  const invocation = (metadata.toolInvocation ?? {}) as Record<string, unknown>;
  const sourceMessageId = statusSourceId(record);
  const projected = {
    ...record,
    visibility: {
      kind: "tool",
      policy: "public_status",
      requesterId: visibility.requesterId,
    },
  };
  // Keep the source lookup explicit so a future caller cannot accidentally
  // treat an unrelated private result as a public status row.
  if (
    typeof sourceMessageId !== "string" || sourceMessageId !== parent.id ||
    parent.senderId !== visibility.requesterId ||
    typeof invocation.id !== "string" ||
    !invocationIds(parent).has(invocation.id)
  ) return undefined;
  return projectHistoryRecord(projected, []);
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
  return ({
    root: rootKey,
    head: headKey,
    headMessageId: head.id,
  } as const);
}

/** Builds revision fields for a new `message.created` row. */
export function messageRevisionFrom(
  previous: MessageRecord,
  revisedAt: string,
): MessageRevision {
  return ({
    rootMessageId: previous.revision?.rootMessageId ?? previous.id,
    previousRevisionMessageId: previous.id,
    revisionIndex: (previous.revision?.revisionIndex ?? 0) + 1,
    revisedAt,
  } as const);
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
  content: {
    fields: [
      "content",
      "metadata.llmReasoning",
      "metadata.llmNativeReasoning.blocks",
    ],
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
      inputSchema: {
        type: "object",
        properties: {
          overfetch: { type: "boolean" },
          content: {
            anyOf: [
              { type: "boolean" },
              {
                type: "object",
                additionalProperties: false,
                properties: {
                  fields: { type: "array", items: { type: "string" } },
                  byteLimit: { type: "integer", minimum: 0 },
                },
              },
            ],
          },
        },
      },
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
        // HTTP callers supply trusted viewer identities, never client query authority.
        const viewers = Array.isArray(input.viewerParticipantIds)
          ? input.viewerParticipantIds.filter((id): id is string =>
            typeof id === "string"
          )
          : undefined;
        const filter: CollectionPredicate = {
          and: [
            publicHistoryFilter(viewers, true),
            ...(branch
              ? [
                {
                  or: [
                    orderBoundary(branch.root, "lt"),
                    { field: "id", eq: branch.headMessageId },
                    orderBoundary(branch.head, "gt"),
                  ],
                } satisfies CollectionPredicate,
              ]
              : []),
          ],
        };
        // Private results may reveal only a status for an invocation the viewer
        // already sees. Parent lookups use normal history authorization, never
        // the widened result scan, and never resolve content bodies.
        const visibleStatuses = async (
          records: readonly HistoryMessageRecord[],
        ) => {
          const candidates = records.filter((record) =>
            privateToolStatusCandidate(record, viewers)
          );
          if (!candidates.length) return records;
          const parentIds = [
            ...new Set(
              candidates.map(statusSourceId).filter(
                (id): id is string => id !== undefined,
              ),
            ),
          ];
          const parents = new Map<string, HistoryMessageRecord>();
          for (let offset = 0; offset < parentIds.length; offset += 512) {
            const batch = parentIds.slice(offset, offset + 512);
            const values = await read.list("message", {
              where: { threadId },
              filter: {
                and: [filter, publicHistoryFilter(viewers), {
                  field: "id",
                  in: batch,
                }],
              },
              limit: batch.length,
            }) as readonly HistoryMessageRecord[];
            for (const parent of values) parents.set(parent.id, parent);
          }
          return records.flatMap((record) => {
            if (!privateToolStatusCandidate(record, viewers)) return [record];
            const sourceId = statusSourceId(record);
            const parent = sourceId === undefined
              ? undefined
              : parents.get(sourceId);
            const status = parent
              ? projectPrivateToolStatus(record, parent)
              : undefined;
            return status ? [status] : [];
          });
        };
        // Select and redact first. Only unchanged, fully visible records may be
        // re-read with content; status-only records never enter that read.
        const finish = async (
          records: readonly HistoryMessageRecord[],
          contentLimit = records.length,
        ) => {
          const projected = records.map((record) =>
            projectHistoryRecord(record, viewers)
          );
          if (!input.content) return projected;
          const visible = records.filter((record, index) =>
            index < contentLimit && projected[index] === record
          );
          const resolved = new Map<string, HistoryMessageRecord>();
          for (let offset = 0; offset < visible.length; offset += 512) {
            const batch = visible.slice(offset, offset + 512);
            const values = await read.list("message", {
              where: { threadId },
              filter: {
                and: [
                  filter,
                  publicHistoryFilter(viewers),
                  ...(viewers
                    ? [{
                      not: {
                        and: [
                          { field: "visibility.kind", eq: "tool" },
                          { field: "visibility.policy", eq: "public_status" },
                          {
                            not: {
                              field: "visibility.requesterId",
                              in: viewers,
                            },
                          },
                        ],
                      },
                    }]
                    : []),
                  { field: "id", in: batch.map((record) => record.id) },
                ],
              },
              limit: batch.length,
            }, {
              content: input.content as CollectionContentOptions,
            }) as readonly HistoryMessageRecord[];
            const versions = new Map(
              batch.map((record) => [record.id, record.updatedAt]),
            );
            for (const value of values) {
              if (versions.get(value.id) !== value.updatedAt) {
                throw new Error(
                  "Message history changed during content preparation.",
                );
              }
              resolved.set(value.id, value);
            }
            if (values.length !== batch.length) {
              throw new Error(
                "Message history changed during content preparation.",
              );
            }
          }
          return projected.map((record) => resolved.get(record.id) ?? record);
        };
        // Exact reads use the same database predicate as pages and cursor validation.
        if (typeof input.messageId === "string") {
          const records = await read.list("message", {
            where: { threadId, id: input.messageId },
            filter,
            limit: 1,
          }) as readonly HistoryMessageRecord[];
          return await finish(await visibleStatuses(records));
        }
        const limit = Number(input.limit ?? 100);
        if (!Number.isSafeInteger(limit) || limit <= 0) {
          throw new TypeError(
            "Message history limit must be a positive integer.",
          );
        }
        // Event-native overfetches one record for exact pageInfo.hasMore.
        const selectedLimit = Math.min(
          limit + (input.overfetch === true ? 1 : 0),
          1_001,
        );
        const selected: HistoryMessageRecord[] = [];

        // Collection cursors already follow the requested sort direction.
        let scanAfter = after;
        while (selected.length < selectedLimit) {
          const batchLimit = Math.min(1_000, selectedLimit - selected.length);
          const page = await read.list("message", {
            where: { threadId },
            filter,
            order: { field: "createdAt", direction: order },
            ...(scanAfter ? { after: scanAfter } : {}),
            ...(before ? { before } : {}),
            limit: batchLimit,
          }) as readonly HistoryMessageRecord[];
          selected.push(...await visibleStatuses(page));
          if (page.length < batchLimit) break;
          const next = page.at(-1)?.id;
          if (!next || next === scanAfter) break;
          scanAfter = next;
        }
        return (await finish(selected, limit));
      },
    },
  },
});

export default messageCollection;
