import type { Agent } from "../resources/index.ts";
import type {
  ConversationThread,
  Participant,
  ParticipantInput,
} from "../domain/index.ts";
import type { CopilotzProcessorContext } from "../engine/index.ts";
import {
  type CopilotzPlugin,
  definePlugin,
  defineProcessor,
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

function participantInput(value: Participant): ParticipantInput {
  return {
    id: value.id,
    externalId: value.externalId,
    participantType: value.participantType,
    ...(value.name ? { name: value.name } : {}),
    ...(value.email ? { email: value.email } : {}),
    ...(value.agentId ? { agentId: value.agentId } : {}),
    metadata: structuredClone(value.metadata),
  };
}

async function sender(
  item: ScheduledJobOccurrence,
  context: CopilotzProcessorContext,
): Promise<Participant> {
  const descriptor = item.run.sender;
  const externalId = descriptor?.externalId?.trim() || item.jobId;
  const existing = descriptor?.id
    ? await context.conversation.getParticipant(descriptor.id)
    : await context.conversation.getParticipantByExternalId(externalId);
  if (existing) {
    if (existing.participantType !== "job") {
      throw new Error(
        `Scheduled sender '${externalId}' belongs to a non-job participant.`,
      );
    }
    return existing;
  }
  const result = await context.conversation.createParticipant({
    participant: {
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
  }, { operationKey: `scheduled-sender:${item.jobId}` });
  if (!result.value) throw new Error("Scheduled sender was not created.");
  return result.value;
}

async function agentParticipant(
  agent: Agent,
  context: CopilotzProcessorContext,
): Promise<Participant> {
  const externalId = agent.externalId?.trim() || agent.id;
  const existing = await context.conversation.getParticipantByExternalId(
    externalId,
  );
  if (existing) {
    if (existing.participantType !== "agent") {
      throw new Error(
        `Agent identity '${externalId}' belongs to a non-agent participant.`,
      );
    }
    return existing;
  }
  const result = await context.conversation.createParticipant({
    participant: {
      externalId,
      participantType: "agent",
      agentId: agent.id,
      name: agent.name,
    },
  }, { operationKey: `scheduled-agent:${agent.id}` });
  if (!result.value) throw new Error(`Agent '${agent.id}' was not created.`);
  return result.value;
}

async function recipient(
  reference: string,
  context: CopilotzProcessorContext,
): Promise<Participant> {
  const id = required(reference, "Scheduled recipient");
  const existing = await context.conversation.getParticipant(id) ??
    await context.conversation.getParticipantByExternalId(id);
  if (existing) return existing;
  const agent = context.resources.get<Agent>("agents", id);
  if (agent) return await agentParticipant(agent, context);
  throw new Error(`Scheduled recipient '${id}' was not found.`);
}

async function resolveThread(
  item: ScheduledJobOccurrence,
  senderParticipant: Participant,
  recipients: readonly Participant[],
  context: CopilotzProcessorContext,
): Promise<ConversationThread> {
  const descriptor = item.run.thread;
  let thread = descriptor?.id
    ? await context.conversation.getThread(descriptor.id)
    : descriptor?.externalId
    ? await context.conversation.getThreadByExternalId(descriptor.externalId)
    : await context.conversation.getThreadByExternalId(
      `scheduled-job:${item.jobId}`,
    );
  if (!thread) {
    const result = await context.conversation.createThread({
      ...(descriptor?.id ? { id: descriptor.id } : {}),
      externalId: descriptor?.externalId?.trim() ||
        `scheduled-job:${item.jobId}`,
      ...(descriptor?.status ? { status: descriptor.status } : {}),
      metadata: {
        ...structuredClone(descriptor?.metadata ?? {}),
        scheduledJobId: item.jobId,
      },
      participants: [senderParticipant, ...recipients].map(participantInput),
    }, { operationKey: `scheduled-thread:${item.jobId}` });
    if (!result.value) throw new Error("Scheduled thread was not created.");
    thread = result.value;
  }
  const ids = new Set(thread.participants.map((value) => value.id));
  for (const participant of [senderParticipant, ...recipients]) {
    if (ids.has(participant.id)) continue;
    const result = await context.conversation.addThreadParticipant({
      threadId: thread.id,
      participant: participantInput(participant),
    }, {
      operationKey:
        `scheduled-thread-participant:${item.occurrenceId}:${participant.id}`,
    });
    if (!result.value) throw new Error("Scheduled participant was not added.");
    thread = result.value;
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
    recipients = thread.participants.filter((value) =>
      value.participantType === "agent"
    );
  }
  if (recipients.length === 0) {
    throw new Error(`Scheduled job '${item.jobId}' has no agent recipient.`);
  }
  // A default thread may have been resolved before recipient inference.
  thread = await resolveThread(
    item,
    sendingParticipant,
    recipients,
    context,
  );
  await context.conversation.createMessage({
    id: `scheduled:${item.occurrenceId}`,
    threadId: thread.id,
    sender: participantInput(sendingParticipant),
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

/** Packages the schedule collection and its Oxian-delivered due processor. */
export function createScheduledJobsPlugin(
  options: CreateScheduledJobsPluginOptions = {},
): CopilotzPlugin {
  const tool = createScheduledJobsTool(options.toolId);
  const processor = defineProcessor<CopilotzProcessorContext>({
    id: "scheduled_jobs.dispatch",
    on: ["scheduled_job.due"],
    delivery: "durable",
    async handle(event, context) {
      if (!event.durable) return;
      await dispatchOccurrence(occurrence(event.payload), context);
    },
  });
  return definePlugin({
    manifest: {
      id: options.id?.trim() || "@copilotz/scheduled-jobs",
      version: options.version?.trim() || "3.0.0",
      provides: {
        collections: [scheduledJobCollection.name],
        processors: [processor.id],
        tools: [tool.key],
      },
    },
    resources: {
      collections: [scheduledJobCollection],
      processors: [processor],
      tools: [tool],
    },
  });
}
