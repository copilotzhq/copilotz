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
  content: {
    fields: ["content"],
    byteLimit: 262144,
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
 * The reader's conversations, most recently updated first. Thread ids are
 * time-ordered, so the newest-id window holds the newest conversations; the
 * live owner supports id order today.
 */
export function readThreads(
  ctx: BrowserViewContext,
): ReadState<readonly Row[]> {
  const read = ctx.collections.thread.list({
    order: { field: "id", direction: "desc" },
    limit: THREAD_LIST_LIMIT,
  });
  return { ...read, value: [...read.value].sort(recent) };
}

/** The Spaces the reader can see, by name. */
export function readSpaces(
  ctx: BrowserViewContext,
): ReadState<readonly Row[]> {
  if (!ctx.collections.space) {
    return { value: [], status: "ready", pending: false };
  }
  const read = ctx.collections.space.list({ limit: THREAD_LIST_LIMIT });
  return {
    ...read,
    value: [...read.value].sort((left, right) =>
      String(left.name ?? left.id).localeCompare(String(right.name ?? right.id))
    ),
  };
}
