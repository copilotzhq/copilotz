/** Conversation mutations use ordinary durable Actions and existing Collections. */
import { type ActionContext, defineAction } from "@copilotz/copilotz/actions";

export const sendSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    threadId: { type: "string", minLength: 1 },
    externalThreadId: { type: "string", minLength: 1 },
    content: {},
    recipientIds: {
      type: "array",
      items: { type: "string" },
      uniqueItems: true,
    },
  },
  required: ["content"],
  oneOf: [{ required: ["threadId"] }, { required: ["externalThreadId"] }],
} as const;

function actor(context: ActionContext) {
  const value = context.action.metadata.httpActor as {
    id?: string;
    externalId?: string;
    name?: string;
  } | undefined;
  if (!value?.id) {
    throw new Error("Conversation mutations require an authenticated actor.");
  }
  return {
    ...value,
    id: value.id,
    externalId: value.externalId ?? value.id,
    participantType: "human" as const,
  };
}

async function ownedThread(context: ActionContext, id: string) {
  const sender = actor(context);
  const thread = await context.collections.thread.get({ id });
  if (
    !thread || !Array.isArray(thread.participantIds) ||
    (!thread.participantIds.includes(sender.id) &&
      (context.action.metadata.coreConversationAccess as { threadId?: string })
          ?.threadId !== id)
  ) {
    throw new Error("Thread was not found.");
  }
  return thread;
}

export const sendConversation = defineAction({
  id: "copilotz.core.conversation.send",
  inputSchema: sendSchema,
  async execute(
    input: {
      threadId?: string;
      externalThreadId?: string;
      content: unknown;
      recipientIds?: string[];
    },
    context: ActionContext,
  ) {
    const sender = actor(context);
    let threadId = input.threadId;
    if (!threadId) {
      const externalId = `${sender.id}:${input.externalThreadId}`;
      const existing = await context.collections.thread.queries.byExternalId({
        externalId,
      });
      if (existing.length) threadId = existing[0].id;
      else {
        const created = await context.actions.createThread({
          externalId,
          participants: [sender],
        }, { operationKey: "thread" }) as { id: string };
        threadId = created.id;
      }
    }
    const thread = await ownedThread(context, threadId);
    const recipientIds: string[] = [];
    for (const requested of input.recipientIds ?? []) {
      const participant = await context.collections.participant.get({
        id: requested,
      });
      if (
        participant &&
        (thread.participantIds as string[]).includes(participant.id)
      ) {
        recipientIds.push(participant.id);
        continue;
      }
      const agent = Object.entries(context.resources.agents ?? {}).find((
        [alias, value],
      ) =>
        alias === requested || (value as { id?: string }).id === requested ||
        participant?.participantType === "agent" &&
          (value as { id?: string }).id === participant.agentId
      )
        ?.[1] as { id: string; name: string } | undefined;
      if (!agent) throw new Error("Recipient was not found.");
      const added = await context.actions.addThreadParticipant({
        threadId,
        participant: {
          externalId: agent.id,
          participantType: "agent",
          agentId: agent.id,
          name: agent.name,
        },
      }, { operationKey: `recipient:${agent.id}` }) as {
        participant: { id: string };
      };
      recipientIds.push(added.participant.id);
    }
    const message = await context.actions.createThreadMessage({
      id: `${context.action.runId}:message`,
      threadId,
      sender,
      content: input.content,
      recipientIds,
      metadata: {
        clientMessageId:
          (context.action.metadata.copilotzServer as { requestId?: string })
            ?.requestId,
      },
    }, { operationKey: "message" });
    return { threadId, message };
  },
});

export const updateConversation = defineAction({
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
  async execute(
    input: { threadId: string; patch: Record<string, unknown> },
    context: ActionContext,
  ) {
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

export const deleteConversation = defineAction({
  id: "copilotz.core.conversation.delete",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: { threadId: { type: "string" } },
    required: ["threadId"],
  } as const,
  async execute(input: { threadId: string }, context: ActionContext) {
    const existing = await context.collections.thread.get({
      id: input.threadId,
    });
    // A completed deletion is already satisfied, including a replay after the
    // atomic Collection commit but before the Action's terminal Event.
    if (!existing) return { threadId: input.threadId, deleted: true };
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
      if (messages.length < 1000) break;
      after = messages.at(-1)!.id;
    }
    await context.transaction(async (tx) => {
      for (const id of ids) {
        await tx.collections.message.delete({ id }, {
          threadId: input.threadId,
        });
      }
      await tx.collections.thread.delete({ id: input.threadId }, {
        threadId: input.threadId,
      });
    }, { operationKey: "delete" });
    return { threadId: input.threadId, deleted: true };
  },
});

export const editConversationMessage = defineAction({
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
  async execute(
    input: { threadId: string; messageId: string; content: unknown },
    context: ActionContext,
  ) {
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
    ) throw new Error("Message was not found.");
    return await context.actions.reviseMessage({
      ...input,
      id: `${context.action.runId}:revision`,
    }, { operationKey: "revision" });
  },
});
