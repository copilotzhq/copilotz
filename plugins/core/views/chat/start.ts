/** Starting a conversation from a View: create, open, then send. @module */
import type { BrowserViewContext } from "@copilotz/copilotz/web";
import { titleFrom } from "./intents.ts";

/**
 * Creates the conversation (in a Space when given), opens it through the
 * host's navigation, then sends the first message. The message shows as
 * sending in the opened conversation; a failed send stays there with Retry.
 */
export async function startConversation(
  ctx: BrowserViewContext,
  input: {
    text: string;
    files?: readonly File[];
    recipientIds?: readonly string[];
    spaceId?: string;
  },
): Promise<string> {
  const created = await ctx.actions.chatCreateThread({
    name: titleFrom(input.text || input.files?.[0]?.name || ""),
    ...(input.spaceId ? { spaceId: input.spaceId } : {}),
  }).result() as { threadId: string };
  ctx.show({ shows: "thread", value: { id: created.threadId } }, {
    source: "navigator",
  });
  void ctx.actions.chatSend({
    threadId: created.threadId,
    text: input.text,
    files: input.files ?? [],
    recipientIds: input.recipientIds ?? [],
  }).result().catch(() => {});
  return created.threadId;
}
