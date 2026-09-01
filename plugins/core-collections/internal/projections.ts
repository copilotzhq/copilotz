/** Projects Core Collection records into public conversation values. @module */

import type {
  CollectionRecord,
  ScopedCollection,
} from "@copilotz/copilotz/collections";
import type { ContentSequence } from "@copilotz/copilotz/content";
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
  if (!Array.isArray(value)) return Object.freeze([]);
  return Object.freeze(
    value.filter((item): item is string =>
      typeof item === "string" && Boolean(item.trim())
    ),
  );
}

function contentSequence(value: unknown): ContentSequence {
  if (!Array.isArray(value)) return Object.freeze([]);
  return Object.freeze(value) as ContentSequence;
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
  anchor?: CollectionRecord;
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
  return Object.freeze([
    ...messages.slice(0, rootIndex),
    messages[headIndex],
    ...messages.slice(headIndex + 1),
  ]);
}

export function mapParticipantRecord(record: CollectionRecord): Participant {
  return Object.freeze({
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
  });
}

export function mapMessageRecord(
  record: CollectionRecord,
  sender: Participant,
): ConversationMessage {
  return Object.freeze({
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
  });
}

export function mapThreadRecord(
  record: CollectionRecord,
  participants: readonly Participant[],
): ConversationThread {
  return Object.freeze({
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
  });
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
  return Object.freeze(window.records.map((record) => {
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
  return Object.freeze({ root, head });
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
    visibleInHistoryScope(record, window.historyScopeId) &&
    activeInBranch(record, window.branch);
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
    historyScopeId?: string;
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
  const anchor = currentAnchor && String(currentAnchor.threadId) === threadId
    ? currentAnchor
    : undefined;
  const base = Object.freeze({
    threadRecord,
    participantRecords: Object.freeze([]),
    records: Object.freeze([]),
    anchorActive: options.anchor === undefined,
    ...(options.historyScopeId
      ? { historyScopeId: options.historyScopeId }
      : {}),
    ...(anchor ? { anchor } : {}),
    ...(branch ? { branch } : {}),
  }) satisfies ThreadMessageRecordWindow;
  const anchorActive = options.anchor === undefined || Boolean(
    anchor &&
      String(anchor.createdAt) === String(options.anchor.createdAt) &&
      threadMessageRecordInWindow(base, anchor),
  );

  const selected: CollectionRecord[] = [];
  if (anchorActive && anchor) selected.push(anchor);
  if (anchorActive) {
    const descending = Boolean(anchor || requestedLimit !== undefined);
    let cursor = anchor?.id;
    while (requestedLimit === undefined || selected.length < requestedLimit) {
      const page = await messages.list({
        where: { threadId },
        order: {
          field: "createdAt",
          direction: descending ? "desc" : "asc",
        },
        ...(cursor ? { after: cursor } : {}),
        limit: MESSAGE_PAGE_SIZE,
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
  const participantRecords = Object.freeze(
    (await Promise.all(
      [...participantIds].map((id) => participants.get({ id })),
    )).filter((record): record is CollectionRecord => record !== null),
  );
  return Object.freeze({
    threadRecord,
    participantRecords,
    records: Object.freeze(selected),
    anchorActive,
    ...(options.historyScopeId
      ? { historyScopeId: options.historyScopeId }
      : {}),
    ...(anchor ? { anchor } : {}),
    ...(branch ? { branch } : {}),
  });
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
