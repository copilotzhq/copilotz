/**
 * Turns one authenticated channel occurrence into Core graph records.
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
  ScopedCollections,
} from "@copilotz/copilotz/collections";
import { type AgentResource, setChannelContext } from "@copilotz/copilotz/core";
import { deriveWorkflowId } from "@copilotz/copilotz/events";
import { cloneChannelJson } from "../../authoring/channel-ingress/index.ts";
import { defineChannelResource } from "../../authoring/channel-resource/index.ts";
import type {
  ChannelAdapter,
  ChannelBindingRecord,
  ChannelIngressActionOutput,
  ChannelIngressInput,
  ChannelJsonObject,
  ChannelMessageVisibility,
  ChannelParticipantInput,
  ChannelParticipantRef,
  ChannelParticipantType,
  ChannelReceivedMessage,
  ChannelResource,
  ChannelThreadInput,
} from "../../internal/contracts.ts";

export const CHANNEL_INGRESS_ACTION_ID = "copilotz.channels.ingress";

const INGRESS_KEYS = new Set(["channelId", "id", "input"]);
const RECEIVED_KEYS = new Set([
  "externalThreadId",
  "sender",
  "recipients",
  "content",
  "thread",
  "route",
  "metadata",
  "visibility",
]);
const PARTICIPANT_KEYS = new Set([
  "id",
  "externalId",
  "participantType",
  "name",
  "email",
  "agentId",
  "metadata",
]);
const THREAD_KEYS = new Set([
  "name",
  "description",
  "status",
  "metadata",
  "participants",
]);
const PARTICIPANT_TYPES = new Set<ChannelParticipantType>([
  "human",
  "agent",
  "tool",
  "job",
]);

function identityTuple(...parts: readonly string[]): string {
  return JSON.stringify(["copilotz.channels.v1", ...parts]);
}

function scopedExternalId(channelId: string, externalId: string): string {
  return `channel:${identityTuple(channelId, externalId)}`;
}

export type ChannelActionResources =
  & RuntimeContextNamespaces
  & Readonly<{
    channels: Readonly<Record<string, ChannelResource | undefined>>;
    agents: Readonly<Record<string, AgentResource | undefined>>;
  }>;

export type ChannelActionAdapters =
  & RuntimeContextNamespaces
  & Readonly<{
    channels: Readonly<Record<string, ChannelAdapter | undefined>>;
  }>;

export type ChannelActionContext = ActionContext<
  ChannelActionResources,
  ChannelActionAdapters
>;

type ParticipantPlan = Readonly<{
  id: string;
  fields: ChannelParticipantInput;
  existing: CollectionRecord | null;
}>;

function requiredText(value: unknown, label: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new TypeError(`${label} must be non-empty.`);
  return normalized;
}

function optionalText(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredText(value, label);
}

function dataObject(
  value: unknown,
  allowed: ReadonlySet<string>,
  label: string,
): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object.`);
  }
  const snapshot: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new TypeError(`${label} cannot declare '${String(key)}'.`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new TypeError(
        `${label}.${key} must be an enumerable data property.`,
      );
    }
    if (descriptor.value === undefined) {
      throw new TypeError(`${label}.${key} cannot be undefined.`);
    }
    snapshot[key] = descriptor.value;
  }
  return Object.freeze(snapshot);
}

function dataArray(value: unknown, label: string): readonly unknown[] {
  if (
    !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
  ) {
    throw new TypeError(`${label} must be an exact array.`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Object.keys(value).length !== value.length ||
    Reflect.ownKeys(value).some((key) =>
      key !== "length" &&
      (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key) ||
        Number(key) >= value.length)
    )
  ) throw new TypeError(`${label} must be a dense data array.`);
  return Object.freeze(Array.from({ length: value.length }, (_, index) => {
    const descriptor = descriptors[String(index)];
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new TypeError(`${label}[${index}] must be a data property.`);
    }
    return descriptor.value;
  }));
}

function jsonObject(value: unknown, label: string): ChannelJsonObject {
  const cloned = cloneChannelJson(value, label);
  if (!cloned || typeof cloned !== "object" || Array.isArray(cloned)) {
    throw new TypeError(`${label} must be a JSON object.`);
  }
  return cloned as ChannelJsonObject;
}

function channelResource(
  context: ChannelActionContext,
  channelId: string,
): ChannelResource {
  const value = context.resources.channels?.[channelId];
  if (!value) {
    throw new Error(`Unknown Channel Resource alias '${channelId}'.`);
  }
  return defineChannelResource(value);
}

function channelAdapter(
  context: ChannelActionContext,
  channelId: string,
): ChannelAdapter {
  const value = context.adapters.channels?.[channelId];
  if (!value || typeof value.receive !== "function") {
    throw new Error(`Unknown Channel Adapter alias '${channelId}'.`);
  }
  return value;
}

function participant(
  value: unknown,
  label: string,
): ChannelParticipantInput {
  const snapshot = dataObject(value, PARTICIPANT_KEYS, label);
  const participantType = snapshot.participantType;
  if (
    typeof participantType !== "string" ||
    !PARTICIPANT_TYPES.has(participantType as ChannelParticipantType)
  ) throw new TypeError(`${label} has an invalid participantType.`);
  const metadata = snapshot.metadata === undefined
    ? undefined
    : jsonObject(snapshot.metadata, `${label} metadata`);
  return Object.freeze({
    ...(optionalText(snapshot.id, `${label} ID`)
      ? { id: optionalText(snapshot.id, `${label} ID`) }
      : {}),
    externalId: requiredText(snapshot.externalId, `${label} external ID`),
    participantType: participantType as ChannelParticipantType,
    ...(optionalText(snapshot.name, `${label} name`)
      ? { name: optionalText(snapshot.name, `${label} name`) }
      : {}),
    ...(optionalText(snapshot.email, `${label} email`)
      ? { email: optionalText(snapshot.email, `${label} email`) }
      : {}),
    ...(optionalText(snapshot.agentId, `${label} Agent ID`)
      ? { agentId: optionalText(snapshot.agentId, `${label} Agent ID`) }
      : {}),
    ...(metadata ? { metadata } : {}),
  });
}

function thread(value: unknown): ChannelThreadInput {
  const snapshot = dataObject(value, THREAD_KEYS, "Channel thread");
  const metadata = snapshot.metadata === undefined
    ? undefined
    : jsonObject(snapshot.metadata, "Channel thread metadata");
  const participants = snapshot.participants === undefined
    ? undefined
    : Object.freeze(
      dataArray(snapshot.participants, "Channel thread participants").map(
        (item, index): ChannelParticipantRef =>
          typeof item === "string"
            ? requiredText(item, `Channel thread participant[${index}]`)
            : participant(item, `Channel thread participant[${index}]`),
      ),
    );
  return Object.freeze({
    ...(optionalText(snapshot.name, "Channel thread name")
      ? { name: optionalText(snapshot.name, "Channel thread name") }
      : {}),
    ...(optionalText(snapshot.description, "Channel thread description")
      ? {
        description: optionalText(
          snapshot.description,
          "Channel thread description",
        ),
      }
      : {}),
    ...(optionalText(snapshot.status, "Channel thread status")
      ? { status: optionalText(snapshot.status, "Channel thread status") }
      : {}),
    ...(metadata ? { metadata } : {}),
    ...(participants ? { participants } : {}),
  });
}

function visibility(value: unknown): ChannelMessageVisibility {
  if (value === undefined) return "participants";
  if (value === "public" || value === "participants" || value === "internal") {
    return value;
  }
  throw new TypeError(
    "Channel visibility must be public, participants, or internal.",
  );
}

function receivedMessage(value: unknown): ChannelReceivedMessage {
  const snapshot = dataObject(value, RECEIVED_KEYS, "Received Channel message");
  const recipients = snapshot.recipients === undefined
    ? undefined
    : dataArray(snapshot.recipients, "Channel recipients").map(
      (item, index): ChannelParticipantRef =>
        typeof item === "string"
          ? requiredText(item, `Channel recipient[${index}]`)
          : participant(item, `Channel recipient[${index}]`),
    );
  const content = Array.isArray(snapshot.content)
    ? dataArray(snapshot.content, "Channel content")
    : snapshot.content;
  if (content === undefined) {
    throw new TypeError("Received Channel message requires content.");
  }
  return Object.freeze({
    externalThreadId: requiredText(
      snapshot.externalThreadId,
      "External Channel thread ID",
    ),
    sender: participant(snapshot.sender, "Channel sender"),
    ...(recipients ? { recipients: Object.freeze(recipients) } : {}),
    content: content as ChannelReceivedMessage["content"],
    ...(snapshot.thread === undefined
      ? {}
      : { thread: thread(snapshot.thread) }),
    route: snapshot.route === undefined
      ? Object.freeze({})
      : jsonObject(snapshot.route, "Channel route"),
    metadata: snapshot.metadata === undefined
      ? Object.freeze({})
      : jsonObject(snapshot.metadata, "Channel metadata"),
    visibility: visibility(snapshot.visibility),
  });
}

function ingressInput(value: unknown): ChannelIngressInput {
  const snapshot = dataObject(
    value,
    INGRESS_KEYS,
    "Channel ingress Action input",
  );
  return Object.freeze({
    channelId: requiredText(snapshot.channelId, "Channel alias"),
    id: requiredText(snapshot.id, "Channel occurrence ID"),
    input: cloneChannelJson(snapshot.input, "Channel occurrence input"),
  });
}

async function byExternalId(
  collections: ScopedCollections,
  collection: "participant" | "thread",
  externalId: string,
): Promise<CollectionRecord | null> {
  return (await collections[collection].queries.byExternalId({ externalId }))[
    0
  ] ??
    null;
}

function compatibleParticipant(
  candidate: CollectionRecord,
  fields: ChannelParticipantInput,
): CollectionRecord {
  if (candidate.externalId !== fields.externalId) {
    throw new Error(
      `Participant '${candidate.id}' has externalId '${
        String(candidate.externalId)
      }', not '${fields.externalId}'.`,
    );
  }
  if (candidate.participantType !== fields.participantType) {
    throw new Error(
      `Participant '${fields.externalId}' has an incompatible participantType.`,
    );
  }
  if (fields.agentId && candidate.agentId !== fields.agentId) {
    throw new Error(
      `Participant '${fields.externalId}' belongs to another Agent.`,
    );
  }
  return candidate;
}

function scopedParticipant(
  channelId: string,
  fields: ChannelParticipantInput,
): ChannelParticipantInput {
  if (fields.participantType === "agent") return fields;
  return Object.freeze({
    ...fields,
    externalId: scopedExternalId(channelId, fields.externalId),
  });
}

async function participantPlan(
  context: ChannelActionContext,
  channelId: string,
  input: ChannelParticipantInput,
): Promise<ParticipantPlan> {
  const fields = scopedParticipant(channelId, input);
  const existing = fields.id
    ? await context.collections.participant.get({ id: fields.id })
    : await byExternalId(
      context.collections,
      "participant",
      fields.externalId,
    );
  if (existing) {
    compatibleParticipant(existing, fields);
    return Object.freeze({ id: existing.id, fields, existing });
  }
  return Object.freeze({
    id: fields.id ?? await deriveWorkflowId(
      "channel-participant",
      identityTuple(channelId, fields.externalId),
    ),
    fields,
    existing: null,
  });
}

function agentParticipant(
  context: ChannelActionContext,
  alias: string,
): ChannelParticipantInput {
  const agent = context.resources.agents?.[alias];
  if (!agent) throw new Error(`Unknown Agent Resource alias '${alias}'.`);
  return Object.freeze({
    externalId: requiredText(agent.id, `Agent Resource '${alias}' ID`),
    participantType: "agent",
    agentId: requiredText(agent.id, `Agent Resource '${alias}' ID`),
    name: requiredText(agent.name, `Agent Resource '${alias}' name`),
  });
}

function existingParticipantPlan(record: CollectionRecord): ParticipantPlan {
  return Object.freeze({
    id: record.id,
    fields: Object.freeze({
      id: record.id,
      externalId: requiredText(
        record.externalId ?? record.id,
        "Participant external ID",
      ),
      participantType: record.participantType as ChannelParticipantType,
      ...(optionalText(record.agentId, "Participant Agent ID")
        ? { agentId: optionalText(record.agentId, "Participant Agent ID") }
        : {}),
    }),
    existing: record,
  });
}

async function recipientPlan(
  context: ChannelActionContext,
  channelId: string,
  value: ChannelParticipantRef,
): Promise<ParticipantPlan> {
  if (typeof value !== "string") {
    return await participantPlan(context, channelId, value);
  }
  const alias = requiredText(value, "Channel recipient");
  if (context.resources.agents?.[alias]) {
    return await participantPlan(
      context,
      channelId,
      agentParticipant(context, alias),
    );
  }
  let existing = await context.collections.participant.get({ id: alias }) ??
    await byExternalId(
      context.collections,
      "participant",
      scopedExternalId(channelId, alias),
    );
  if (!existing) {
    const global = await byExternalId(
      context.collections,
      "participant",
      alias,
    );
    if (global?.participantType === "agent") existing = global;
  }
  if (!existing) throw new Error(`Channel recipient '${alias}' was not found.`);
  return existingParticipantPlan(existing);
}

async function existingThreadAgents(
  context: ChannelActionContext,
  threadRecord: CollectionRecord | null,
): Promise<readonly ParticipantPlan[]> {
  if (!threadRecord || !Array.isArray(threadRecord.participantIds)) return [];
  const records = await Promise.all(
    threadRecord.participantIds.map((id) =>
      context.collections.participant.get({ id: String(id) })
    ),
  );
  return Object.freeze(
    records.filter((item): item is CollectionRecord =>
      item?.participantType === "agent"
    ).map(existingParticipantPlan),
  );
}

function uniquePlans(
  plans: readonly ParticipantPlan[],
): readonly ParticipantPlan[] {
  return Object.freeze([
    ...new Map(plans.map((plan) => [plan.id, plan])).values(),
  ]);
}

async function stageParticipant(
  plan: ParticipantPlan,
  collections: ActionTransactionContext["collections"],
  metadata: ChannelJsonObject,
): Promise<CollectionMutationRef> {
  if (plan.existing) return Object.freeze({ id: plan.existing.id });
  return await collections.participant.create({
    id: plan.id,
    externalId: plan.fields.externalId,
    participantType: plan.fields.participantType,
    ...(plan.fields.name ? { name: plan.fields.name } : {}),
    ...(plan.fields.email ? { email: plan.fields.email } : {}),
    ...(plan.fields.agentId ? { agentId: plan.fields.agentId } : {}),
    metadata: structuredClone(plan.fields.metadata ?? {}),
  }, {
    operationKey: `participant:${plan.id}`,
    visibility: { kind: "internal" },
    identity: { metadata: structuredClone(metadata) },
  });
}

function bindingRecord(value: CollectionRecord): ChannelBindingRecord {
  return value as ChannelBindingRecord;
}

function retryableGraphConflict(error: unknown): boolean {
  let candidate: unknown = error;
  for (let depth = 0; depth < 5 && candidate; depth += 1) {
    if (typeof candidate !== "object") break;
    const value = candidate as Record<string, unknown>;
    const code = typeof value.code === "string" ? value.code : "";
    if (code === "23505" || code === "40001" || code === "40P01") {
      return true;
    }
    const message = value instanceof Error
      ? value.message
      : typeof value.message === "string"
      ? value.message
      : "";
    if (
      /was (?:created|changed) while its mutation was prepared/i.test(
        message,
      ) ||
      /collection '.+' '.+' already exists/i.test(message) ||
      /duplicate key value violates unique constraint/i.test(message) ||
      /could not serialize access/i.test(message) ||
      /deadlock detected/i.test(message)
    ) return true;
    candidate = value.cause;
  }
  return false;
}

async function executeChannelIngress(
  rawInput: ChannelIngressInput,
  context: ChannelActionContext,
): Promise<ChannelIngressActionOutput> {
  const input = ingressInput(rawInput);
  const resource = channelResource(context, input.channelId);
  const adapter = channelAdapter(context, input.channelId);
  const received = receivedMessage(
    await adapter.receive(input.input, {
      namespace: context.namespace,
      channelId: input.channelId,
      channel: resource,
      occurrenceId: input.id,
      signal: context.signal,
      now: context.now,
    }),
  );
  const [bindingIdCandidate, threadIdCandidate, messageId] = await Promise.all([
    deriveWorkflowId(
      "channel-binding",
      identityTuple(input.channelId, received.externalThreadId),
    ),
    deriveWorkflowId(
      "channel-thread",
      identityTuple(input.channelId, received.externalThreadId),
    ),
    deriveWorkflowId(
      "channel-message",
      identityTuple(input.channelId, input.id),
    ),
  ]);
  const scopedThreadExternalId = scopedExternalId(
    input.channelId,
    received.externalThreadId,
  );
  const prepared = await context.content.prepare(received.content, {
    operationKey: `ingress:${input.id}:content`,
  });
  const route = jsonObject(received.route ?? {}, "Channel route");
  const providerMetadata = jsonObject(
    received.metadata ?? {},
    "Channel metadata",
  );
  const bindingMetadata = Object.freeze({
    resource: structuredClone(resource.metadata ?? {}),
    provider: structuredClone(providerMetadata),
  }) as ChannelJsonObject;
  const maxGraphAttempts = 4;
  for (let attempt = 1; attempt <= maxGraphAttempts; attempt += 1) {
    context.signal.throwIfAborted();
    try {
      const [bound] = await context.collections.channelBinding.queries
        .byChannelThread({
          channelId: input.channelId,
          externalThreadId: received.externalThreadId,
        });
      const binding = bound ? bindingRecord(bound) : null;
      const existingThread = binding
        ? await context.collections.thread.get({ id: binding.threadId })
        : await context.collections.thread.get({ id: threadIdCandidate }) ??
          await byExternalId(
            context.collections,
            "thread",
            scopedThreadExternalId,
          );
      if (binding && !existingThread) {
        throw new Error(
          `Channel binding '${binding.id}' references missing thread '${binding.threadId}'.`,
        );
      }
      if (
        existingThread &&
        existingThread.externalId !== scopedThreadExternalId
      ) {
        throw new Error(
          `Channel thread '${existingThread.id}' has externalId '${
            String(existingThread.externalId)
          }', not '${scopedThreadExternalId}'.`,
        );
      }
      const bindingId = binding?.id ?? bindingIdCandidate;
      const threadId = existingThread?.id ?? threadIdCandidate;
      const sender = await participantPlan(
        context,
        input.channelId,
        received.sender,
      );
      let recipients = received.recipients?.length
        ? await Promise.all(
          received.recipients.map((value) =>
            recipientPlan(context, input.channelId, value)
          ),
        )
        : await existingThreadAgents(context, existingThread);
      if (recipients.length === 0) {
        recipients = await Promise.all(
          (resource.defaultAgentAliases ?? []).map((alias) =>
            participantPlan(
              context,
              input.channelId,
              agentParticipant(context, alias),
            )
          ),
        );
      }
      recipients = uniquePlans(
        recipients.filter((plan) => plan.id !== sender.id),
      );
      if (recipients.length === 0) {
        throw new Error(
          `Channel '${input.channelId}' ingress has no recipient participant.`,
        );
      }
      const declaredParticipants = received.thread?.participants === undefined
        ? undefined
        : await Promise.all(
          received.thread.participants.map((value) =>
            recipientPlan(context, input.channelId, value)
          ),
        );
      const threadParticipants = uniquePlans(
        declaredParticipants === undefined
          ? [sender, ...recipients]
          : [sender, ...recipients, ...declaredParticipants],
      );
      const eventMetadata = Object.freeze({
        channel: Object.freeze({
          channelId: input.channelId,
          bindingId,
          externalThreadId: received.externalThreadId,
          occurrenceId: input.id,
        }),
        ...(Object.keys(providerMetadata).length
          ? { provider: structuredClone(providerMetadata) }
          : {}),
      }) as ChannelJsonObject;
      const threadMetadata = setChannelContext(
        existingThread?.metadata,
        input.channelId,
        {
          bindingId,
          externalThreadId: received.externalThreadId,
          metadata: structuredClone(received.thread?.metadata ?? {}),
        },
      );
      await context.transaction(async (transaction) => {
        const stagedParticipants = await Promise.all(
          uniquePlans([...threadParticipants, ...recipients]).map(
            async (plan) =>
              Object.freeze({
                id: plan.id,
                ref: await stageParticipant(
                  plan,
                  transaction.collections,
                  eventMetadata,
                ),
              }),
          ),
        );
        const participantRefs = new Map(
          stagedParticipants.map((entry) => [entry.id, entry.ref]),
        );
        const senderRef = participantRefs.get(sender.id);
        if (!senderRef) throw new Error("Channel sender was not staged.");
        const recipientRefs = recipients.map((plan) => {
          const ref = participantRefs.get(plan.id);
          if (!ref) throw new Error("Channel recipient was not staged.");
          return ref;
        });
        const participantIds = Object.freeze([
          ...new Set(
            threadParticipants.map((plan) => {
              const ref = participantRefs.get(plan.id);
              if (!ref) {
                throw new Error("Channel thread participant was not staged.");
              }
              return ref.id;
            }),
          ),
        ]);
        if (existingThread) {
          const set: Record<string, unknown> = { metadata: threadMetadata };
          if (received.thread?.name) set.name = received.thread.name;
          if (received.thread?.description) {
            set.description = received.thread.description;
          }
          if (received.thread?.status) set.status = received.thread.status;
          await transaction.collections.thread.update({ id: threadId, set }, {
            operationKey: "thread:update",
            threadId,
            visibility: { kind: "internal" },
            identity: { metadata: structuredClone(eventMetadata) },
          });
          const existingIds = new Set(
            Array.isArray(existingThread.participantIds)
              ? existingThread.participantIds.map(String)
              : [],
          );
          for (const participantId of participantIds) {
            if (existingIds.has(participantId)) continue;
            await transaction.collections.thread.commands.addParticipant({
              id: threadId,
              participantId,
            }, {
              operationKey: `thread:participant:${participantId}`,
              threadId,
              visibility: { kind: "internal" },
              identity: { metadata: structuredClone(eventMetadata) },
            });
            existingIds.add(participantId);
          }
        } else {
          await transaction.collections.thread.create({
            id: threadId,
            externalId: scopedThreadExternalId,
            ...(received.thread?.name ? { name: received.thread.name } : {}),
            ...(received.thread?.description
              ? { description: received.thread.description }
              : {}),
            ...(received.thread?.status
              ? { status: received.thread.status }
              : {}),
            metadata: threadMetadata,
            participantIds,
          }, {
            operationKey: "thread:create",
            threadId,
            visibility: { kind: "internal" },
            identity: { metadata: structuredClone(eventMetadata) },
          });
        }
        if (binding) {
          await transaction.collections.channelBinding.update({
            id: bindingId,
            set: {
              inboundMessageId: messageId,
              route,
              metadata: bindingMetadata,
            },
          }, {
            operationKey: "binding:update",
            threadId,
            visibility: { kind: "internal" },
            identity: { metadata: structuredClone(eventMetadata) },
          });
        } else {
          await transaction.collections.channelBinding.create({
            id: bindingId,
            channelId: input.channelId,
            externalThreadId: received.externalThreadId,
            threadId,
            inboundMessageId: messageId,
            route,
            metadata: bindingMetadata,
          }, {
            operationKey: "binding:create",
            threadId,
            visibility: { kind: "internal" },
            identity: { metadata: structuredClone(eventMetadata) },
          });
        }
        const relativeVisibility = received.visibility ?? "public";
        const messageVisibility = relativeVisibility === "participants"
          ? {
            kind: "participants" as const,
            participantIds: Object.freeze([...participantIds]),
          }
          : { kind: relativeVisibility } as const;
        await transaction.collections.message.create({
          id: messageId,
          threadId,
          senderId: senderRef.id,
          recipientIds: recipientRefs.map((ref) => ref.id),
          content: prepared,
          metadata: eventMetadata,
        }, {
          operationKey: "message:create",
          threadId,
          routing: {
            senderId: senderRef.id,
            recipientIds: recipientRefs.map((ref) => ref.id),
          },
          visibility: messageVisibility,
          identity: { metadata: structuredClone(eventMetadata) },
        });
      }, {
        operationKey: `ingress:${input.id}:commit`,
        identity: {
          correlationId: context.identity.correlationId,
          metadata: structuredClone(eventMetadata),
        },
      });
      return Object.freeze({
        channelId: input.channelId,
        bindingId,
        threadId,
        messageId,
      });
    } catch (error) {
      if (attempt >= maxGraphAttempts || !retryableGraphConflict(error)) {
        throw error;
      }
    }
  }
  throw new Error("Channel graph planning exhausted its retry budget.");
}

const ingressSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    channelId: { type: "string" },
    id: { type: "string" },
    input: {},
  },
  required: ["channelId", "id", "input"],
} as const;

export const channelIngressAction: ActionDefinition<
  ChannelIngressInput,
  ChannelIngressActionOutput,
  ChannelActionContext,
  typeof ingressSchema,
  undefined
> = defineAction({
  id: CHANNEL_INGRESS_ACTION_ID,
  inputSchema: ingressSchema,
  execute: executeChannelIngress,
});
