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
          tags: {
            type: "array",
            items: {
              type: "object",
              required: ["id", "name"],
              properties: {
                id: { type: "string" },
                name: { type: "string" },
                color: { type: "string" },
              },
              additionalProperties: false,
            },
          },
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
    const thread = await ownedThread(context, input.threadId);
    const { tags, ...set } = input.patch;
    if (tags) {
      const metadata = thread.metadata as Record<string, unknown>;
      set.metadata = {
        ...metadata,
        public: { ...(metadata.public as object ?? {}), tags },
      };
    }
    return await context.collections.thread.update({ id: input.threadId, set });
  },
});

export default updateConversation;
