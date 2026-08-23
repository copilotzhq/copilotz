import {
  type ActionContext,
  type ActionDefinition,
  type ActionTransactionContext,
  defineAction,
  type RuntimeContextNamespaces,
} from "@copilotz/copilotz/actions";
import type {
  CollectionMutationRef,
  CollectionRecord,
} from "@copilotz/copilotz/collections";
import type { CoreResources } from "../core/context.ts";
import type {
  CoreScheduledMessageOccurrence,
  DispatchScheduledMessageResult,
} from "./types.ts";

type CoreAgent = NonNullable<CoreResources["agents"][string]>;

type ParticipantPlan =
  | Readonly<{ existing: CollectionRecord }>
  | Readonly<{
    create: Readonly<Record<string, unknown>>;
    operationKey: string;
  }>;

type CoreSchedulesActionContext =
  & Omit<ActionContext, "resources">
  & Readonly<{
    resources:
      & RuntimeContextNamespaces
      & Readonly<{ agents: CoreResources["agents"] }>;
  }>;

function required(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${name} must be non-empty.`);
  }
  return value.trim();
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

async function byExternalId(
  context: CoreSchedulesActionContext,
  collection: "participant" | "thread",
  externalId: string,
): Promise<CollectionRecord | null> {
  const values = await context.collections[collection].queries.byExternalId({
    externalId,
  });
  return values[0] ?? null;
}

function existingParticipant(record: CollectionRecord): ParticipantPlan {
  return Object.freeze({ existing: record });
}

function participantPlanKey(plan: ParticipantPlan): string {
  if ("existing" in plan) return `existing:${plan.existing.id}`;
  return `create:${String(plan.create.id ?? plan.create.externalId)}`;
}

async function resolveSender(
  item: CoreScheduledMessageOccurrence,
  context: CoreSchedulesActionContext,
): Promise<ParticipantPlan> {
  const descriptor = item.payload.sender;
  const externalId = descriptor?.externalId?.trim() || item.jobId;
  const existing = descriptor?.id
    ? await context.collections.participant.get({ id: descriptor.id })
    : await byExternalId(context, "participant", externalId);
  if (existing) {
    if (existing.participantType !== "job") {
      throw new Error(
        `Scheduled sender '${externalId}' belongs to a non-job participant.`,
      );
    }
    return existingParticipant(existing);
  }
  return Object.freeze({
    create: {
      ...(descriptor?.id ? { id: descriptor.id } : {}),
      externalId,
      participantType: "job",
      name: descriptor?.name?.trim() || item.jobName,
      ...(descriptor?.email ? { email: descriptor.email } : {}),
      metadata: {
        ...structuredClone(descriptor?.metadata ?? {}),
        scheduledJobId: item.jobId,
      },
    },
    operationKey: `sender:${item.jobId}`,
  });
}

async function resolveAgentParticipant(
  agent: CoreAgent,
  context: CoreSchedulesActionContext,
): Promise<ParticipantPlan> {
  const externalId = agent.id;
  const existing = await byExternalId(context, "participant", externalId);
  if (existing) {
    if (existing.participantType !== "agent") {
      throw new Error(
        `Agent identity '${externalId}' belongs to a non-agent participant.`,
      );
    }
    return existingParticipant(existing);
  }
  return Object.freeze({
    create: {
      externalId,
      participantType: "agent",
      agentId: agent.id,
      name: agent.name,
    },
    operationKey: `agent:${agent.id}`,
  });
}

async function resolveRecipient(
  reference: string,
  context: CoreSchedulesActionContext,
): Promise<ParticipantPlan> {
  const id = required(reference, "Scheduled recipient");
  const existing = await context.collections.participant.get({ id }) ??
    await byExternalId(context, "participant", id);
  if (existing) return existingParticipant(existing);
  const agents = context.resources.agents ?? {};
  const agent = agents[id] ??
    Object.values(agents).find((value) => value?.id === id);
  if (agent) return await resolveAgentParticipant(agent, context);
  throw new Error(`Scheduled recipient '${id}' was not found.`);
}

async function findThread(
  item: CoreScheduledMessageOccurrence,
  context: CoreSchedulesActionContext,
): Promise<CollectionRecord | null> {
  const descriptor = item.payload.thread;
  return descriptor?.id
    ? await context.collections.thread.get({ id: descriptor.id })
    : descriptor?.externalId
    ? await byExternalId(context, "thread", descriptor.externalId)
    : await byExternalId(context, "thread", `scheduled-job:${item.jobId}`);
}

async function existingAgentRecipients(
  thread: CollectionRecord,
  context: CoreSchedulesActionContext,
): Promise<readonly ParticipantPlan[]> {
  const participants = await Promise.all(
    stringArray(thread.participantIds).map((id) =>
      context.collections.participant.get({ id })
    ),
  );
  return Object.freeze(
    participants
      .filter((value): value is CollectionRecord =>
        value !== null && value.participantType === "agent"
      )
      .map(existingParticipant),
  );
}

function uniqueParticipantPlans(
  plans: readonly ParticipantPlan[],
): readonly ParticipantPlan[] {
  return Object.freeze([
    ...new Map(plans.map((plan) => [participantPlanKey(plan), plan])).values(),
  ]);
}

async function stageParticipant(
  plan: ParticipantPlan,
  collections: ActionTransactionContext["collections"],
): Promise<CollectionMutationRef> {
  if ("existing" in plan) return Object.freeze({ id: plan.existing.id });
  return await collections.participant.create(plan.create, {
    operationKey: plan.operationKey,
  });
}

async function dispatchScheduledMessage(
  item: CoreScheduledMessageOccurrence,
  context: CoreSchedulesActionContext,
): Promise<DispatchScheduledMessageResult> {
  if (!item.content) {
    throw new TypeError("A Core scheduled message requires durable content.");
  }
  const sender = await resolveSender(item, context);
  const existingThread = await findThread(item, context);
  let recipients = uniqueParticipantPlans(
    await Promise.all(
      (item.payload.recipientIds ?? []).map((value) =>
        resolveRecipient(value, context)
      ),
    ),
  );
  if (recipients.length === 0) {
    recipients = existingThread
      ? await existingAgentRecipients(existingThread, context)
      : Object.freeze([]);
  }
  if (recipients.length === 0) {
    throw new Error(`Scheduled job '${item.jobId}' has no agent recipient.`);
  }
  const metadata = {
    scheduledJob: {
      jobId: item.jobId,
      jobName: item.jobName,
      occurrenceId: item.occurrenceId,
      mode: item.mode,
      scheduledFor: item.scheduledFor,
    },
    scheduledMessage: {
      metadata: structuredClone(item.payload.metadata ?? {}),
    },
  };
  const descriptor = item.payload.thread;
  const result = await context.transaction(async (transaction) => {
    const senderRef = await stageParticipant(sender, transaction.collections);
    const recipientRefs = await Promise.all(
      recipients.map((plan) => stageParticipant(plan, transaction.collections)),
    );
    const participantIds = [
      ...new Set([senderRef.id, ...recipientRefs.map((value) => value.id)]),
    ];
    const threadRef = existingThread
      ? Object.freeze({ id: existingThread.id })
      : await transaction.collections.thread.create({
        ...(descriptor?.id ? { id: descriptor.id } : {}),
        externalId: descriptor?.externalId?.trim() ||
          `scheduled-job:${item.jobId}`,
        ...(descriptor?.status ? { status: descriptor.status } : {}),
        metadata: {
          ...structuredClone(descriptor?.metadata ?? {}),
          scheduledJobId: item.jobId,
        },
        participantIds,
      }, { operationKey: `thread:${item.jobId}` });
    if (existingThread) {
      const existingIds = new Set(stringArray(existingThread.participantIds));
      for (const participantId of participantIds) {
        if (existingIds.has(participantId)) continue;
        await transaction.collections.thread.commands.addParticipant({
          id: threadRef.id,
          participantId,
        }, {
          operationKey: `thread-participant:${participantId}`,
          threadId: threadRef.id,
        });
        existingIds.add(participantId);
      }
    }
    const messageRef = await transaction.collections.message.create({
      id: `scheduled:${item.occurrenceId}`,
      threadId: threadRef.id,
      senderId: senderRef.id,
      recipientIds: recipientRefs.map((value) => value.id),
      content: item.content,
      metadata,
    }, {
      operationKey: "message",
      threadId: threadRef.id,
      routing: {
        senderId: senderRef.id,
        recipientIds: recipientRefs.map((value) => value.id),
      },
      visibility: { kind: "public" },
      identity: { metadata },
    });
    return Object.freeze({
      messageId: messageRef.id,
      threadId: threadRef.id,
    });
  }, { operationKey: `dispatch:${item.occurrenceId}` });
  const message = await context.collections.message.get({
    id: result.messageId,
  });
  if (!message) {
    throw new Error(`Scheduled message '${result.messageId}' was not created.`);
  }
  return Object.freeze({ messageId: message.id, threadId: result.threadId });
}

export const dispatchScheduledMessageAction: ActionDefinition<
  CoreScheduledMessageOccurrence,
  DispatchScheduledMessageResult,
  CoreSchedulesActionContext,
  undefined,
  undefined
> = defineAction({
  id: "copilotz.core-schedules.dispatch-message",
  execute: dispatchScheduledMessage,
});
