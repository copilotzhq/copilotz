import type { Agent } from "../resources/index.ts";
import type { CollectionRecord } from "../domain/index.ts";
import type { CopilotzProcessorContext } from "../engine/index.ts";
import { requireFeatureActions } from "../features/context.ts";
import {
  type CopilotzPlugin,
  definePlugin,
  defineProcessor,
  type Processor,
} from "../plugins/index.ts";
import { scheduledJobCollection } from "./collection.ts";
import type {
  CreateScheduledJobsPluginOptions,
  ScheduledJobOccurrence,
} from "./types.ts";
import { createScheduledJobsTool } from "./tool.ts";

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
  context: CopilotzProcessorContext,
  collection: "participant" | "thread",
  externalId: string,
): Promise<CollectionRecord | null> {
  return (await context.collections[collection].queries.byExternalId({
    externalId,
  }))[0] ?? null;
}

function occurrence(value: unknown): ScheduledJobOccurrence {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Scheduled due event payload must be an object.");
  }
  const input = value as Partial<ScheduledJobOccurrence>;
  if (!input.run || !Array.isArray(input.run.content)) {
    throw new TypeError("Scheduled due event requires canonical run content.");
  }
  return Object.freeze({
    jobId: required(input.jobId, "Scheduled job ID"),
    jobName: required(input.jobName, "Scheduled job name"),
    occurrenceId: required(input.occurrenceId, "Scheduled occurrence ID"),
    scheduledFor: required(input.scheduledFor, "Scheduled occurrence time"),
    run: Object.freeze(structuredClone(input.run)),
  });
}

async function sender(
  item: ScheduledJobOccurrence,
  context: CopilotzProcessorContext,
): Promise<CollectionRecord> {
  const descriptor = item.run.sender;
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
    return existing;
  }
  return await context.collections.participant.create({
    ...(descriptor?.id ? { id: descriptor.id } : {}),
    externalId,
    participantType: "job",
    name: descriptor?.name?.trim() || item.jobName,
    ...(descriptor?.email ? { email: descriptor.email } : {}),
    metadata: {
      ...structuredClone(descriptor?.metadata ?? {}),
      scheduledJobId: item.jobId,
    },
  }, { operationKey: `scheduled-sender:${item.jobId}` });
}

async function agentParticipant(
  agent: Agent,
  context: CopilotzProcessorContext,
): Promise<CollectionRecord> {
  const externalId = agent.externalId?.trim() || agent.id;
  const existing = await byExternalId(context, "participant", externalId);
  if (existing) {
    if (existing.participantType !== "agent") {
      throw new Error(
        `Agent identity '${externalId}' belongs to a non-agent participant.`,
      );
    }
    return existing;
  }
  return await context.collections.participant.create({
    externalId,
    participantType: "agent",
    agentId: agent.id,
    name: agent.name,
  }, { operationKey: `scheduled-agent:${agent.id}` });
}

async function recipient(
  reference: string,
  context: CopilotzProcessorContext,
): Promise<CollectionRecord> {
  const id = required(reference, "Scheduled recipient");
  const existing = await context.collections.participant.get({ id }) ??
    await byExternalId(context, "participant", id);
  if (existing) return existing;
  const agent = context.resources.get<Agent>("agents", id);
  if (agent) return await agentParticipant(agent, context);
  throw new Error(`Scheduled recipient '${id}' was not found.`);
}

async function resolveThread(
  item: ScheduledJobOccurrence,
  senderParticipant: CollectionRecord,
  recipients: readonly CollectionRecord[],
  context: CopilotzProcessorContext,
): Promise<CollectionRecord> {
  const descriptor = item.run.thread;
  let thread = descriptor?.id
    ? await context.collections.thread.get({ id: descriptor.id })
    : descriptor?.externalId
    ? await byExternalId(context, "thread", descriptor.externalId)
    : await byExternalId(context, "thread", `scheduled-job:${item.jobId}`);
  if (!thread) {
    thread = await context.collections.thread.create({
      ...(descriptor?.id ? { id: descriptor.id } : {}),
      externalId: descriptor?.externalId?.trim() ||
        `scheduled-job:${item.jobId}`,
      ...(descriptor?.status ? { status: descriptor.status } : {}),
      metadata: {
        ...structuredClone(descriptor?.metadata ?? {}),
        scheduledJobId: item.jobId,
      },
      participantIds: [
        senderParticipant.id,
        ...recipients.map((value) => value.id),
      ],
    }, { operationKey: `scheduled-thread:${item.jobId}` });
  }
  const ids = new Set(stringArray(thread.participantIds));
  for (const participant of [senderParticipant, ...recipients]) {
    if (ids.has(participant.id)) continue;
    thread = await context.collections.thread.update({
      id: thread.id,
      set: { participantIds: [...ids, participant.id] },
    }, {
      operationKey:
        `scheduled-thread-participant:${item.occurrenceId}:${participant.id}`,
      threadId: thread.id,
    });
    ids.add(participant.id);
  }
  return thread;
}

async function dispatchOccurrence(
  item: ScheduledJobOccurrence,
  context: CopilotzProcessorContext,
): Promise<void> {
  const sendingParticipant = await sender(item, context);
  let recipients = await Promise.all(
    (item.run.recipientIds ?? []).map((value) => recipient(value, context)),
  );
  let thread = await resolveThread(
    item,
    sendingParticipant,
    recipients,
    context,
  );
  if (recipients.length === 0) {
    const participantIds = stringArray(thread.participantIds);
    recipients = (await Promise.all(
      participantIds.map((id) => context.collections.participant.get({ id })),
    )).filter((value): value is CollectionRecord =>
      value !== null && value.participantType === "agent"
    );
  }
  if (recipients.length === 0) {
    throw new Error(`Scheduled job '${item.jobId}' has no agent recipient.`);
  }
  thread = await resolveThread(
    item,
    sendingParticipant,
    recipients,
    context,
  );
  await requireFeatureActions(context, "copilotz.core.thread-message").create({
    id: `scheduled:${item.occurrenceId}`,
    threadId: thread.id,
    sender: sendingParticipant,
    recipientIds: recipients.map((value) => value.id),
    content: item.run.content,
    metadata: {
      ...structuredClone(item.run.metadata ?? {}),
      scheduledJob: {
        jobId: item.jobId,
        jobName: item.jobName,
        occurrenceId: item.occurrenceId,
        scheduledFor: item.scheduledFor,
      },
    },
  }, { operationKey: `scheduled-message:${item.occurrenceId}` });
}

const scheduledJobsDispatchProcessor: Processor<CopilotzProcessorContext> =
  defineProcessor<CopilotzProcessorContext>({
    id: "scheduled_jobs.dispatch",
    on: [{ eventType: "scheduled_job.due" }],
    async handle(event, context) {
      if (!event.durable) return;
      await dispatchOccurrence(occurrence(event.payload), context);
    },
  });

/** Packages the schedule collection and its Oxian-delivered due processor. */
export function createScheduledJobsPlugin(
  options: CreateScheduledJobsPluginOptions = {},
): CopilotzPlugin {
  const tool = createScheduledJobsTool(options.toolId);
  return definePlugin({
    manifest: {
      id: options.id?.trim() || "@copilotz/scheduled-jobs",
      version: options.version?.trim() || "3.0.0",
      provides: {
        collections: [scheduledJobCollection.name],
        processors: [scheduledJobsDispatchProcessor.id],
        tools: [tool.key],
      },
    },
    resources: {
      collections: [scheduledJobCollection],
      processors: [scheduledJobsDispatchProcessor],
      tools: [tool],
    },
  });
}
