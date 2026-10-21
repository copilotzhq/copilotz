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

/** How many of a thread's newest messages the feed reads. */
const THREAD_MESSAGE_LIMIT = 100;

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
 * creation time. Call during tracked View rendering, before passing messages
 * to components.
 */
export function readThreadMessages(
  ctx: BrowserViewContext,
  threadId: string,
): ReadState<readonly Row[]> {
  const read = ctx.collections.message.list(
    {
      where: { threadId },
      order: { field: "createdAt", direction: "desc" },
      limit: THREAD_MESSAGE_LIMIT,
    },
    messageReadSelection,
  );
  return { ...read, value: [...read.value].sort(chronological) };
}
