/** Starting a conversation from a View: send at once, create alongside. @module */
import type { BrowserViewContext } from "@copilotz/copilotz/web";
import { monotonicUlid } from "../../../../dependencies/ulid.ts";
import { titleFrom } from "./intents.ts";

/**
 * Starts a conversation with a client-chosen id: the first message shows as
 * sending in the opened conversation at once, while `chatSend` creates the
 * thread and sends. A failure stays there with Retry, which continues the
 * same conversation instead of starting another.
 */
export function startConversation(
  ctx: BrowserViewContext,
  input: {
    text: string;
    files?: readonly File[];
    recipientIds?: readonly string[];
    recipientAgents?: readonly Record<string, unknown>[];
    spaceId?: string;
  },
): Promise<string> {
  const threadId = monotonicUlid();
  const sending = ctx.actions.chatSend({
    threadId,
    create: {
      name: titleFrom(input.text || input.files?.[0]?.name || ""),
      ...(input.spaceId ? { spaceId: input.spaceId } : {}),
    },
    text: input.text,
    files: input.files ?? [],
    ...(input.recipientIds ? { recipientIds: input.recipientIds } : {}),
    ...(input.recipientAgents?.length
      ? { recipientAgents: input.recipientAgents }
      : {}),
  });
  ctx.show({ shows: "thread", value: { id: threadId } }, {
    source: "navigator",
  });
  void sending.result().catch(() => {});
  return Promise.resolve(threadId);
}
