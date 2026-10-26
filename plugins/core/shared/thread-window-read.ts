import { defineRead } from "@copilotz/copilotz/collections/authoring";
import { loadCoreThreadMessageSnapshot } from "./helpers.ts";
export type ThreadWindowArgs = {
  threadId: string;
  trigger: Parameters<typeof loadCoreThreadMessageSnapshot>[2];
  options?: Parameters<typeof loadCoreThreadMessageSnapshot>[3];
};
export const threadWindowRead:
  import("@copilotz/copilotz/collections").RegisteredRead<
    ThreadWindowArgs,
    ThreadWindowResult
  > = defineRead((args: ThreadWindowArgs, context) =>
    loadCoreThreadMessageSnapshot(
      context as unknown as Parameters<typeof loadCoreThreadMessageSnapshot>[0],
      args.threadId,
      args.trigger,
      args.options,
    )
  );
export type ThreadWindowResult = Awaited<
  ReturnType<typeof loadCoreThreadMessageSnapshot>
>;
