import { ulid } from "../../dependencies/ulid.ts";
import {
  workflowMutationId,
  workflowObject,
} from "../domain/workflow-support.ts";
import type { Agent } from "../resources/index.ts";
import type {
  ChannelParticipantRef,
  ChannelResource,
  ChannelThreadInput,
} from "./types.ts";
import type { CopilotzApplication } from "../application/index.ts";
import type {
  CollectionRecord,
  CollectionRuntime,
} from "../collections/index.ts";
import type {
  ConversationMessage,
  ConversationThread,
  Participant,
  ParticipantInput,
} from "../domain/index.ts";

function requiredText(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${name} must be non-empty.`);
  return normalized;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return Object.freeze([]);
  return Object.freeze(
    value.filter((item): item is string =>
      typeof item === "string" && Boolean(item.trim())
    ),
  );
}

function isParticipant(value: unknown): value is Participant {
  return Boolean(
    value && typeof value === "object" &&
      typeof (value as Participant).namespace === "string" &&
      typeof (value as Participant).createdAt === "string",
  );
}

function isThread(value: unknown): value is ConversationThread {
  return Boolean(
    value && typeof value === "object" &&
      typeof (value as ConversationThread).namespace === "string" &&
      Array.isArray((value as ConversationThread).participants),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function mergeMetadata(
  current: Readonly<Record<string, unknown>>,
  patch: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const result = structuredClone(current) as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    result[key] = isRecord(value) && isRecord(result[key])
      ? mergeMetadata(
        result[key] as Record<string, unknown>,
        value,
      )
      : structuredClone(value);
  }
  return result;
}

function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => sameValue(value, right[index]));
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) =>
      key === rightKeys[index] && sameValue(left[key], right[key])
    );
}

function mapParticipant(record: CollectionRecord): Participant {
  return Object.freeze({
    id: String(record.id),
    namespace: String(record.namespace),
    externalId: String(record.externalId ?? record.id),
    participantType: record.participantType as Participant["participantType"],
    ...(optionalText(record.name) ? { name: optionalText(record.name) } : {}),
    ...(optionalText(record.email)
      ? { email: optionalText(record.email) }
      : {}),
    ...(optionalText(record.agentId)
      ? { agentId: optionalText(record.agentId) }
      : {}),
    metadata: workflowObject(record.metadata),
    createdAt: String(record.createdAt),
    updatedAt: String(record.updatedAt),
  });
}

function mapThread(
  record: CollectionRecord,
  participants: readonly Participant[],
): ConversationThread {
  const branch = record.activeMessageBranch &&
      typeof record.activeMessageBranch === "object"
    ? record.activeMessageBranch as ConversationThread["activeMessageBranch"]
    : undefined;
  return Object.freeze({
    id: String(record.id),
    namespace: String(record.namespace),
    ...(optionalText(record.externalId)
      ? { externalId: optionalText(record.externalId) }
      : {}),
    ...(optionalText(record.name) ? { name: optionalText(record.name) } : {}),
    ...(optionalText(record.description)
      ? { description: optionalText(record.description) }
      : {}),
    status: String(record.status ?? "active"),
    ...(optionalText(record.parentThreadId)
      ? { parentThreadId: optionalText(record.parentThreadId) }
      : {}),
    metadata: workflowObject(record.metadata),
    participants,
    ...(branch ? { activeMessageBranch: branch } : {}),
    createdAt: String(record.createdAt),
    updatedAt: String(record.updatedAt),
  });
}

function mapMessage(
  record: CollectionRecord,
  sender: Participant,
): ConversationMessage {
  const revision = record.revision && typeof record.revision === "object"
    ? record.revision as ConversationMessage["revision"]
    : undefined;
  return Object.freeze({
    id: String(record.id),
    namespace: String(record.namespace),
    threadId: String(record.threadId),
    sender,
    recipientIds: stringArray(record.recipientIds),
    content: Array.isArray(record.content)
      ? Object.freeze(record.content) as ConversationMessage["content"]
      : Object.freeze([]),
    metadata: workflowObject(record.metadata),
    ...(revision ? { revision } : {}),
    createdAt: String(record.createdAt),
    updatedAt: String(record.updatedAt),
  });
}

async function hydrateThread(
  runtime: CollectionRuntime,
  namespace: string,
  record: CollectionRecord,
): Promise<ConversationThread> {
  const included = Array.isArray(record.participants)
    ? (record.participants as CollectionRecord[]).map(mapParticipant)
    : undefined;
  if (included) return mapThread(record, included);
  const participants = runtime.withScope({ namespace }).participant;
  const ids = stringArray(record.participantIds);
  const loaded = await Promise.all(
    ids.map((id) => participants.get({ id })),
  );
  return mapThread(
    record,
    loaded.filter((item): item is CollectionRecord => item !== null).map(
      mapParticipant,
    ),
  );
}

async function getParticipant(
  runtime: CollectionRuntime,
  namespace: string,
  id: string,
): Promise<Participant | null> {
  const record = await runtime.withScope({ namespace }).participant.get({ id });
  return record ? mapParticipant(record) : null;
}

async function getParticipantByExternalId(
  runtime: CollectionRuntime,
  namespace: string,
  externalId: string,
): Promise<Participant | null> {
  const [record] = await runtime.withScope({ namespace }).participant.queries
    .byExternalId({ externalId });
  return record ? mapParticipant(record) : null;
}

async function getThread(
  runtime: CollectionRuntime,
  namespace: string,
  id: string,
): Promise<ConversationThread | null> {
  const record = await runtime.withScope({ namespace }).thread.get({ id });
  return record ? await hydrateThread(runtime, namespace, record) : null;
}

async function getThreadByExternalId(
  runtime: CollectionRuntime,
  namespace: string,
  externalId: string,
): Promise<ConversationThread | null> {
  const [record] = await runtime.withScope({ namespace }).thread.queries
    .byExternalId({ externalId });
  return record ? await hydrateThread(runtime, namespace, record) : null;
}

function participantFields(input: ParticipantInput) {
  return {
    ...(input.id ? { id: input.id } : {}),
    externalId: requiredText(input.externalId, "Participant externalId"),
    participantType: input.participantType,
    ...(input.name ? { name: input.name } : {}),
    ...(input.email ? { email: input.email } : {}),
    ...(input.agentId ? { agentId: input.agentId } : {}),
    metadata: structuredClone(input.metadata ?? {}),
  };
}

async function ensureParticipant(
  runtime: CollectionRuntime,
  namespace: string,
  input: ParticipantInput,
  identity?: { deduplicationId: string },
): Promise<Participant> {
  const participants = runtime.withScope({ namespace }).participant;
  if (input.id?.trim()) {
    const existing = await participants.get({ id: input.id.trim() });
    if (existing) return mapParticipant(existing);
  }
  const [byExternal] = await participants.queries.byExternalId({
    externalId: requiredText(input.externalId, "Participant externalId"),
  });
  if (byExternal) return mapParticipant(byExternal);
  const created = await participants.create(
    participantFields(input),
    identity ? { identity } : undefined,
  );
  return mapParticipant(created);
}

async function agentParticipant(
  application: CopilotzApplication,
  namespace: string,
  agent: Agent,
): Promise<Participant> {
  const externalId = agent.externalId?.trim() || agent.id;
  const existing = await getParticipantByExternalId(
    application.collections,
    namespace,
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
  return await ensureParticipant(application.collections, namespace, {
    externalId,
    participantType: "agent",
    agentId: agent.id,
    name: agent.name,
  }, { deduplicationId: `channel:agent:${namespace}:${agent.id}` });
}

export async function resolveChannelParticipant(
  application: CopilotzApplication,
  namespace: string,
  reference: ChannelParticipantRef,
): Promise<Participant> {
  const runtime = application.collections;
  if (typeof reference === "string") {
    const id = requiredText(reference, "Channel participant");
    const existing = await getParticipant(runtime, namespace, id) ??
      await getParticipantByExternalId(runtime, namespace, id);
    if (existing) return existing;
    const agent = (application.plugins.resources.agents ?? {})[id] as
      | Agent
      | undefined;
    if (agent) return await agentParticipant(application, namespace, agent);
    throw new Error(`Channel participant '${id}' was not found.`);
  }
  if (isParticipant(reference)) {
    if (reference.namespace !== namespace) {
      throw new Error("Channel participant belongs to another namespace.");
    }
    return reference;
  }
  const externalId = requiredText(
    reference.externalId,
    "Channel participant externalId",
  );
  const existing = await getParticipantByExternalId(
    runtime,
    namespace,
    externalId,
  );
  if (existing) return existing;
  return await ensureParticipant(runtime, namespace, {
    ...reference,
    externalId,
  });
}

async function refreshThread(
  runtime: CollectionRuntime,
  namespace: string,
  thread: ConversationThread,
  descriptor: ChannelThreadInput,
): Promise<ConversationThread> {
  const metadata = descriptor.metadata
    ? mergeMetadata(thread.metadata, descriptor.metadata)
    : undefined;
  const statusChanged = descriptor.status !== undefined &&
    descriptor.status !== thread.status;
  const nameChanged = descriptor.name !== undefined &&
    descriptor.name !== thread.name;
  const descriptionChanged = descriptor.description !== undefined &&
    descriptor.description !== thread.description;
  const metadataChanged = metadata !== undefined &&
    !sameValue(metadata, thread.metadata);
  if (
    !nameChanged && !descriptionChanged && !statusChanged && !metadataChanged
  ) return thread;
  const set: Record<string, unknown> = {};
  if (nameChanged) set.name = descriptor.name;
  if (descriptionChanged) set.description = descriptor.description;
  if (statusChanged) set.status = descriptor.status;
  if (metadataChanged) set.metadata = metadata;
  const updated = await runtime.withScope({ namespace }).thread.update({
    id: thread.id,
    set,
  }, { threadId: thread.id });
  return await hydrateThread(runtime, namespace, updated);
}

async function resolveThread(
  application: CopilotzApplication,
  namespace: string,
  reference: string | ConversationThread | ChannelThreadInput,
  participants: readonly Participant[],
): Promise<ConversationThread> {
  const runtime = application.collections;
  if (typeof reference === "string") {
    const id = requiredText(reference, "Channel thread");
    const existing = await getThread(runtime, namespace, id) ??
      await getThreadByExternalId(runtime, namespace, id);
    if (!existing) throw new Error(`Channel thread '${id}' was not found.`);
    return existing;
  }
  if (isThread(reference)) {
    if (reference.namespace !== namespace) {
      throw new Error("Channel thread belongs to another namespace.");
    }
    return reference;
  }
  const descriptor = reference;
  const id = descriptor.id?.trim() || undefined;
  const externalId = descriptor.externalId?.trim() || undefined;
  const existing = id
    ? await getThread(runtime, namespace, id)
    : externalId
    ? await getThreadByExternalId(runtime, namespace, externalId)
    : null;
  if (existing) {
    return await refreshThread(runtime, namespace, existing, descriptor);
  }
  if (!id && !externalId) {
    throw new TypeError("Channel thread requires an id or externalId.");
  }
  const threadId = workflowMutationId(
    "thread",
    namespace,
    id,
    { deduplicationId: `channel:thread:${namespace}:${id ?? externalId}` },
    ulid,
  );
  const created = await runtime.withScope({ namespace }).thread.create({
    id: threadId,
    ...(externalId ? { externalId } : {}),
    ...(descriptor.name?.trim() ? { name: descriptor.name.trim() } : {}),
    ...(descriptor.description?.trim()
      ? { description: descriptor.description.trim() }
      : {}),
    status: descriptor.status ?? "active",
    ...(descriptor.metadata
      ? { metadata: structuredClone(descriptor.metadata) }
      : {}),
    participantIds: participants.map((participant) => participant.id),
  }, {
    operationKey: `channel:thread:${id ?? externalId}`,
    identity: {
      deduplicationId: `channel:thread:${namespace}:${id ?? externalId}`,
    },
  }) as CollectionRecord;
  return await hydrateThread(runtime, namespace, created);
}

async function addThreadParticipant(
  application: CopilotzApplication,
  namespace: string,
  thread: ConversationThread,
  participant: Participant,
): Promise<ConversationThread> {
  if (thread.participants.some((item) => item.id === participant.id)) {
    return thread;
  }
  await application.collections.withScope({ namespace }).thread.update({
    id: thread.id,
    set: {
      participantIds: [
        ...thread.participants.map((item) => item.id),
        participant.id,
      ],
    },
  }, {
    operationKey: `channel:thread-participant:${thread.id}:${participant.id}`,
    identity: {
      deduplicationId:
        `channel:thread-participant:${namespace}:${thread.id}:${participant.id}`,
    },
  });
  const updated = await getThread(
    application.collections,
    namespace,
    thread.id,
  );
  if (!updated) throw new Error(`Channel thread '${thread.id}' was not found.`);
  return updated;
}

async function defaultRecipients(
  application: CopilotzApplication,
  namespace: string,
  channel: ChannelResource,
  thread: ConversationThread | null,
  sender: Participant,
): Promise<readonly Participant[]> {
  const existing = (thread?.participants ?? []).filter((participant) =>
    participant.id !== sender.id && participant.participantType === "agent"
  );
  if (existing.length) return existing;
  const recipients: Participant[] = [];
  for (const agentId of channel.defaultAgentIds ?? []) {
    recipients.push(
      await resolveChannelParticipant(application, namespace, agentId),
    );
  }
  return Object.freeze(recipients);
}

export type ChannelIdentity = Readonly<{
  thread: ConversationThread;
  participant: Participant;
  recipientIds: readonly string[];
}>;

export async function resolveChannelIdentity(
  application: CopilotzApplication,
  namespace: string,
  channel: ChannelResource,
  envelope: Readonly<{
    thread: string | ConversationThread | ChannelThreadInput;
    participant: ChannelParticipantRef;
    recipients?: readonly ChannelParticipantRef[];
  }>,
): Promise<ChannelIdentity> {
  const sender = await resolveChannelParticipant(
    application,
    namespace,
    envelope.participant,
  );
  const declaredReferences = typeof envelope.thread === "string" ||
      isThread(envelope.thread)
    ? []
    : envelope.thread.participants ?? [];
  const declaredParticipants = await Promise.all(
    declaredReferences.map((reference) =>
      resolveChannelParticipant(application, namespace, reference)
    ),
  );
  let thread = await resolveThread(
    application,
    namespace,
    envelope.thread,
    [sender, ...declaredParticipants],
  );
  const recipients = envelope.recipients
    ? await Promise.all(
      envelope.recipients.map((reference) =>
        resolveChannelParticipant(application, namespace, reference)
      ),
    )
    : await defaultRecipients(application, namespace, channel, thread, sender);
  for (const participant of [sender, ...declaredParticipants, ...recipients]) {
    thread = await addThreadParticipant(
      application,
      namespace,
      thread,
      participant,
    );
  }
  return Object.freeze({
    thread,
    participant: sender,
    recipientIds: Object.freeze([
      ...new Set(recipients.map((value) => value.id)),
    ]),
  });
}

export async function loadChannelMessage(
  application: CopilotzApplication,
  namespace: string,
  id: string,
): Promise<ConversationMessage | null> {
  const collections = application.collections.withScope({ namespace });
  const record = await collections.message.get({ id });
  if (!record) return null;
  const sender = await collections.participant.get({
    id: String(record.senderId),
  });
  if (!sender) {
    throw new Error(`Message '${id}' sender was not found.`);
  }
  return mapMessage(record, mapParticipant(sender));
}

export {
  getThread as loadChannelThread,
  getThreadByExternalId as loadChannelThreadByExternalId,
};
