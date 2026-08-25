/** Defines the Core delete-thread-messages Action. @module */

import {
  type ActionContext,
  type ActionDefinition,
  defineAction,
} from "@copilotz/copilotz/actions";
import { asRecord, requiredText } from "../internal/content-policy.ts";

export const DELETE_THREAD_MESSAGES_ACTION_ID =
  "copilotz.core.thread.deleteMessages";

type DeleteThreadMessagesResult = Readonly<{
  threadId: string;
  deleted: true;
}>;

const inputSchema = {
  type: "object",
  additionalProperties: true,
  properties: { threadId: { type: "string" } },
  required: ["threadId"],
} as const;

export const deleteThreadMessagesAction: ActionDefinition<
  unknown,
  DeleteThreadMessagesResult,
  ActionContext,
  typeof inputSchema,
  undefined
> = defineAction({
  id: DELETE_THREAD_MESSAGES_ACTION_ID,
  inputSchema,
  async execute(input, context) {
    const data = asRecord(input);
    const threadId = requiredText(data.threadId, "Thread ID");
    const messages = await context.collections.message.queries.byThreadId({
      threadId,
    });
    await context.transaction(async (tx) => {
      for (const message of messages) {
        await tx.collections.message.delete({ id: message.id }, { threadId });
      }
    });
    return Object.freeze({ threadId, deleted: true as const });
  },
});
