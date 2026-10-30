/**
 * The conversation an agent is sent: each message through its View. Another
 * plugin may replace it (the history plugin sends older parts as summaries).
 */
import type { ViewContext } from "../../../../runtime/mod.ts";
import type { LlmMessage } from "../../../models/contract.ts";
import type { Message } from "../collections/message.ts";
import type { Thread } from "../collections/thread.ts";

export function historyView(
  { messages }: { thread: Thread; messages: Message[] },
  ctx: ViewContext,
): LlmMessage[] {
  return messages.flatMap((m) => (ctx.show("message", m) ?? []) as LlmMessage[]);
}
