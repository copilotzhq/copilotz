import {
  type ActionContext,
  type ActionDefinition,
  defineAction,
} from "@copilotz/copilotz/actions";
import { ownedThread } from "../../shared/access.ts";
export const updateConversation: ActionDefinition<
  {
    threadId: string;
    patch: Record<string, unknown>;
  },
  Readonly<
    Record<string, unknown> & {
      id: string;
      namespace: string;
      createdAt: string;
      updatedAt: string;
    }
  >,
  ActionContext
> = defineAction({
  id: "copilotz.core.conversation.update",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      threadId: { type: "string" },
      patch: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          description: { type: "string" },
          status: { enum: ["active", "archived", "closed"] },
        },
      },
    },
    required: ["threadId", "patch"],
  } as const,
  async execute(input: {
    threadId: string;
    patch: Record<string, unknown>;
  }, context: ActionContext) {
    await ownedThread(context, input.threadId);
    return await context.collections.thread.update({
      id: input.threadId,
      set: input.patch,
    });
  },
});

export default updateConversation;
