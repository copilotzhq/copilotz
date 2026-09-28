import {
  type ActionContext,
  type ActionDefinition,
  defineAction,
} from "@copilotz/copilotz/actions";
import { actor, ownedThread } from "../../shared/access.ts";
export const sendSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    threadId: { type: "string", minLength: 1 },
    externalThreadId: { type: "string", minLength: 1 },
    content: {},
    participantIds: {
      type: "array",
      items: { type: "string", minLength: 1 },
      uniqueItems: true,
    },
    recipientIds: {
      type: "array",
      items: { type: "string" },
      uniqueItems: true,
    },
  },
  required: ["content"],
  oneOf: [{ required: ["threadId"] }, { required: ["externalThreadId"] }],
} as const;
export const sendConversation: ActionDefinition<{
  threadId?: string;
  externalThreadId?: string;
  content: unknown;
  participantIds?: string[];
  recipientIds?: string[];
}, {
  threadId: string;
  message: unknown;
}, ActionContext> = defineAction({
  id: "copilotz.core.conversation.send",
  inputSchema: sendSchema,
  async execute(input: {
    threadId?: string;
    externalThreadId?: string;
    content: unknown;
    participantIds?: string[];
    recipientIds?: string[];
  }, context: ActionContext) {
    const sender = actor(context);
    let threadId = input.threadId;
    if (!threadId) {
      const externalId = `${sender.id}:${input.externalThreadId}`;
      const existing = await context.collections.thread.queries.byExternalId({
        externalId,
      });
      if (existing.length) {
        threadId = existing[0].id;
      } else {
        const created = await context.actions.createThread({
          externalId,
          participants: [sender],
        }, { operationKey: "thread" }) as {
          id: string;
        };
        threadId = created.id;
      }
    }
    const thread = await ownedThread(context, threadId);
    // Membership selects who may collaborate; recipients select who responds now.
    // Resolve every selection before enrolling anyone, including on old threads.
    const members = new Set(input.participantIds ?? []);
    const requestedIds = [
      ...new Set([
        ...members,
        ...(input.recipientIds ?? []),
      ]),
    ];
    const requestedParticipants = await Promise.all(
      requestedIds.map((id) => context.collections.participant.get({ id })),
    );
    const participantByRequestedId = new Map(
      requestedIds.map((id, index) => [id, requestedParticipants[index]]),
    );
    const selections = new Map<string, {
      participantId?: string;
      agent?: {
        id: string;
        name: string;
      };
    }>();
    for (const requested of requestedIds) {
      const participant = participantByRequestedId.get(requested);
      if (
        !members.has(requested) && participant &&
        (thread.participantIds as string[]).includes(participant.id)
      ) {
        selections.set(requested, { participantId: participant.id });
        continue;
      }
      const agent = Object.entries(context.resources.agents ?? {}).find((
        [alias, value],
      ) =>
        alias === requested || (value as {
            id?: string;
          }).id === requested ||
        participant?.participantType === "agent" &&
          (value as {
              id?: string;
            }).id === participant.agentId
      )?.[1] as {
        id: string;
        name: string;
      } | undefined;
      if (!agent) {
        throw new Error("Agent or recipient was not found.");
      }
      selections.set(requested, { agent });
    }
    const membershipParticipants = new Map<string, {
      externalId: string;
      participantType: "agent";
      agentId: string;
      name: string;
    }>();
    for (const requested of requestedIds) {
      const agent = selections.get(requested)!.agent;
      if (agent && !membershipParticipants.has(agent.id)) {
        membershipParticipants.set(agent.id, {
          externalId: agent.id,
          participantType: "agent",
          agentId: agent.id,
          name: agent.name,
        });
      }
    }
    const recipients = (input.recipientIds ?? []).map((requested) => {
      const selection = selections.get(requested)!;
      return selection.agent
        ? { externalId: selection.agent.id }
        : { participantId: selection.participantId! };
    });
    const membership = membershipParticipants.size
      ? {
        participants: [...membershipParticipants.values()],
        recipients,
      }
      : undefined;
    const message = await context.actions.createThreadMessage({
      id: `${context.action.runId}:message`,
      threadId,
      sender,
      content: input.content,
      ...(membership ? { membership } : {
        recipientIds: recipients.flatMap((recipient) =>
          "participantId" in recipient ? [recipient.participantId] : []
        ),
      }),
      metadata: {
        clientMessageId: (context.action.metadata.copilotzServer as {
          requestId?: string;
        })
          ?.requestId,
      },
    }, { operationKey: "message" });
    return { threadId, message };
  },
});

export default sendConversation;
