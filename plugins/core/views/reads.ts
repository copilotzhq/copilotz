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

/** Call during tracked View rendering, before passing messages to components. */
export function readThreadMessages(
  ctx: BrowserViewContext,
  threadId: string,
): ReadState<readonly Row[]> {
  return ctx.collections.message.list(
    { where: { threadId }, limit: 100 },
    messageReadSelection,
  );
}
