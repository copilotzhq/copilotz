import type { ActionDefinition } from "@copilotz/copilotz/actions";
/** Built-in Action that creates a separate durable thread.
 *
 * @module
 */
import { type ActionContext, defineAction } from "@copilotz/copilotz/actions";
import type { AgentResource, ParticipantInput } from "@copilotz/copilotz/core";
import type { ContentRef } from "@copilotz/copilotz/content";
import { optionalText, record, requiredText } from "../../shared/input.ts";
import {
  loadCallerParticipant,
  metadataText,
  participantByExternalId,
  participantInput,
} from "../../shared/participants.ts";
function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return "[" + value.map(stableJson).join(",") + "]";
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => JSON.stringify(key) + ":" + stableJson(child));
    return "{" + entries.join(",") + "}";
  }
  return JSON.stringify(value) ?? "null";
}
async function resolveThreadParticipant(
  context: ActionContext,
  reference: unknown,
): Promise<ParticipantInput> {
  const id = requiredText(reference, "participant");
  const existing = await context.collections.participant.get({ id }) ??
    await participantByExternalId(context, id);
  if (existing) {
    return participantInput(existing);
  }
  const agents = (context.resources.agents ?? {}) as Readonly<
    Record<string, AgentResource | undefined>
  >;
  const agent = agents[id] ?? Object.values(agents)
    .filter((value): value is AgentResource => !!value)
    .find((candidate) => candidate.name === id || candidate.id === id);
  if (!agent) {
    throw new Error("Thread participant '" + id + "' was not found.");
  }
  return ({
    externalId: agent.id,
    participantType: "agent",
    agentId: agent.id,
    name: agent.name,
  } as const);
}
export const createThreadAction: ActionDefinition<unknown, {
  threadId: string;
  name: string;
  participantIds: string[];
  mode: string;
  status: string;
  eventId: string;
  messageEventId: string;
}, ActionContext> = defineAction({
  id: "copilotz.tools.builtin.create_thread",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", minLength: 1 },
      externalId: { type: "string", minLength: 1 },
      name: { type: "string", minLength: 1 },
      participants: {
        type: "array",
        items: { type: "string", minLength: 1 },
      },
      initialMessage: { type: "string" },
      mode: {
        type: "string",
        enum: ["background", "immediate"],
        default: "immediate",
      },
      description: { type: "string" },
      summary: { type: "string" },
      metadata: { type: "object", additionalProperties: true },
    },
    required: ["name", "participants"],
  },
  async execute(raw, ctx) {
    const input = record(raw);
    const name = requiredText(input.name, "name");
    if (!Array.isArray(input.participants)) {
      throw new TypeError("participants must be an array.");
    }
    const mode = input.mode ?? "immediate";
    if (mode !== "background" && mode !== "immediate") {
      throw new TypeError("mode must be background or immediate.");
    }
    const caller = await loadCallerParticipant(ctx);
    if (!caller || caller.participantType !== "agent") {
      throw new Error("The calling agent participant was not found.");
    }
    const requested = await Promise.all(
      input.participants.map((participant) =>
        resolveThreadParticipant(ctx, participant)
      ),
    );
    const participants = new Map<string, ParticipantInput>();
    for (const participant of [participantInput(caller), ...requested]) {
      participants.set(participant.externalId, participant);
    }
    const threadId = typeof input.id === "string" && input.id.trim()
      ? input.id.trim()
      : `thread:${ctx.action.runId}`;
    const externalId = optionalText(input.externalId);
    const description = optionalText(input.description);
    const summary = optionalText(input.summary);
    const parentThreadId = metadataText(ctx, "threadId");
    const initialMessageId = `message:${threadId}:initial`;
    const initialMessage = typeof input.initialMessage === "string" &&
        input.initialMessage.trim()
      ? input.initialMessage
      : `Started thread: ${name}`;
    const participantPlans = await Promise.all(
      [...participants.values()].map(async (participant) => {
        const existing = participant.id
          ? await ctx.collections.participant.get({ id: participant.id })
          : await participantByExternalId(ctx, participant.externalId);
        return { participant, existing };
      }),
    );
    const [existingThread, existingInitialMessage] = await Promise.all([
      ctx.collections.thread.get({ id: threadId }),
      ctx.collections.message.get({ id: initialMessageId }),
    ]);
    if (Boolean(existingThread) !== Boolean(existingInitialMessage)) {
      throw new Error(
        `Thread '${threadId}' has inconsistent initial-message state.`,
      );
    }
    if (existingThread && existingInitialMessage) {
      const expectedParticipantIds = participantPlans.map(({ existing }) => {
        if (!existing) {
          throw new Error(
            `Existing thread '${threadId}' does not match requested participants.`,
          );
        }
        return existing.id;
      }).sort();
      const actualParticipantIds = Array.isArray(existingThread.participantIds)
        ? existingThread.participantIds.map(String).sort()
        : [];
      const resolved = await ctx.content.resolveMany(
        Array.isArray(existingInitialMessage.content)
          ? existingInitialMessage.content as unknown as readonly ContentRef[]
          : [],
      );
      const existingText = resolved.map((part) => part.text ?? "").join("");
      const declarationMetadata = {
        ...structuredClone(record(input.metadata)),
        name,
        mode,
        ...(description ? { description } : {}),
        ...(summary ? { summary } : {}),
      };
      const existingMetadata = structuredClone(record(existingThread.metadata));
      const createdByActionRunId = optionalText(
        existingMetadata.createdByActionRunId,
      );
      delete existingMetadata.createdByActionRunId;
      const expectedRecipientIds = expectedParticipantIds
        .filter((id) => id !== caller.id)
        .sort();
      const actualRecipientIds =
        Array.isArray(existingInitialMessage.recipientIds)
          ? existingInitialMessage.recipientIds.map(String).sort()
          : [];
      const messageMetadata = record(existingInitialMessage.metadata);
      if (
        existingThread.name !== name ||
        optionalText(existingThread.externalId) !== externalId ||
        optionalText(existingThread.parentThreadId) !== parentThreadId ||
        optionalText(existingThread.description) !== description ||
        existingThread.status !== "active" ||
        stableJson(existingMetadata) !== stableJson(declarationMetadata) ||
        JSON.stringify(actualParticipantIds) !==
          JSON.stringify(expectedParticipantIds) ||
        existingInitialMessage.threadId !== threadId ||
        existingInitialMessage.senderId !== caller.id ||
        JSON.stringify(actualRecipientIds) !==
          JSON.stringify(expectedRecipientIds) ||
        messageMetadata.kind !== "thread_initial_message" ||
        messageMetadata.mode !== mode ||
        !createdByActionRunId ||
        optionalText(messageMetadata.createdByActionRunId) !==
          createdByActionRunId ||
        existingText !== initialMessage
      ) {
        throw new Error(
          `Existing thread '${threadId}' does not match the requested declaration.`,
        );
      }
      return {
        threadId,
        name,
        participantIds: expectedParticipantIds,
        mode,
        status: "started",
        eventId: existingThread.id,
        messageEventId: existingInitialMessage.id,
      };
    }
    const metadata = {
      ...structuredClone(record(input.metadata)),
      name,
      mode,
      ...(description ? { description } : {}),
      ...(summary ? { summary } : {}),
      createdByActionRunId: ctx.action.runId,
    };
    const preparedContent = await ctx.content.prepare(initialMessage, {
      operationKey: `create_thread:${ctx.action.runId}:initial-content`,
    });
    const created = await ctx.transaction(async (transaction) => {
      const ensuredIds: string[] = [];
      for (const { participant, existing } of participantPlans) {
        if (existing) {
          ensuredIds.push(existing.id);
          continue;
        }
        const participantId = participant.id?.trim() ||
          `participant:${encodeURIComponent(participant.externalId)}`;
        const ref = await transaction.collections.participant.create({
          id: participantId,
          externalId: participant.externalId,
          participantType: participant.participantType,
          ...(participant.name ? { name: participant.name } : {}),
          ...(participant.email ? { email: participant.email } : {}),
          ...(participant.agentId ? { agentId: participant.agentId } : {}),
          metadata: structuredClone(participant.metadata ?? {}),
        }, {
          metadata: {
            core: {
              threadId,
            },
          },
        });
        ensuredIds.push(ref.id);
      }
      const thread = await transaction.collections.thread.create({
        id: threadId,
        ...(externalId ? { externalId } : {}),
        ...(parentThreadId ? { parentThreadId } : {}),
        name,
        ...(description ? { description } : {}),
        participantIds: ensuredIds,
        metadata,
      }, {
        metadata: {
          core: {
            threadId,
          },
        },
      });
      const recipientIds = ensuredIds.filter((id) => id !== caller.id);
      const messageMetadata = {
        kind: "thread_initial_message",
        mode,
        createdByActionRunId: ctx.action.runId,
      };
      const message = await transaction.collections.message.create({
        id: initialMessageId,
        threadId,
        senderId: caller.id,
        recipientIds,
        content: preparedContent,
        metadata: messageMetadata,
      }, {
        identity: { metadata: messageMetadata },
        metadata: {
          core: {
            threadId,
            routing: { senderId: caller.id, recipientIds },
            visibility: { kind: "public" },
          },
        },
      });
      return { thread, message, participantIds: ensuredIds };
    }, {
      operationKey: `create_thread:${ctx.action.runId}`,
    });
    return {
      threadId,
      name,
      participantIds: created.participantIds,
      mode,
      status: "started",
      eventId: created.thread.id,
      messageEventId: created.message.id,
    };
  },
});
