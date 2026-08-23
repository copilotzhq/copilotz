import type { Agent } from "../resources/index.ts";
import type { CollectionRecord } from "../domain/index.ts";
import type { CollectionEventBody } from "../collections/index.ts";
import type { CopilotzProcessorContext } from "../engine/index.ts";
import {
  type ActionCaller,
  type ActionCallOptions,
  type ActionContext,
  type ActionContextNamespaces,
  type ActionDefinition,
  defineAction,
} from "../actions/index.ts";
import {
  type CopilotzPlugin,
  definePlugin,
  defineProcessor,
  type Processor,
  type ProcessorEvent,
} from "../plugins/index.ts";
import type { WorkflowTool } from "../tools/index.ts";
import { scheduledJobCollection } from "./collection.ts";
import type {
  CreateScheduledJobsPluginOptions,
  ScheduledJobOccurrence,
} from "./types.ts";
import { createScheduledJobsTool } from "./tool.ts";

type CreateThreadMessage = (
  input: Readonly<{
    id?: string;
    threadId: string;
    sender: CollectionRecord;
    recipientIds?: readonly string[];
    content: ScheduledJobOccurrence["run"]["content"];
    metadata?: Readonly<Record<string, unknown>>;
  }>,
  options?: ActionCallOptions,
) => Promise<CollectionRecord>;

type ScheduledJobsDispatchContext =
  & Omit<ActionContext, "actions" | "resources">
  & Readonly<{
    resources:
      & ActionContextNamespaces
      & Readonly<{
        agents: Readonly<Record<string, Agent | undefined>>;
      }>;
    actions: Readonly<{ createThreadMessage: CreateThreadMessage }>;
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
  context: ScheduledJobsDispatchContext,
  collection: "participant" | "thread",
  externalId: string,
): Promise<CollectionRecord | null> {
  return (await context.collections[collection].queries.byExternalId({
    externalId,
  }))[0] ?? null;
}

function payloadOccurrence(value: unknown): ScheduledJobOccurrence | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const input = value as Partial<ScheduledJobOccurrence>;
  if (!input.run || !Array.isArray(input.run.content)) return undefined;
  return Object.freeze({
    jobId: required(input.jobId, "Scheduled job ID"),
    jobName: required(input.jobName, "Scheduled job name"),
    occurrenceId: required(input.occurrenceId, "Scheduled occurrence ID"),
    scheduledFor: required(input.scheduledFor, "Scheduled occurrence time"),
    run: Object.freeze(structuredClone(input.run)),
  });
}

function collectionBodyOccurrence(
  event: ProcessorEvent,
): ScheduledJobOccurrence {
  const body = event.data as Partial<CollectionEventBody<CollectionRecord>>;
  if (!body || typeof body !== "object" || !body.record) {
    throw new TypeError("Scheduled due event data must include a job record.");
  }
  const job = body.record as CollectionRecord;
  const run = job.run as ScheduledJobOccurrence["run"] | undefined;
  if (!run || !Array.isArray(run.content)) {
    throw new TypeError("Scheduled due event requires canonical run content.");
  }
  const scheduledFor = required(
    job.lastRunAt,
    "Scheduled occurrence time",
  );
  const manual = event.metadata?.scheduledJob &&
    typeof event.metadata.scheduledJob === "object" &&
    (event.metadata.scheduledJob as { manual?: unknown }).manual === true;
  const deduplicationId = "deduplicationId" in event &&
      typeof event.deduplicationId === "string"
    ? event.deduplicationId
    : undefined;
  const occurrenceId = manual
    ? `${job.id}:manual:${
      encodeURIComponent(deduplicationId ?? event.correlationId)
    }`
    : `${job.id}:${
      typeof job.lastRunAtMs === "number"
        ? job.lastRunAtMs
        : new Date(scheduledFor).getTime()
    }`;
  return Object.freeze({
    jobId: job.id,
    jobName: required(job.name, "Scheduled job name"),
    occurrenceId,
    scheduledFor,
    run: Object.freeze(structuredClone(run)),
  });
}

function occurrence(event: ProcessorEvent): ScheduledJobOccurrence {
  const fromPayload = payloadOccurrence(event.payload);
  if (fromPayload) return fromPayload;
  if (!event.durable) {
    throw new TypeError("Scheduled due event payload must be an object.");
  }
  return collectionBodyOccurrence(event);
}

async function sender(
  item: ScheduledJobOccurrence,
  context: ScheduledJobsDispatchContext,
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
  context: ScheduledJobsDispatchContext,
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
  context: ScheduledJobsDispatchContext,
): Promise<CollectionRecord> {
  const id = required(reference, "Scheduled recipient");
  const existing = await context.collections.participant.get({ id }) ??
    await byExternalId(context, "participant", id);
  if (existing) return existing;
  const agents = context.resources.agents ?? {};
  const agent = agents[id] ??
    Object.values(agents).find((value) =>
      value?.id === id || value?.externalId === id
    );
  if (agent) return await agentParticipant(agent, context);
  throw new Error(`Scheduled recipient '${id}' was not found.`);
}

async function resolveThread(
  item: ScheduledJobOccurrence,
  senderParticipant: CollectionRecord,
  recipients: readonly CollectionRecord[],
  context: ScheduledJobsDispatchContext,
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
  context: ScheduledJobsDispatchContext,
): Promise<null> {
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
  await context.actions.createThreadMessage({
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
  return null;
}

export const dispatchScheduledJobAction: ActionDefinition<
  ScheduledJobOccurrence,
  null,
  ScheduledJobsDispatchContext,
  undefined,
  undefined
> = defineAction<
  ScheduledJobOccurrence,
  null,
  ScheduledJobsDispatchContext
>({
  id: "copilotz.scheduled-jobs.dispatch.dispatch",
  execute(
    input: ScheduledJobOccurrence,
    context: ScheduledJobsDispatchContext,
  ) {
    return dispatchOccurrence(input, context);
  },
});

type ScheduledJobsProcessorContext =
  & Omit<CopilotzProcessorContext, "actions">
  & Readonly<{
    actions: Readonly<{
      dispatchScheduledJob: ActionCaller<typeof dispatchScheduledJobAction>;
    }>;
  }>;

const scheduledJobsDispatchProcessor: Processor<ScheduledJobsProcessorContext> =
  defineProcessor<ScheduledJobsProcessorContext>({
    id: "scheduled_jobs.dispatch",
    on: [{ eventType: "scheduled_job.due" }],
    async handle(event, context) {
      if (!event.durable) return;
      await context.actions.dispatchScheduledJob(occurrence(event));
    },
  });

export type ScheduledJobsPlugin = CopilotzPlugin<
  string,
  string,
  readonly [],
  Readonly<{ scheduledJob: typeof scheduledJobCollection }>,
  Readonly<{ dispatchScheduledJob: typeof dispatchScheduledJobAction }>,
  Readonly<{
    dispatchScheduledJob: Processor<ScheduledJobsProcessorContext>;
  }>,
  Readonly<{
    tools: Readonly<Record<string, WorkflowTool | undefined>>;
  }>,
  Readonly<Record<never, never>>
>;

/** Packages the schedule collection and its Oxian-delivered due processor. */
export function createScheduledJobsPlugin(
  options: CreateScheduledJobsPluginOptions = {},
): ScheduledJobsPlugin {
  const tool = createScheduledJobsTool(options.toolId);
  return definePlugin({
    id: options.id?.trim() || "@copilotz/scheduled-jobs",
    version: options.version?.trim() || "3.0.0",
    collections: { scheduledJob: scheduledJobCollection },
    actions: { dispatchScheduledJob: dispatchScheduledJobAction },
    processors: { dispatchScheduledJob: scheduledJobsDispatchProcessor },
    resources: { tools: { [tool.key]: tool } },
  });
}
