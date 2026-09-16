import {
  type ActionContext,
  type ActionDefinition,
  defineAction,
} from "@copilotz/copilotz/actions";
import { actor, ownedThread } from "../../shared/access.ts";
export const editConversationMessage: ActionDefinition<
  {
    threadId: string;
    messageId: string;
    content: unknown;
  },
  unknown,
  ActionContext
> = defineAction({
  id: "copilotz.core.conversation.edit-message",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      threadId: { type: "string" },
      messageId: { type: "string" },
      content: {},
    },
    required: ["threadId", "messageId", "content"],
  } as const,
  async execute(input: {
    threadId: string;
    messageId: string;
    content: unknown;
  }, context: ActionContext) {
    await ownedThread(context, input.threadId);
    const message = await context.collections.message.get({
      id: input.messageId,
    });
    if (
      !message || message.threadId !== input.threadId ||
      (message.senderId !== actor(context).id &&
        (context.action.metadata.coreConversationAccess as {
            messageId?: string;
          })?.messageId !== input.messageId)
    ) {
      throw new Error("Message was not found.");
    }
    return await context.actions.reviseMessage({
      ...input,
      id: `${context.action.runId}:revision`,
    }, { operationKey: "revision" });
  },
});

export default editConversationMessage;
