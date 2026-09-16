import {
  type ActionContext,
  type ActionDefinition,
  defineAction,
} from "@copilotz/copilotz/actions";
import { ownedThread } from "../../shared/access.ts";
export const deleteConversation: ActionDefinition<{
  threadId: string;
}, {
  threadId: string;
  deleted: boolean;
}, ActionContext> = defineAction({
  id: "copilotz.core.conversation.delete",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: { threadId: { type: "string" } },
    required: ["threadId"],
  } as const,
  async execute(input: {
    threadId: string;
  }, context: ActionContext) {
    const existing = await context.collections.thread.get({
      id: input.threadId,
    });
    // A completed deletion is already satisfied, including a replay after the
    // atomic Collection commit but before the Action's terminal Event.
    if (!existing) {
      return { threadId: input.threadId, deleted: true };
    }
    await ownedThread(context, input.threadId);
    const ids: string[] = [];
    let after: string | undefined;
    for (;;) {
      const messages = await context.collections.message.list({
        where: { threadId: input.threadId },
        limit: 1000,
        after,
      });
      ids.push(...messages.map((message) => message.id));
      if (messages.length < 1000) {
        break;
      }
      after = messages.at(-1)!.id;
    }
    await context.transaction(async (tx) => {
      for (const id of ids) {
        await tx.collections.message.delete({ id }, {
          metadata: {
            core: {
              threadId: input.threadId,
            },
          },
        });
      }
      await tx.collections.thread.delete({ id: input.threadId }, {
        metadata: {
          core: {
            threadId: input.threadId,
          },
        },
      });
    }, { operationKey: "delete" });
    return { threadId: input.threadId, deleted: true };
  },
});

export default deleteConversation;
