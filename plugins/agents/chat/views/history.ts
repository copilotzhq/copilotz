/**
 * The conversation an agent is sent: each message through its View. Another
 * plugin may replace it (the history plugin sends older parts as summaries).
 * `from`: where the agent's window by age starts (`Agent.history.maxAge`).
 * Messages before it are left out already; one that replaces this View
 * leaves out what stands for them too.
 */
import type { ViewContext } from "../../../../runtime/mod.ts";
import type { LlmMessage } from "../../../models/contract.ts";
import type { Message } from "../collections/message.ts";
import type { Thread } from "../collections/thread.ts";

export function historyView(
  { messages }: { thread: Thread; messages: Message[]; from?: string },
  ctx: ViewContext,
): LlmMessage[] {
  return messages.flatMap((m) => (ctx.show("llm.message", m) ?? []) as LlmMessage[]);
}
