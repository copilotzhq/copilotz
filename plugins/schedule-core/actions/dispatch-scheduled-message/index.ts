/**
 * Defines the Action that projects one due Scheduled Job into a Core Message.
 *
 * @module
 */
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
import type { CoreResources } from "@copilotz/copilotz/core";
import type {
  CoreScheduledMessageOccurrence,
  DispatchScheduledMessageResult,
} from "../../shared/contracts.ts";
import {
  type CoreScheduledAgent,
  resolveConfiguredScheduledAgent,
} from "../../shared/recipients.ts";
type ParticipantPlan =
  | Readonly<{
    existing: CollectionRecord;
  }>
  | Readonly<{
    create: Readonly<Record<string, unknown>>;
    operationKey: string;
  }>;
type CoreSchedulesActionContext =
  & Omit<ActionContext, "resources">
  & Readonly<{
    resources:
      & RuntimeContextNamespaces
      & Readonly<{
        agents: CoreResources["agents"];
      }>;
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
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

type SpaceOwnership =
  | Readonly<{ status: "unscoped" | "owned" }>
  | Readonly<{
    status: "skipped";
    reason: "space_ownership";
    jobId: string;
  }>;

type ThreadTarget = Readonly<{
  id?: string;
  ambiguous: boolean;
}>;

async function resolveThreadTarget(
  descriptor: CoreScheduledMessageOccurrence["payload"]["thread"],
  context: CoreSchedulesActionContext,
): Promise<ThreadTarget> {
  const id = text(descriptor?.id);
  if (id) return { id, ambiguous: false };
  const externalId = text(descriptor?.externalId);
  if (!externalId) return { ambiguous: true };
  const matches = await context.collections.thread.queries.byExternalId({
    externalId,
  });
  return matches.length === 1
    ? { id: text(matches[0].id), ambiguous: false }
    : { ambiguous: true };
}

async function checkSpaceOwnership(
  item: CoreScheduledMessageOccurrence,
  context: CoreSchedulesActionContext,
  transaction: ActionTransactionContext,
): Promise<SpaceOwnership> {
  const scheduledJobs = context.collections.scheduledJob;
  const job = scheduledJobs && await scheduledJobs.get({ id: item.jobId });
  const spaceId = text(job?.spaceId);
  if (!spaceId) return { status: "unscoped" };
  if (!scheduledJobs || !transaction.collections.scheduledJob) {
    return { status: "skipped", reason: "space_ownership", jobId: item.jobId };
  }

  // Space moves touch this same Space. Read ownership again
  // after staging the fence; never downgrade a formerly owned occurrence.
  await transaction.collections.space.commands.touch({ id: spaceId });
  const currentJob = await scheduledJobs.get({ id: item.jobId });
  if (text(currentJob?.spaceId) !== spaceId) {
    return { status: "skipped", reason: "space_ownership", jobId: item.jobId };
  }
  if (!currentJob) {
    return { status: "skipped", reason: "space_ownership", jobId: item.jobId };
  }
  if (currentJob.status !== "active") {
    return { status: "skipped", reason: "space_ownership", jobId: item.jobId };
  }
  const payload = record(currentJob.payload);
  const liveTarget = await resolveThreadTarget(
    record(
      payload.thread,
    ) as CoreScheduledMessageOccurrence["payload"]["thread"],
    context,
  );
  const occurrenceTarget = await resolveThreadTarget(
    item.payload.thread,
    context,
  );
  const targetChanged = liveTarget.ambiguous || occurrenceTarget.ambiguous ||
    !liveTarget.id || liveTarget.id !== occurrenceTarget.id;
  const targetThreadId = liveTarget.id;
  const targetThread = targetThreadId
    ? await context.collections.thread.get({ id: targetThreadId })
    : null;
  const ownsLiveTarget = !liveTarget.ambiguous && Boolean(liveTarget.id) &&
    text(targetThread?.spaceId) === spaceId;
  if (ownsLiveTarget) {
    // An edited job may already point somewhere valid. Drop the old queued
    // occurrence without pausing the newly configured schedule.
    return targetChanged
      ? { status: "skipped", reason: "space_ownership", jobId: item.jobId }
      : { status: "owned" };
  }
  await transaction.collections.scheduledJob.update({
    id: item.jobId,
    set: {
      status: "paused",
      nextRunAt: null,
      nextRunAtMs: null,
      metadata: {
        ...structuredClone(record(currentJob.metadata)),
        scheduledPause: {
          reason: "target_thread_space_unavailable",
          ...(targetThreadId ? { threadId: targetThreadId } : {}),
          fromSpaceId: spaceId,
          at: context.now().toISOString(),
        },
      },
    },
  });
  return { status: "skipped", reason: "space_ownership", jobId: item.jobId };
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
  return ({ existing: record } as const);
}
function participantPlanKey(plan: ParticipantPlan): string {
  if ("existing" in plan) {
    return `existing:${plan.existing.id}`;
  }
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
  return ({
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
  } as const);
}
async function resolveAgentParticipant(
  agent: CoreScheduledAgent,
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
  return ({
    create: {
      externalId,
      participantType: "agent",
      agentId: agent.id,
      name: agent.name,
    },
    operationKey: `agent:${agent.id}`,
  } as const);
}
async function resolveRecipient(
  reference: string,
  context: CoreSchedulesActionContext,
): Promise<ParticipantPlan> {
  const id = required(reference, "Scheduled recipient");
  const existing = await context.collections.participant.get({ id }) ??
    await byExternalId(context, "participant", id);
  if (existing) {
    return existingParticipant(existing);
  }
  const agents = context.resources.agents ?? {};
  const agent = resolveConfiguredScheduledAgent(id, agents);
  if (agent) {
    return await resolveAgentParticipant(agent, context);
  }
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
function uniqueParticipantPlans(
  plans: readonly ParticipantPlan[],
): readonly ParticipantPlan[] {
  return ([
    ...new Map(plans.map((plan) => [participantPlanKey(plan), plan])).values(),
  ] as const);
}
async function stageParticipant(
  plan: ParticipantPlan,
  collections: ActionTransactionContext["collections"],
): Promise<CollectionMutationRef> {
  if ("existing" in plan) {
    return ({ id: plan.existing.id } as const);
  }
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
    const ownership = await checkSpaceOwnership(item, context, transaction);
    if (ownership.status === "skipped") return ownership;
    const sender = await resolveSender(item, context);
    const existingThread = await findThread(item, context);
    const recipients = uniqueParticipantPlans(
      await Promise.all(
        (item.payload.recipientIds ?? []).map((value) =>
          resolveRecipient(value, context)
        ),
      ),
    );
    if (recipients.length === 0) {
      throw new Error(`Scheduled job '${item.jobId}' has no recipient.`);
    }
    const senderRef = await stageParticipant(sender, transaction.collections);
    const recipientRefs = await Promise.all(
      recipients.map((plan) => stageParticipant(plan, transaction.collections)),
    );
    const participantIds = [
      ...new Set([senderRef.id, ...recipientRefs.map((value) => value.id)]),
    ];
    const threadRef = existingThread
      ? ({ id: existingThread.id } as const)
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
        if (existingIds.has(participantId)) {
          continue;
        }
        await transaction.collections.thread.commands.addParticipant({
          id: threadRef.id,
          participantId,
        }, {
          operationKey: `thread-participant:${participantId}`,
          metadata: {
            core: {
              threadId: threadRef.id,
            },
          },
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
      identity: { metadata },
      metadata: {
        core: {
          threadId: threadRef.id,
          routing: {
            senderId: senderRef.id,
            recipientIds: recipientRefs.map((value) => value.id),
          },
          visibility: { kind: "public" },
        },
      },
    });
    return ({
      status: "sent",
      messageId: messageRef.id,
      threadId: threadRef.id,
    } as const);
  }, { operationKey: `dispatch:${item.occurrenceId}` });
  if (result.status === "skipped") return result;
  const message = await context.collections.message.get({
    id: result.messageId,
  });
  if (!message) {
    throw new Error(`Scheduled message '${result.messageId}' was not created.`);
  }
  return ({
    status: "sent",
    messageId: message.id,
    threadId: result.threadId,
  } as const);
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
export default dispatchScheduledMessageAction;
