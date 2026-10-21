import type {
  BrowserViewContext,
  ClientCollection,
  ReadState,
  Row,
} from "@copilotz/copilotz/web";

/** Shared bounded text-body selection; binary and JSON assets remain references. */
export const messageReadSelection: NonNullable<
  Parameters<ClientCollection["list"]>[1]
> = {
  // A window over budget never fails: bodies resolve newest first while they
  // fit (one body may be at most 64 KiB) and the rest stay references the
  // chat reads on demand.
  content: {
    fields: ["content"],
    byteLimit: 262144,
    bodyByteLimit: 65536,
    overflow: "defer",
    exclude: [
      { kind: "image" },
      { kind: "audio" },
      { kind: "video" },
      { kind: "file" },
      { kind: "json" },
    ],
  },
};

/** How many of a thread's newest messages the feed reads at first. */
export const THREAD_MESSAGE_LIMIT = 100;
/** The live owner bounds a subscription window at 1000 records. */
export const THREAD_MESSAGE_MAX = 1000;

/** Conversation order, as Core history orders it: creation time, then id. */
function chronological(left: Row, right: Row): number {
  const leftAt = String(left.createdAt ?? ""),
    rightAt = String(right.createdAt ?? "");
  if (leftAt !== rightAt) return leftAt < rightAt ? -1 : 1;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/**
 * The thread's newest messages, oldest first. Message ids are not time-ordered
 * across senders (agent replies use derived ids), so the window is selected by
 * creation time. `limit` grows the window when the reader loads older
 * messages. Call during tracked View rendering, before passing messages to
 * components.
 */
export function readThreadMessages(
  ctx: BrowserViewContext,
  threadId: string,
  limit: number = THREAD_MESSAGE_LIMIT,
): ReadState<readonly Row[]> {
  const read = ctx.collections.message.list(
    {
      where: { threadId },
      order: { field: "createdAt", direction: "desc" },
      limit: Math.min(Math.max(1, Math.floor(limit)), THREAD_MESSAGE_MAX),
    },
    messageReadSelection,
  );
  return { ...read, value: [...read.value].sort(chronological) };
}

/** How many conversations the sidebar reads. */
export const THREAD_LIST_LIMIT = 200;

function recent(left: Row, right: Row): number {
  const leftAt = String(left.updatedAt ?? left.createdAt ?? ""),
    rightAt = String(right.updatedAt ?? right.createdAt ?? "");
  if (leftAt !== rightAt) return leftAt < rightAt ? 1 : -1;
  return left.id < right.id ? 1 : left.id > right.id ? -1 : 0;
}

/**
 * The reader's conversations, most recently updated first: a live window
 * ordered by `updatedAt`, so a conversation that just changed moves to the
 * top (and into the window) as it changes.
 */
export function readThreads(
  ctx: BrowserViewContext,
): ReadState<readonly Row[]> {
  const read = ctx.collections.thread.list({
    order: { field: "updatedAt", direction: "desc" },
    limit: THREAD_LIST_LIMIT,
  });
  // The owner sends the window in order; optimistic edits keep it so.
  return { ...read, value: [...read.value].sort(recent) };
}

/** The Spaces the reader can see, by name. */
export function readSpaces(
  ctx: BrowserViewContext,
): ReadState<readonly Row[]> {
  if (!ctx.collections.space) {
    return { value: [], status: "ready", pending: false };
  }
  const read = ctx.collections.space.list({
    order: { field: "name", direction: "asc" },
    limit: THREAD_LIST_LIMIT,
  });
  return {
    ...read,
    value: [...read.value].sort((left, right) =>
      String(left.name ?? left.id).localeCompare(String(right.name ?? right.id))
    ),
  };
}

/**
 * One conversation, served from the shared conversation list when it holds
 * it, so Views showing the open conversation add no live read of their own.
 */
export function readThread(
  ctx: BrowserViewContext,
  id: string,
): ReadState<Row | undefined> {
  return fromList(readThreads(ctx), id, () => ctx.collections.thread.get(id));
}

/** One Space, served from the shared Space list when it holds it. */
export function readSpace(
  ctx: BrowserViewContext,
  id: string,
): ReadState<Row | undefined> {
  if (!ctx.collections.space) {
    return { value: undefined, status: "missing", pending: false };
  }
  return fromList(readSpaces(ctx), id, () => ctx.collections.space.get(id));
}

function fromList(
  list: ReadState<readonly Row[]>,
  id: string,
  fallback: () => ReadState<Row | undefined>,
): ReadState<Row | undefined> {
  const found = list.value.find((row) => row.id === id);
  if (found) return { value: found, status: "ready", pending: list.pending };
  // Wait for the list rather than opening a read it is about to answer.
  if (list.status === "loading") {
    return { value: undefined, status: "loading", pending: false };
  }
  return fallback();
}

/** A Space's conversations, most recently updated first: one shared live read per Space. */
export function readSpaceThreads(
  ctx: BrowserViewContext,
  spaceId: string,
): ReadState<readonly Row[]> {
  const read = ctx.collections.thread.list({
    where: { spaceId },
    order: { field: "updatedAt", direction: "desc" },
    limit: THREAD_LIST_LIMIT,
  });
  return { ...read, value: [...read.value].sort(recent) };
}

/** The most values one live `in` filter may carry. */
export const PARTICIPANT_BATCH = 32;

/**
 * Participants by id, in as few live reads as the server allows (`in` lists
 * of at most 32). Ids are sorted, so Views reading the same people share the
 * same reads.
 */
export function readParticipants(
  ctx: BrowserViewContext,
  ids: Iterable<string>,
): ReadonlyMap<string, Row> {
  const unique = [...new Set(ids)].filter(Boolean).sort();
  const rows = new Map<string, Row>();
  for (let index = 0; index < unique.length; index += PARTICIPANT_BATCH) {
    const batch = unique.slice(index, index + PARTICIPANT_BATCH);
    const read = ctx.collections.participant.list({
      where: { id: { in: batch } },
      limit: batch.length,
    });
    for (const row of read.value) rows.set(String(row.id), row);
  }
  return rows;
}
