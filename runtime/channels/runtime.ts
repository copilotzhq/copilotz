import type { Agent } from "../resources/index.ts";
import type { CopilotzApplication } from "../application/index.ts";
import type { AttachmentSendInput } from "../attachments/index.ts";
import type {
  ConversationThread,
  Participant,
  ParticipantInput,
} from "../domain/index.ts";
import type {
  ChannelDispatchResult,
  ChannelExecution,
  ChannelIngressEnvelope,
  ChannelParticipantRef,
  ChannelResource,
  ChannelRuntime,
  ChannelThreadInput,
  CreateChannelRuntimeOptions,
} from "./types.ts";

function requiredText(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${name} must be non-empty.`);
  return normalized;
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

function isMessageInput(
  input: AttachmentSendInput,
): input is Extract<AttachmentSendInput, { content: unknown }> {
  return "content" in input;
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

async function refreshThread(
  application: CopilotzApplication,
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
  const updated = await application.conversation.updateThread({
    namespace,
    id: thread.id,
    patch: {
      ...(nameChanged ? { name: descriptor.name! } : {}),
      ...(descriptionChanged ? { description: descriptor.description! } : {}),
      ...(statusChanged ? { status: descriptor.status! } : {}),
      ...(metadataChanged ? { metadata } : {}),
    },
  });
  if (!updated.value) throw new Error(`Thread '${thread.id}' was not updated.`);
  return updated.value;
}

function participantInput(participant: Participant): ParticipantInput {
  return {
    id: participant.id,
    externalId: participant.externalId,
    participantType: participant.participantType,
    ...(participant.name ? { name: participant.name } : {}),
    ...(participant.email ? { email: participant.email } : {}),
    ...(participant.agentId ? { agentId: participant.agentId } : {}),
    metadata: structuredClone(participant.metadata),
  };
}

async function agentParticipant(
  application: CopilotzApplication,
  namespace: string,
  agent: Agent,
): Promise<Participant> {
  const externalId = agent.externalId?.trim() || agent.id;
  const existing = await application.conversation.getParticipantByExternalId(
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
  const created = await application.conversation.createParticipant({
    namespace,
    participant: {
      externalId,
      participantType: "agent",
      agentId: agent.id,
      name: agent.name,
    },
    identity: { deduplicationId: `channel:agent:${namespace}:${agent.id}` },
  });
  if (!created.value) {
    throw new Error(`Agent participant '${agent.id}' was not created.`);
  }
  return created.value;
}

async function resolveParticipant(
  application: CopilotzApplication,
  namespace: string,
  reference: ChannelParticipantRef,
): Promise<Participant> {
  if (typeof reference === "string") {
    const id = requiredText(reference, "Channel participant");
    const existing =
      await application.conversation.getParticipant(namespace, id) ??
        await application.conversation.getParticipantByExternalId(
          namespace,
          id,
        );
    if (existing) return existing;
    const agent = application.plugins.get<Agent>("agents", id);
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
  const existing = await application.conversation.getParticipantByExternalId(
    namespace,
    externalId,
  );
  if (existing) return existing;
  const created = await application.conversation.createParticipant({
    namespace,
    participant: { ...reference, externalId },
  });
  if (!created.value) {
    throw new Error(`Participant '${externalId}' was not created.`);
  }
  return created.value;
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
    recipients.push(await resolveParticipant(application, namespace, agentId));
  }
  return Object.freeze(recipients);
}

async function resolveThread(
  application: CopilotzApplication,
  namespace: string,
  reference: ChannelIngressEnvelope["thread"],
  participants: readonly Participant[],
): Promise<ConversationThread> {
  if (typeof reference === "string") {
    const id = requiredText(reference, "Channel thread");
    const existing = await application.conversation.getThread(namespace, id) ??
      await application.conversation.getThreadByExternalId(namespace, id);
    if (!existing) throw new Error(`Channel thread '${id}' was not found.`);
    return existing;
  }
  if (isThread(reference)) {
    if (reference.namespace !== namespace) {
      throw new Error("Channel thread belongs to another namespace.");
    }
    return reference;
  }
  const descriptor = reference as ChannelThreadInput;
  const id = descriptor.id?.trim() || undefined;
  const externalId = descriptor.externalId?.trim() || undefined;
  const existing = id
    ? await application.conversation.getThread(namespace, id)
    : externalId
    ? await application.conversation.getThreadByExternalId(
      namespace,
      externalId,
    )
    : null;
  if (existing) {
    return await refreshThread(
      application,
      namespace,
      existing,
      descriptor,
    );
  }
  if (!id && !externalId) {
    throw new TypeError("Channel thread requires an id or externalId.");
  }
  const created = await application.conversation.createThread({
    namespace,
    ...(id ? { id } : {}),
    ...(externalId ? { externalId } : {}),
    ...(descriptor.name?.trim() ? { name: descriptor.name.trim() } : {}),
    ...(descriptor.description?.trim()
      ? { description: descriptor.description.trim() }
      : {}),
    ...(descriptor.status ? { status: descriptor.status } : {}),
    ...(descriptor.metadata
      ? { metadata: structuredClone(descriptor.metadata) }
      : {}),
    participants: participants.map(participantInput),
  });
  if (!created.value) throw new Error("Channel thread was not created.");
  return created.value;
}

function sendInput(
  input: AttachmentSendInput,
  recipientIds: readonly string[],
): AttachmentSendInput {
  if (isMessageInput(input)) return { ...input, recipientIds };
  if ("mediaType" in input) {
    return {
      ...input,
      ...(recipientIds[0] ? { recipientId: recipientIds[0] } : {}),
    };
  }
  return { ...input, recipientIds };
}

async function startExecution(
  application: CopilotzApplication,
  namespace: string,
  channel: ChannelResource,
  envelope: ChannelIngressEnvelope,
): Promise<ChannelExecution> {
  const sender = await resolveParticipant(
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
      resolveParticipant(application, namespace, reference)
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
        resolveParticipant(application, namespace, reference)
      ),
    )
    : await defaultRecipients(application, namespace, channel, thread, sender);
  const participantIds = new Set(thread.participants.map((value) => value.id));
  for (
    const participant of [sender, ...declaredParticipants, ...recipients]
  ) {
    if (participantIds.has(participant.id)) continue;
    const added = await application.conversation.addThreadParticipant({
      namespace,
      threadId: thread.id,
      participant: participantInput(participant),
      identity: {
        deduplicationId:
          `channel:thread-participant:${namespace}:${thread.id}:${participant.id}`,
      },
    });
    if (!added.value) {
      throw new Error(
        `Participant '${participant.id}' was not added to the thread.`,
      );
    }
    thread = added.value;
    participantIds.add(participant.id);
  }
  const recipientIds = Object.freeze([
    ...new Set(recipients.map((value) => value.id)),
  ]);
  const attachment = await application.connect({
    namespace,
    thread,
    participant: sender,
    recipientIds,
  });
  try {
    const handle = await attachment.send(
      sendInput(envelope.input, recipientIds) as never,
    );
    return Object.freeze({
      attachment,
      handle,
      thread,
      participant: sender,
      recipientIds,
      outputs: attachment.outputs,
    });
  } catch (error) {
    await attachment.close("channel_send_failed").catch(() => undefined);
    throw error;
  }
}

/** Composes channel plugin resources over persistent attachments. */
export function createChannelRuntime(
  application: CopilotzApplication,
  options: CreateChannelRuntimeOptions = {},
): ChannelRuntime {
  const channels = application.plugins.list<ChannelResource>("channels");
  const byId = new Map(channels.map((channel) => [channel.id, channel]));
  return Object.freeze({
    list: () => channels,
    get: (id) => byId.get(id),
    async dispatch(namespaceInput, request) {
      const namespace = requiredText(namespaceInput, "Channel namespace");
      const ingress = byId.get(request.route.ingress);
      if (!ingress?.ingress) {
        throw new Error(
          `Channel ingress '${request.route.ingress}' was not found.`,
        );
      }
      const egress = byId.get(request.route.egress);
      if (!egress?.egress) {
        throw new Error(
          `Channel egress '${request.route.egress}' was not found.`,
        );
      }
      const normalized = await ingress.ingress.handle(request, {
        application,
        namespace,
        channel: ingress,
      });
      const executions = await Promise.all(
        (normalized.inputs ?? []).map((input) =>
          startExecution(application, namespace, ingress, input)
        ),
      );
      const tasks = executions.map((execution) => {
        const settle = execution.handle.done.finally(() =>
          execution.attachment.close("channel_execution_settled")
        );
        const deliver = egress.egress!.deliver({
          application,
          namespace,
          channel: egress,
          route: request.route,
          request,
          execution,
        });
        return Promise.all([settle, deliver]).then(() => undefined);
      });
      const done = Promise.all(tasks).then(() => undefined);
      if (!egress.egress.requestBound) {
        done.catch((error) => options.onDetachedError?.(error, request));
      }
      const result: ChannelDispatchResult = {
        status: normalized.status ?? 202,
        ...(normalized.response !== undefined
          ? { response: normalized.response }
          : {}),
        requestBound: egress.egress.requestBound === true,
        executions: Object.freeze(executions),
        done,
        async cancel(reason = "channel_cancelled") {
          await Promise.all(
            executions.map((execution) => execution.handle.cancel(reason)),
          );
        },
      };
      return Object.freeze(result);
    },
  });
}
