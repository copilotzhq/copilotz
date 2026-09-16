/** Projects Core Collection records into public conversation values. @module */

import type {
  CollectionPredicate,
  CollectionRecord,
  ScopedCollection,
} from "@copilotz/copilotz/collections";
import { type ContentSequence, isContentRef } from "@copilotz/copilotz/content";
import type { ProcessorContext } from "@copilotz/copilotz/plugins";
import type {
  ConversationMessage,
  ConversationThread,
  MessageBranch,
  Participant,
} from "./contracts.ts";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return ([] as const);
  return (value.filter((item): item is string =>
    typeof item === "string" && Boolean(item.trim())
  ));
}

function contentSequence(value: unknown): ContentSequence {
  if (!Array.isArray(value)) return ([] as const);
  if (!value.every(isContentRef)) {
    throw new TypeError("Message content contains invalid reference metadata.");
  }
  return value;
}

function requireScopedCollection(
  context: Pick<ProcessorContext, "collections">,
  name: string,
): ScopedCollection {
  const bound = context.collections[name];
  if (!bound) throw new Error(`Collection '${name}' is not bound.`);
  return bound;
}

const MESSAGE_PAGE_SIZE = 1_000;

export type ActiveBranchBounds = Readonly<{
  root: CollectionRecord;
  head: CollectionRecord;
}>;

/** One stable, authorized Message window before Core-specific transcript rules. */
export type ThreadMessageRecordWindow = Readonly<{
  threadRecord: CollectionRecord;
  participantRecords: readonly CollectionRecord[];
  records: readonly CollectionRecord[];
  anchorActive: boolean;
  historyScopeId?: string;
  internalOnly?: boolean;
  viewerIds?: readonly string[];
  anchor?: CollectionRecord;
  after?: CollectionRecord;
  from?: CollectionRecord;
  branch?: ActiveBranchBounds;
}>;

/** Stable chronological Message ordering used by Collection keyset reads. */
export function compareThreadMessageRecords(
  left: Pick<CollectionRecord, "id" | "createdAt">,
  right: Pick<CollectionRecord, "id" | "createdAt">,
): number {
  const created = String(left.createdAt).localeCompare(String(right.createdAt));
  return created || String(left.id).localeCompare(String(right.id));
}

/** Active-branch view over a thread's messages. */
export function projectActiveMessageBranch<T extends { id: string }>(
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
  return ([
    ...messages.slice(0, rootIndex),
    messages[headIndex],
    ...messages.slice(headIndex + 1),
  ] as const);
}

export function mapParticipantRecord(record: CollectionRecord): Participant {
  return ({
    id: String(record.id),
    namespace: String(record.namespace),
    externalId: String(record.externalId ?? record.id),
    participantType: record.participantType as Participant["participantType"],
    ...(optionalText(record.name) ? { name: optionalText(record.name) } : {}),
    ...(optionalText(record.email)
      ? { email: optionalText(record.email) }
      : {}),
    ...(optionalText(record.agentId)
      ? { agentId: optionalText(record.agentId) }
      : {}),
    metadata: asRecord(record.metadata),
    createdAt: String(record.createdAt),
    updatedAt: String(record.updatedAt),
  } as const);
}

/** Preserve prepared content and reasoning types through the same message projection. */
export function mapMessageRecord<
  Content extends ContentSequence,
  Metadata extends Readonly<Record<string, unknown>>,
>(
  record: CollectionRecord & { content: Content; metadata: Metadata },
  sender: Participant,
): ConversationMessage<Content, Metadata>;
export function mapMessageRecord<Content extends ContentSequence>(
  record: CollectionRecord & { content: Content },
  sender: Participant,
): ConversationMessage<Content>;
export function mapMessageRecord(
  record: CollectionRecord,
  sender: Participant,
): ConversationMessage;
export function mapMessageRecord(
  record: CollectionRecord,
  sender: Participant,
): ConversationMessage {
  return ({
    id: String(record.id),
    namespace: String(record.namespace),
    threadId: String(record.threadId),
    sender,
    recipientIds: stringArray(record.recipientIds),
    content: contentSequence(record.content),
    metadata: asRecord(record.metadata),
    ...(record.revision && typeof record.revision === "object"
      ? { revision: record.revision as ConversationMessage["revision"] }
      : {}),
    createdAt: String(record.createdAt),
    updatedAt: String(record.updatedAt),
  } as const);
}

export function mapThreadRecord(
  record: CollectionRecord,
  participants: readonly Participant[],
): ConversationThread {
  return ({
    id: String(record.id),
    namespace: String(record.namespace),
    ...(optionalText(record.externalId)
      ? { externalId: optionalText(record.externalId) }
      : {}),
    ...(optionalText(record.name) ? { name: optionalText(record.name) } : {}),
    ...(optionalText(record.description)
      ? { description: optionalText(record.description) }
      : {}),
    status: String(record.status ?? "active"),
    ...(optionalText(record.parentThreadId)
      ? { parentThreadId: optionalText(record.parentThreadId) }
      : {}),
    metadata: asRecord(record.metadata),
    participants,
    ...(record.activeMessageBranch &&
        typeof record.activeMessageBranch === "object"
      ? {
        activeMessageBranch: record
          .activeMessageBranch as ConversationThread["activeMessageBranch"],
      }
      : {}),
    ...(optionalText(record.lastEventId)
      ? { lastEventId: optionalText(record.lastEventId) }
      : {}),
    ...(optionalText(record.lastEventPosition)
      ? { lastEventPosition: optionalText(record.lastEventPosition) }
      : {}),
    ...(optionalText(record.lastEventAt)
      ? { lastEventAt: optionalText(record.lastEventAt) }
      : {}),
    createdAt: String(record.createdAt),
    updatedAt: String(record.updatedAt),
  } as const);
}

export async function loadParticipantRecord(
  context: Pick<ProcessorContext, "collections">,
  id: string,
): Promise<Participant | null> {
  const bound = context.collections.participant;
  if (!bound) return null;
  const record = await bound.get({ id });
  return record ? mapParticipantRecord(record) : null;
}

export async function loadThreadRecord(
  context: Pick<ProcessorContext, "collections">,
  threadId: string,
): Promise<ConversationThread | null> {
  const threads = context.collections.thread;
  const participants = context.collections.participant;
  if (!threads || !participants) return null;
  const record = await threads.get({ id: threadId });
  if (!record) return null;
  const loaded = await Promise.all(
    stringArray(record.participantIds).map((id) => participants.get({ id })),
  );
  return mapThreadRecord(
    record,
    loaded.filter((item): item is CollectionRecord => item !== null).map(
      mapParticipantRecord,
    ),
  );
}

export async function listThreadMessageRecords(
  context: Pick<ProcessorContext, "collections">,
  threadId: string,
  options: Readonly<{ historyScopeId?: string }> = {},
): Promise<readonly ConversationMessage[]> {
  const window = await loadThreadMessageRecordWindow(context, threadId, {
    ...(options.historyScopeId
      ? { historyScopeId: options.historyScopeId }
      : {}),
  });
  const participants = new Map(
    window.participantRecords.map((record) => [
      record.id,
      mapParticipantRecord(record),
    ]),
  );
  return (window.records.map((record) => {
    const sender = participants.get(String(record.senderId));
    if (!sender) {
      throw new Error(`Message '${record.id}' sender was not found.`);
    }
    return mapMessageRecord(record, sender);
  }));
}

async function activeBranchBounds(
  messages: ScopedCollection,
  threadId: string,
  thread: CollectionRecord,
): Promise<ActiveBranchBounds | undefined> {
  const branch = asRecord(thread.activeMessageBranch);
  const rootId = optionalText(branch.rootMessageId);
  const headId = optionalText(branch.headMessageId);
  if (!rootId || !headId) return undefined;
  const [root, head] = await Promise.all([
    messages.get({ id: rootId }),
    messages.get({ id: headId }),
  ]);
  if (
    !root || !head || String(root.threadId) !== threadId ||
    String(head.threadId) !== threadId ||
    compareThreadMessageRecords(head, root) <= 0
  ) return undefined;
  return ({ root, head } as const);
}

function activeInBranch(
  record: CollectionRecord,
  branch: ActiveBranchBounds | undefined,
): boolean {
  if (!branch) return true;
  return compareThreadMessageRecords(record, branch.root) < 0 ||
    compareThreadMessageRecords(record, branch.head) >= 0;
}

/** Private Core reader policy; the public history query never exposes scopes. */
function visibleInHistoryScope(
  record: CollectionRecord,
  historyScopeId?: string,
): boolean {
  const scope = optionalText(record.historyScopeId);
  const visibility = asRecord(record.visibility);
  if (!scope) return visibility.kind !== "internal";
  return historyScopeId === scope && visibility.kind === "internal";
}

/** Whether an exact dependency belongs to a previously authorized window. */
export function threadMessageRecordInWindow(
  window: ThreadMessageRecordWindow,
  record: CollectionRecord,
): boolean {
  return String(record.threadId) === String(window.threadRecord.id) &&
    (!window.anchor ||
      compareThreadMessageRecords(record, window.anchor) <= 0) &&
    (!window.after || compareThreadMessageRecords(record, window.after) > 0) &&
    (!window.from || compareThreadMessageRecords(record, window.from) >= 0) &&
    (!window.internalOnly || asRecord(record.visibility).kind === "internal") &&
    visibleInHistoryScope(record, window.historyScopeId) &&
    activeInBranch(record, window.branch);
}

/** Storage predicate matching the private window's scope, branch and immutable anchor. */
export function threadMessageWindowFilter(
  window: ThreadMessageRecordWindow,
): CollectionPredicate {
  const boundary = (
    record: CollectionRecord,
    op: "lt" | "gte" | "lte",
  ): CollectionPredicate => ({
    or: [
      {
        field: "createdAt",
        ...(op === "gte"
          ? { gt: String(record.createdAt) }
          : { lt: String(record.createdAt) }),
      },
      {
        and: [{ field: "createdAt", eq: String(record.createdAt) }, {
          field: "id",
          ...(op === "gte"
            ? { gte: record.id }
            : op === "lte"
            ? { lte: record.id }
            : { lt: record.id }),
        }],
      },
    ],
  });
  const publicScope: CollectionPredicate = {
    and: [
      {
        or: [{ field: "historyScopeId", exists: false }, {
          field: "historyScopeId",
          isNull: true,
        }, { field: "historyScopeId", isBlank: true }],
      },
      { field: "visibility.kind", ne: "internal" },
    ],
  };
  return {
    and: [
      { field: "threadId", eq: String(window.threadRecord.id) },
      {
        or: [
          ...(window.internalOnly ? [] : [publicScope]),
          ...(window.historyScopeId
            ? [
              {
                and: [{
                  field: "historyScopeId",
                  trimEq: window.historyScopeId,
                }, { field: "visibility.kind", eq: "internal" }],
              } satisfies CollectionPredicate,
            ]
            : []),
        ],
      },
      ...(window.branch
        ? [
          {
            or: [
              boundary(window.branch.root, "lt"),
              boundary(window.branch.head, "gte"),
            ],
          } satisfies CollectionPredicate,
        ]
        : []),
      ...(window.anchor ? [boundary(window.anchor, "lte")] : []),
      ...(window.from ? [boundary(window.from, "gte")] : []),
      ...(window.after
        ? [
          {
            or: [{ field: "createdAt", gt: String(window.after.createdAt) }, {
              and: [
                { field: "createdAt", eq: String(window.after.createdAt) },
                { field: "id", gt: window.after.id },
              ],
            }],
          } satisfies CollectionPredicate,
        ]
        : []),
      ...(window.viewerIds?.length
        ? [
          {
            or: [
              ...(window.historyScopeId
                ? [
                  {
                    and: [
                      { field: "visibility.kind", eq: "internal" },
                      {
                        field: "historyScopeId",
                        trimEq: window.historyScopeId,
                      },
                      {
                        or: [{ field: "senderId", in: window.viewerIds }, {
                          field: "recipientIds",
                          overlaps: window.viewerIds,
                        }],
                      },
                    ],
                  } satisfies CollectionPredicate,
                ]
                : []),
              { field: "visibility.kind", exists: false },
              { field: "visibility.kind", eq: "public" },
              {
                and: [{ field: "visibility.kind", eq: "participants" }, {
                  field: "visibility.participantIds",
                  overlaps: window.viewerIds,
                }],
              },
              {
                and: [{ field: "visibility.kind", eq: "tool" }, {
                  or: [{
                    field: "visibility.policy",
                    in: ["public", "public_status"],
                  }, { field: "visibility.requesterId", in: window.viewerIds }],
                }],
              },
            ],
          } satisfies CollectionPredicate,
        ]
        : []),
    ],
  };
}

/**
 * Loads a chronological active-history window. Selection runs newest-first so
 * the bounded result is the latest history through the immutable anchor; only
 * presentation is reversed to chronological order.
 */
export async function loadThreadMessageRecordWindow(
  context: Pick<ProcessorContext, "collections">,
  threadId: string,
  options: Readonly<{
    anchor?: CollectionRecord;
    after?: CollectionRecord;
    from?: CollectionRecord;
    historyScopeId?: string;
    internalOnly?: boolean;
    viewerIds?: readonly string[];
    limit?: number;
  }> = {},
): Promise<ThreadMessageRecordWindow> {
  const messages = requireScopedCollection(context, "message");
  const participants = requireScopedCollection(context, "participant");
  const threads = requireScopedCollection(context, "thread");
  const threadRecord = await threads.get({ id: threadId });
  if (!threadRecord) throw new Error(`Thread '${threadId}' was not found.`);
  const branch = await activeBranchBounds(messages, threadId, threadRecord);
  const requestedLimit = options.limit;
  if (
    requestedLimit !== undefined &&
    (!Number.isSafeInteger(requestedLimit) || requestedLimit <= 0)
  ) {
    throw new TypeError("Message window limit must be a positive integer.");
  }

  const currentAnchor = options.anchor
    ? await messages.get({ id: options.anchor.id })
    : undefined;
  const from = options.from
    ? await messages.get({ id: options.from.id })
    : undefined;
  if (options.from && (!from || String(from.threadId) !== threadId)) {
    throw new Error("Message range start is no longer available.");
  }
  const currentAfter = options.after
    ? await messages.get({ id: options.after.id })
    : undefined;
  const after = currentAfter && String(currentAfter.threadId) === threadId
    ? currentAfter
    : undefined;
  const anchor = currentAnchor && String(currentAnchor.threadId) === threadId
    ? currentAnchor
    : undefined;
  const base = ({
    threadRecord,
    participantRecords: [] as const,
    records: [] as const,
    anchorActive: options.anchor === undefined,
    ...(options.historyScopeId
      ? { historyScopeId: options.historyScopeId }
      : {}),
    ...(options.internalOnly ? { internalOnly: true } : {}),
    ...(options.viewerIds?.length
      ? { viewerIds: [...options.viewerIds] as const }
      : {}),
    ...(anchor ? { anchor } : {}),
    ...(after ? { after } : {}),
    ...(from ? { from } : {}),
    ...(branch ? { branch } : {}),
  } as const) satisfies ThreadMessageRecordWindow;
  let anchorActive = options.anchor === undefined || Boolean(
    anchor &&
      String(anchor.createdAt) === String(options.anchor.createdAt) &&
      threadMessageRecordInWindow(base, anchor),
  );

  const selected: CollectionRecord[] = [];
  if (anchorActive && anchor) {
    // Anchors must pass the same storage authorization predicate as paged rows.
    const [authorized] = await messages.list({
      where: { id: anchor.id },
      filter: threadMessageWindowFilter(base),
      limit: 1,
    });
    anchorActive = Boolean(authorized);
    if (authorized) selected.push(authorized);
  }
  if (anchorActive) {
    const descending = Boolean(anchor || requestedLimit !== undefined);
    let cursor = anchor?.id;
    while (requestedLimit === undefined || selected.length < requestedLimit) {
      const page = await messages.list({
        filter: threadMessageWindowFilter(base),
        order: {
          field: "createdAt",
          direction: descending ? "desc" : "asc",
        },
        ...(cursor ? { after: cursor } : {}),
        limit: Math.min(
          MESSAGE_PAGE_SIZE,
          requestedLimit === undefined
            ? MESSAGE_PAGE_SIZE
            : requestedLimit - selected.length,
        ),
      });
      if (!page.length) break;
      for (const record of page) {
        if (threadMessageRecordInWindow(base, record)) selected.push(record);
        if (
          requestedLimit !== undefined && selected.length >= requestedLimit
        ) break;
      }
      const next = page.at(-1)?.id;
      if (!next || next === cursor || page.length < MESSAGE_PAGE_SIZE) break;
      cursor = next;
    }
    if (descending) selected.reverse();
  }

  const participantIds = new Set([
    ...stringArray(threadRecord.participantIds),
    ...selected.map((record) => String(record.senderId)),
  ]);
  const participantRecords = (await Promise.all(
    [...participantIds].map((id) => participants.get({ id })),
  )).filter((record): record is CollectionRecord => record !== null);
  return ({
    threadRecord,
    participantRecords,
    records: selected,
    anchorActive,
    ...(options.historyScopeId
      ? { historyScopeId: options.historyScopeId }
      : {}),
    ...(options.internalOnly ? { internalOnly: true } : {}),
    ...(options.viewerIds?.length
      ? { viewerIds: [...options.viewerIds] as const }
      : {}),
    ...(anchor ? { anchor } : {}),
    ...(after ? { after } : {}),
    ...(from ? { from } : {}),
    ...(branch ? { branch } : {}),
  } as const);
}

export async function loadMessageRecord(
  context: Pick<ProcessorContext, "collections">,
  id: string,
): Promise<ConversationMessage | null> {
  const record = await requireScopedCollection(context, "message").get({ id });
  if (!record) return null;
  const sender = await requireScopedCollection(context, "participant").get({
    id: String(record.senderId),
  });
  if (!sender) throw new Error(`Message '${id}' sender was not found.`);
  return mapMessageRecord(record, mapParticipantRecord(sender));
}
