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
    const selections = new Map<string, {
      participantId?: string;
      agent?: {
        id: string;
        name: string;
      };
    }>();
    for (
      const requested of new Set([...members, ...input.recipientIds ?? []])
    ) {
      const participant = await context.collections.participant.get({
        id: requested,
      });
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
    const enrolled = new Map<string, string>();
    for (const selection of selections.values()) {
      const agent = selection.agent;
      if (!agent) {
        continue;
      }
      if (!enrolled.has(agent.id)) {
        const added = await context.actions.addThreadParticipant({
          threadId,
          participant: {
            externalId: agent.id,
            participantType: "agent",
            agentId: agent.id,
            name: agent.name,
          },
        }, { operationKey: `participant:${agent.id}` }) as {
          participant: {
            id: string;
          };
        };
        enrolled.set(agent.id, added.participant.id);
      }
      selection.participantId = enrolled.get(agent.id)!;
    }
    const recipientIds = [
      ...new Set(
        (input.recipientIds ?? []).map((id) =>
          selections.get(id)!.participantId!
        ),
      ),
    ];
    const message = await context.actions.createThreadMessage({
      id: `${context.action.runId}:message`,
      threadId,
      sender,
      content: input.content,
      recipientIds,
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
