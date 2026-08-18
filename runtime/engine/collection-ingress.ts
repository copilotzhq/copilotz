import { ulid } from "../../dependencies/ulid.ts";
import type {
  BoundCollection,
  CollectionMutation,
  CollectionRecord,
  CollectionRuntime,
  CollectionWrite,
  CollectionWriteOptions,
} from "../collections/index.ts";
import { isCollectionNoop } from "../collections/index.ts";
import type {
  ContentSequence,
  DatabaseAssetRepository,
  DurableContentInput,
} from "../content/index.ts";
import type {
  ConversationMessage,
  ConversationRepository,
  ConversationThread,
  LlmAttempt,
  LlmAttemptRepository,
  MessageRevisionResult,
  MutationIdentity,
  Participant,
  ParticipantInput,
  ToolExecution,
  ToolExecutionRepository,
} from "../domain/index.ts";
import {
  composeRoleContent,
  replaceContentRoles,
  type RoleContentInput,
} from "../domain/workflow-content.ts";
import {
  workflowMutationId,
  workflowObject,
  workflowTimestamp,
} from "../domain/workflow-support.ts";
import { LLM_CONTENT_ROLE, TOOL_CONTENT_ROLE } from "../domain/workflow-types.ts";
import type {
  CoordinatedMutationResult,
  DurableEvent,
  EventStore,
  SqlExecutor,
} from "../events/index.ts";

export type CreateCollectionIngressOptions = Readonly<{
  collectionRuntime: CollectionRuntime;
  session: SqlExecutor;
  eventStore: Pick<EventStore, "tables">;
  assets: Pick<
    DatabaseAssetRepository,
    "materialize" | "resolvePrepared" | "linkOwner" | "syncOwner"
  >;
  createId?: () => string;
  now?: () => Date;
}>;

function requireText(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new TypeError(`${name} must be non-empty.`);
  return normalized;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...value as Record<string, unknown> }
    : {};
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

function contentSequence(value: unknown): ContentSequence {
  if (!Array.isArray(value)) return Object.freeze([]);
  return Object.freeze(value) as ContentSequence;
}

function requireCollection<T extends CollectionRecord>(
  runtime: CollectionRuntime,
  name: string,
): BoundCollection<T> {
  const bound = runtime.get<T>(name);
  if (!bound) throw new Error(`Collection '${name}' is not bound.`);
  return bound;
}

function toDurableEvent(event: CollectionMutation<CollectionRecord>["event"]): DurableEvent {
  return Object.freeze({
    durable: true as const,
    id: event.id,
    position: event.position,
    schemaVersion: event.schemaVersion,
    type: event.eventType,
    namespace: event.namespace,
    ...(event.threadId ? { threadId: event.threadId } : {}),
    ...(event.subject ? { subject: event.subject } : {}),
    payload: { dataRef: event.dataRef },
    routing: event.routing,
    visibility: event.visibility,
    metadata: event.metadata,
    ...(event.causationId ? { causationId: event.causationId } : {}),
    correlationId: event.correlationId,
    ...(event.deduplicationId ? { deduplicationId: event.deduplicationId } : {}),
    createdAt: event.createdAt,
  });
}

function emptyDispatch() {
  return Object.freeze({
    handles: Object.freeze([] as const),
    failures: Object.freeze([] as const),
  });
}

function fromMutation<T>(
  write: CollectionWrite<CollectionRecord>,
  value: T,
  fallback: CoordinatedMutationResult<T>["dispatch"] = emptyDispatch(),
): CoordinatedMutationResult<T> {
  if (isCollectionNoop(write)) {
    return Object.freeze({
      value,
      event: Object.freeze({
        durable: true as const,
        id: `noop:${String((write.record as { id?: string }).id ?? "record")}`,
        position: "0",
        schemaVersion: 1,
        type: "collection.noop",
        namespace: String((write.record as { namespace?: string }).namespace ?? ""),
        payload: {},
        routing: {},
        visibility: { kind: "internal" as const },
        metadata: {},
        correlationId: `noop:${String((write.record as { id?: string }).id ?? "record")}`,
        createdAt: new Date().toISOString(),
      }),
      deliveries: Object.freeze([]),
      settlementScopeId: `noop:${String((write.record as { id?: string }).id ?? "record")}`,
      deduplicated: true,
      dispatch: fallback,
    });
  }
  return Object.freeze({
    value,
    event: toDurableEvent(write.event),
    deliveries: write.deliveries,
    settlementScopeId: write.settlementScopeId,
    deduplicated: write.deduplicated,
    dispatch: write.dispatch.handles.length || write.dispatch.failures.length
      ? write.dispatch
      : fallback,
  });
}

function followOnIdentity(
  identity: MutationIdentity | undefined,
): MutationIdentity | undefined {
  if (!identity) return undefined;
  const next = {
    ...(identity.causationId ? { causationId: identity.causationId } : {}),
    ...(identity.correlationId
      ? { correlationId: identity.correlationId }
      : {}),
    ...(identity.settlementScopeId
      ? { settlementScopeId: identity.settlementScopeId }
      : {}),
    ...(identity.metadata ? { metadata: identity.metadata } : {}),
  };
  return Object.keys(next).length > 0 ? next : undefined;
}

function writeOptions(
  namespace: string,
  identity: MutationIdentity | undefined,
  extra: Omit<CollectionWriteOptions, "namespace" | "identity"> = {},
): CollectionWriteOptions {
  return {
    namespace,
    ...(extra.threadId ? { threadId: extra.threadId } : {}),
    ...(extra.routing ? { routing: extra.routing } : {}),
    ...(extra.visibility ? { visibility: extra.visibility } : {}),
    ...(identity
      ? {
        identity: {
          ...(identity.causationId ? { causationId: identity.causationId } : {}),
          ...(identity.correlationId
            ? { correlationId: identity.correlationId }
            : {}),
          ...(identity.deduplicationId
            ? { deduplicationId: identity.deduplicationId }
            : {}),
          ...(identity.settlementScopeId
            ? { settlementScopeId: identity.settlementScopeId }
            : {}),
          ...(identity.metadata ? { metadata: identity.metadata } : {}),
        },
      }
      : {}),
  };
}

function mapParticipant(record: CollectionRecord): Participant {
  return Object.freeze({
    id: String(record.id),
    namespace: String(record.namespace),
    externalId: String(record.externalId ?? record.id),
    participantType: record.participantType as Participant["participantType"],
    ...(optionalText(record.name) ? { name: optionalText(record.name) } : {}),
    ...(optionalText(record.email) ? { email: optionalText(record.email) } : {}),
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
    ...(optionalText(record.lastEventId)
      ? { lastEventId: optionalText(record.lastEventId) }
      : {}),
    ...(optionalText(record.lastEventPosition)
      ? { lastEventPosition: optionalText(record.lastEventPosition) }
      : {}),
    ...(optionalText(record.lastEventAt)
      ? { lastEventAt: optionalText(record.lastEventAt) }
      : {}),
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
    content: contentSequence(record.content),
    metadata: workflowObject(record.metadata),
    ...(revision ? { revision } : {}),
    createdAt: String(record.createdAt),
    updatedAt: String(record.updatedAt),
  });
}

function mapLlmAttempt(record: CollectionRecord): LlmAttempt {
  return Object.freeze({
    id: String(record.id),
    namespace: String(record.namespace),
    threadId: String(record.threadId),
    ...(optionalText(record.messageId)
      ? { messageId: optionalText(record.messageId) }
      : {}),
    ...(optionalText(record.participantId)
      ? { participantId: optionalText(record.participantId) }
      : {}),
    ...(optionalText(record.initiatorParticipantId)
      ? { initiatorParticipantId: optionalText(record.initiatorParticipantId) }
      : {}),
    ...(optionalText(record.agentId) ? { agentId: optionalText(record.agentId) } : {}),
    ...(optionalText(record.provider)
      ? { provider: optionalText(record.provider) }
      : {}),
    ...(optionalText(record.model) ? { model: optionalText(record.model) } : {}),
    status: record.status as LlmAttempt["status"],
    attemptIndex: Number(record.attemptIndex ?? 0),
    ...(optionalText(record.parentAttemptId)
      ? { parentAttemptId: optionalText(record.parentAttemptId) }
      : {}),
    inputMessageIds: stringArray(record.inputMessageIds),
    availableToolIds: stringArray(record.availableToolIds),
    content: contentSequence(record.content),
    ...(optionalText(record.finishReason)
      ? { finishReason: optionalText(record.finishReason) }
      : {}),
    ...(record.usage && typeof record.usage === "object"
      ? { usage: record.usage as Record<string, unknown> }
      : {}),
    ...(record.cost && typeof record.cost === "object"
      ? { cost: record.cost as Record<string, unknown> }
      : {}),
    ...(record.safeError && typeof record.safeError === "object"
      ? { safeError: record.safeError as LlmAttempt["safeError"] }
      : {}),
    startedAt: String(record.startedAt ?? record.createdAt),
    ...(optionalText(record.finishedAt)
      ? { finishedAt: optionalText(record.finishedAt) }
      : {}),
    ...(optionalText(record.metricsFinalizedAt)
      ? { metricsFinalizedAt: optionalText(record.metricsFinalizedAt) }
      : {}),
    metadata: workflowObject(record.metadata),
    createdAt: String(record.createdAt),
    updatedAt: String(record.updatedAt),
  });
}

function mapToolExecution(record: CollectionRecord): ToolExecution {
  return Object.freeze({
    id: String(record.id),
    namespace: String(record.namespace),
    threadId: String(record.threadId),
    ...(optionalText(record.messageId)
      ? { messageId: optionalText(record.messageId) }
      : {}),
    ...(optionalText(record.participantId)
      ? { participantId: optionalText(record.participantId) }
      : {}),
    ...(optionalText(record.agentId) ? { agentId: optionalText(record.agentId) } : {}),
    toolCallId: String(record.toolCallId),
    tool: asRecord(record.tool),
    status: record.status as ToolExecution["status"],
    content: contentSequence(record.content),
    ...(optionalText(record.historyVisibility)
      ? { historyVisibility: optionalText(record.historyVisibility) }
      : {}),
    ...(record.safeError && typeof record.safeError === "object"
      ? { safeError: record.safeError as ToolExecution["safeError"] }
      : {}),
    startedAt: String(record.startedAt ?? record.createdAt),
    ...(optionalText(record.finishedAt)
      ? { finishedAt: optionalText(record.finishedAt) }
      : {}),
    ...(typeof record.durationMs === "number" ? { durationMs: record.durationMs } : {}),
    metadata: workflowObject(record.metadata),
    createdAt: String(record.createdAt),
    updatedAt: String(record.updatedAt),
  });
}

function projectActiveBranch<T extends { id: string }>(
  messages: readonly T[],
  branch: ConversationThread["activeMessageBranch"],
): readonly T[] {
  if (!branch) return messages;
  const rootIndex = messages.findIndex((message) =>
    message.id === branch.rootMessageId
  );
  const headIndex = messages.findIndex((message) =>
    message.id === branch.headMessageId
  );
  if (rootIndex < 0 || headIndex <= rootIndex) return messages;
  return Object.freeze([
    ...messages.slice(0, rootIndex),
    messages[headIndex],
    ...messages.slice(headIndex + 1),
  ]);
}

function participantFields(input: ParticipantInput) {
  return {
    ...(input.id ? { id: input.id } : {}),
    externalId: requireText(input.externalId, "Participant externalId"),
    participantType: input.participantType,
    ...(input.name ? { name: input.name } : {}),
    ...(input.email ? { email: input.email } : {}),
    ...(input.agentId ? { agentId: input.agentId } : {}),
    metadata: structuredClone(input.metadata ?? {}),
  };
}

/** Engine ingress over bound core collections. Not a processor facade. */
export function createCollectionConversationRepository(
  options: CreateCollectionIngressOptions,
): ConversationRepository {
  const createId = options.createId ?? ulid;
  const runtime = options.collectionRuntime;
  const participants = requireCollection(runtime, "participant");
  const threads = requireCollection(runtime, "thread");
  const messages = requireCollection(runtime, "message");
  const mutationContext = {
    transaction: options.session,
    tables: options.eventStore.tables,
  };

  const readParticipant = async (namespace: string, id: string) => {
    const record = await participants.get(id, namespace);
    return record ? mapParticipant(record) : null;
  };

  const readParticipantByExternalId = async (
    namespace: string,
    externalId: string,
  ) => {
    const [record] = await participants.query.byExternalId(namespace, {
      externalId,
    });
    return record ? mapParticipant(record) : null;
  };

  const hydrateMessage = async (
    record: CollectionRecord,
    namespace: string,
  ) => {
    const senderId = String(record.senderId ?? "");
    const senderRecord = record.sender && typeof record.sender === "object"
      ? record.sender as CollectionRecord
      : senderId
      ? await participants.get(senderId, namespace)
      : null;
    if (!senderRecord) {
      throw new Error(`Message '${record.id}' sender was not found.`);
    }
    return mapMessage(record, mapParticipant(senderRecord));
  };

  const hydrateThread = async (record: CollectionRecord, namespace: string) => {
    const included = Array.isArray(record.participants)
      ? (record.participants as CollectionRecord[]).map(mapParticipant)
      : undefined;
    if (included) return mapThread(record, included);
    const ids = stringArray(record.participantIds);
    const loaded = await Promise.all(
      ids.map((id) => participants.get(id, namespace)),
    );
    return mapThread(
      record,
      loaded.filter((item): item is CollectionRecord => item !== null).map(
        mapParticipant,
      ),
    );
  };

  const ensureParticipant = async (
    namespace: string,
    input: ParticipantInput,
    identity: MutationIdentity | undefined,
    collection: BoundCollection = participants,
    threadId?: string,
  ) => {
    if (input.id?.trim()) {
      const existing = await collection.get(input.id.trim(), namespace);
      if (existing) return mapParticipant(existing);
    }
    const [byExternal] = await collection.query.byExternalId(namespace, {
      externalId: requireText(input.externalId, "Participant externalId"),
    });
    if (byExternal) return mapParticipant(byExternal);
    const created = await collection.create(
      participantFields(input),
      writeOptions(namespace, identity, threadId ? { threadId } : {}),
    );
    return mapParticipant(created.record);
  };

  return Object.freeze({
    async createParticipant(input) {
      const namespace = requireText(input.namespace, "Namespace");
      const created = await participants.create(
        participantFields(input.participant),
        writeOptions(namespace, input.identity),
      );
      return fromMutation(created, mapParticipant(created.record));
    },
    async updateParticipant(input) {
      const namespace = requireText(input.namespace, "Namespace");
      const set: Record<string, unknown> = {};
      const unset: string[] = [];
      if (input.patch.name === null) unset.push("name");
      else if (input.patch.name !== undefined) set.name = input.patch.name;
      if (input.patch.email === null) unset.push("email");
      else if (input.patch.email !== undefined) set.email = input.patch.email;
      if (input.patch.agentId === null) unset.push("agentId");
      else if (input.patch.agentId !== undefined) {
        set.agentId = input.patch.agentId;
      }
      if (input.patch.metadata !== undefined) {
        set.metadata = structuredClone(input.patch.metadata);
      }
      const write = await participants.update(input.id, { set, unset }, writeOptions(
        namespace,
        input.identity,
      ));
      return fromMutation(write, mapParticipant(write.record));
    },
    getParticipant: (namespace, id) =>
      readParticipant(requireText(namespace, "Namespace"), requireText(id, "Participant ID")),
    getParticipantByExternalId: (namespace, externalId) =>
      readParticipantByExternalId(
        requireText(namespace, "Namespace"),
        requireText(externalId, "Participant externalId"),
      ),
    async listParticipants(namespaceInput, listOptions = {}) {
      const namespace = requireText(namespaceInput, "Namespace");
      const records = await participants.list(namespace, {
        ...(listOptions.participantType
          ? { where: { participantType: listOptions.participantType } }
          : {}),
        ...(listOptions.after ? { after: listOptions.after } : {}),
        ...(listOptions.limit ? { limit: listOptions.limit } : {}),
      });
      return Object.freeze(records.map(mapParticipant));
    },
    async createThread(input) {
      const namespace = requireText(input.namespace, "Namespace");
      const id = workflowMutationId(
        "thread",
        namespace,
        input.id,
        input.identity,
        createId,
      );
      const result = await runtime.transaction({
        operationKey: input.identity?.deduplicationId ?? `thread.create:${id}`,
        namespace,
        identity: input.identity,
        execute: async ({ collections }) => {
          const participantIds: string[] = [];
          for (const participant of input.participants ?? []) {
            const ensured = await ensureParticipant(
              namespace,
              participant,
              undefined,
              collections.participant,
            );
            participantIds.push(ensured.id);
          }
          const created = await collections.thread.create({
            id,
            ...(input.externalId ? { externalId: input.externalId } : {}),
            ...(input.name ? { name: input.name } : {}),
            ...(input.description ? { description: input.description } : {}),
            status: input.status ?? "active",
            ...(input.parentThreadId ? { parentThreadId: input.parentThreadId } : {}),
            metadata: structuredClone(input.metadata ?? {}),
            participantIds,
          }, writeOptions(namespace, input.identity, { threadId: id }));
          return created;
        },
      });
      const write = result.writes[result.writes.length - 1];
      if (!write || isCollectionNoop(write)) {
        throw new Error(`Thread '${id}' was not created.`);
      }
      return fromMutation(
        write,
        await hydrateThread(write.record, namespace),
        result.dispatch,
      );
    },
    async addThreadParticipant(input) {
      const namespace = requireText(input.namespace, "Namespace");
      const thread = await threads.get(input.threadId, namespace);
      if (!thread) throw new Error(`Thread '${input.threadId}' was not found.`);
      const participant = await ensureParticipant(
        namespace,
        input.participant,
        followOnIdentity(input.identity),
      );
      const participantIds = [
        ...new Set([...stringArray(thread.participantIds), participant.id]),
      ];
      const write = await threads.update(input.threadId, {
        set: { participantIds },
      }, writeOptions(namespace, input.identity, { threadId: input.threadId }));
      return fromMutation(write, await hydrateThread(write.record, namespace));
    },
    async updateThread(input) {
      const namespace = requireText(input.namespace, "Namespace");
      const set: Record<string, unknown> = {};
      const unset: string[] = [];
      if (input.patch.name === null) unset.push("name");
      else if (input.patch.name !== undefined) set.name = input.patch.name;
      if (input.patch.description === null) unset.push("description");
      else if (input.patch.description !== undefined) {
        set.description = input.patch.description;
      }
      if (input.patch.status !== undefined) set.status = input.patch.status;
      if (input.patch.metadata !== undefined) {
        set.metadata = structuredClone(input.patch.metadata);
      }
      const write = await threads.update(input.id, { set, unset }, writeOptions(
        namespace,
        input.identity,
        { threadId: input.id },
      ));
      return fromMutation(write, await hydrateThread(write.record, namespace));
    },
    async deleteThread(input) {
      const namespace = requireText(input.namespace, "Namespace");
      const write = await threads.delete(
        input.id,
        writeOptions(namespace, input.identity, { threadId: input.id }),
      );
      return fromMutation(write, Object.freeze({ id: input.id, deleted: true as const }));
    },
    async getThread(namespaceInput, idInput) {
      const namespace = requireText(namespaceInput, "Namespace");
      const record = await threads.get(requireText(idInput, "Thread ID"), namespace);
      return record ? await hydrateThread(record, namespace) : null;
    },
    async getThreadByExternalId(namespaceInput, externalIdInput) {
      const namespace = requireText(namespaceInput, "Namespace");
      const [record] = await threads.query.byExternalId(namespace, {
        externalId: requireText(externalIdInput, "Thread externalId"),
      });
      return record ? await hydrateThread(record, namespace) : null;
    },
    async listThreads(namespaceInput, listOptions = {}) {
      const namespace = requireText(namespaceInput, "Namespace");
      const records = await threads.list(namespace, {
        ...(listOptions.status
          ? {
            where: {
              status: Array.isArray(listOptions.status)
                ? listOptions.status[0]
                : listOptions.status,
            },
          }
          : {}),
        ...(listOptions.after ? { after: listOptions.after } : {}),
        ...(listOptions.limit ? { limit: listOptions.limit } : {}),
      });
      const mapped = await Promise.all(
        records.map((record) => hydrateThread(record, namespace)),
      );
      if (!listOptions.participantId) return Object.freeze(mapped);
      return Object.freeze(
        mapped.filter((thread) =>
          thread.participants.some((item) => item.id === listOptions.participantId)
        ),
      );
    },
    async createMessage(input) {
      const namespace = requireText(input.namespace, "Namespace");
      const threadId = requireText(input.threadId, "Thread ID");
      const id = workflowMutationId(
        "message",
        namespace,
        input.id,
        input.identity,
        createId,
      );
      const recipientIds = stringArray(input.recipientIds);
      const content = await options.assets.materialize(mutationContext, {
        namespace,
        content: input.content,
        origin: {
          scope: { type: "thread", id: threadId },
          producer: { type: "message", id },
        },
      });
      const result = await runtime.transaction({
        operationKey: input.identity?.deduplicationId ?? `message.create:${id}`,
        namespace,
        identity: input.identity,
        execute: async ({ collections }) => {
          const thread = await collections.thread.get(threadId, namespace);
          if (!thread) throw new Error(`Thread '${threadId}' was not found.`);
          const sender = await ensureParticipant(
            namespace,
            input.sender,
            undefined,
            collections.participant,
            threadId,
          );
          const created = await collections.message.create({
            id,
            threadId,
            senderId: sender.id,
            recipientIds,
            content,
            metadata: structuredClone(input.metadata ?? {}),
          }, writeOptions(namespace, input.identity, {
            threadId,
            routing: { senderId: sender.id, recipientIds },
            visibility: input.visibility ?? { kind: "public" },
          }));
          const participantIds = [
            ...new Set([...stringArray(thread.participantIds), sender.id]),
          ];
          if (participantIds.length !== stringArray(thread.participantIds).length) {
            await collections.thread.update(threadId, {
              set: { participantIds },
            }, writeOptions(namespace, followOnIdentity(input.identity), {
              threadId,
            }));
          }
          return { created, sender };
        },
      });
      await options.assets.linkOwner(mutationContext, {
        namespace,
        ownerId: id,
        content,
      });
      return fromMutation(
        result.value.created,
        mapMessage(result.value.created.record, result.value.sender),
        result.dispatch,
      );
    },
    async reviseMessage(input) {
      const namespace = requireText(input.namespace, "Namespace");
      const threadId = requireText(input.threadId, "Thread ID");
      const previousId = requireText(input.messageId, "Message ID");
      const id = workflowMutationId(
        "message_revision",
        namespace,
        input.id,
        input.identity,
        createId,
      );
      const previousRecord = await messages.get(previousId, namespace);
      if (!previousRecord) {
        throw new Error(`Message '${previousId}' was not found.`);
      }
      const previous = await hydrateMessage(previousRecord, namespace);
      if (previous.threadId !== threadId) {
        throw new Error(
          `Message '${previousId}' does not belong to thread '${threadId}'.`,
        );
      }
      if (previous.sender.participantType !== "human") {
        throw new Error("Only human messages can be revised.");
      }
      const revision = {
        rootMessageId: previous.revision?.rootMessageId ?? previous.id,
        previousRevisionMessageId: previous.id,
        revisionIndex: (previous.revision?.revisionIndex ?? 0) + 1,
        revisedAt: new Date().toISOString(),
      };
      const content = await options.assets.materialize(mutationContext, {
        namespace,
        content: input.content,
        origin: {
          scope: { type: "thread", id: threadId },
          producer: { type: "message", id },
        },
      });
      const result = await runtime.transaction({
        operationKey: input.identity?.deduplicationId ?? `message.revise:${id}`,
        namespace,
        identity: input.identity,
        execute: async ({ collections }) => {
          const created = await collections.message.create({
            id,
            threadId,
            senderId: previous.sender.id,
            recipientIds: [...previous.recipientIds],
            content,
            metadata: structuredClone(input.metadata ?? previous.metadata),
            revision,
          }, writeOptions(namespace, input.identity, {
            threadId,
            routing: {
              senderId: previous.sender.id,
              recipientIds: [...previous.recipientIds],
            },
            visibility: input.visibility ?? { kind: "public" },
          }));
          await collections.thread.update(threadId, {
            set: {
              activeMessageBranch: {
                rootMessageId: revision.rootMessageId,
                headMessageId: id,
                previousRevisionMessageId: revision.previousRevisionMessageId,
                revisionIndex: revision.revisionIndex,
              },
            },
          }, writeOptions(namespace, followOnIdentity(input.identity), {
            threadId,
          }));
          return created;
        },
      });
      await options.assets.linkOwner(mutationContext, {
        namespace,
        ownerId: id,
        content,
      });
      const message = mapMessage(result.value.record, previous.sender);
      const mapped = fromMutation(result.value, {
        message,
        rootMessageId: revision.rootMessageId,
        previousRevisionMessageId: revision.previousRevisionMessageId,
        revisionIndex: revision.revisionIndex,
      } satisfies MessageRevisionResult, result.dispatch);
      return mapped;
    },
    async deleteThreadMessages(input) {
      const namespace = requireText(input.namespace, "Namespace");
      const records = await messages.query.byThreadId(namespace, {
        threadId: input.threadId,
      });
      const result = await runtime.transaction({
        operationKey: input.identity?.deduplicationId ??
          `thread.messages.delete:${input.threadId}`,
        namespace,
        identity: input.identity,
        execute: async ({ collections }) => {
          for (const record of records) {
            await collections.message.delete(
              String(record.id),
              writeOptions(namespace, followOnIdentity(input.identity), {
                threadId: input.threadId,
              }),
            );
          }
          return Object.freeze({
            threadId: input.threadId,
            deleted: true as const,
          });
        },
      });
      const write = result.writes[0];
      if (!write) {
        return Object.freeze({
          value: result.value,
          event: Object.freeze({
            durable: true as const,
            id: result.settlementScopeId,
            position: "0",
            schemaVersion: 1,
            type: "message.deleted",
            namespace,
            threadId: input.threadId,
            payload: {},
            routing: {},
            visibility: { kind: "internal" as const },
            metadata: {},
            correlationId: result.correlationId,
            createdAt: new Date().toISOString(),
          }),
          deliveries: Object.freeze([]),
          settlementScopeId: result.settlementScopeId,
          deduplicated: false,
          dispatch: result.dispatch,
        });
      }
      return fromMutation(write, result.value, result.dispatch);
    },
    async getMessage(namespaceInput, idInput) {
      const namespace = requireText(namespaceInput, "Namespace");
      const record = await messages.get(
        requireText(idInput, "Message ID"),
        namespace,
      );
      return record ? await hydrateMessage(record, namespace) : null;
    },
    async listMessages(namespaceInput, threadIdInput, listOptions = {}) {
      const namespace = requireText(namespaceInput, "Namespace");
      const threadId = requireText(threadIdInput, "Thread ID");
      const after = listOptions.after?.trim();
      const before = listOptions.before?.trim();
      if (after && before) {
        throw new TypeError(
          "Message history accepts either after or before, not both.",
        );
      }
      const order = listOptions.order ?? "asc";
      if (order !== "asc" && order !== "desc") {
        throw new TypeError("Message order must be 'asc' or 'desc'.");
      }
      const records = await messages.list(namespace, {
        where: { threadId },
        order: { field: "createdAt", direction: "asc" },
        limit: 1_000,
      });
      const mapped = await Promise.all(
        records.map((record) => hydrateMessage(record, namespace)),
      );
      const thread = await threads.get(threadId, namespace);
      const branch = thread?.activeMessageBranch as
        | ConversationThread["activeMessageBranch"]
        | undefined;
      const projected = listOptions.view === "all"
        ? Object.freeze(mapped)
        : projectActiveBranch(mapped, branch);
      let bounded = [...projected];
      const cursorId = after ?? before;
      if (cursorId) {
        const cursor = projected.findIndex((message) => message.id === cursorId);
        if (cursor < 0) {
          throw new Error(
            `Message cursor '${cursorId}' was not found in the ${
              listOptions.view ?? "active"
            } history for thread '${threadId}'.`,
          );
        }
        bounded = after ? bounded.slice(cursor + 1) : bounded.slice(0, cursor);
      }
      if (order === "desc") bounded.reverse();
      return Object.freeze(
        bounded.slice(0, listOptions.limit ?? 100),
      );
    },
    async listMessageRevisions(namespaceInput, rootMessageIdInput) {
      const namespace = requireText(namespaceInput, "Namespace");
      const records = await messages.query.revisions(namespace, {
        rootMessageId: requireText(rootMessageIdInput, "Root message ID"),
      });
      return Object.freeze(
        await Promise.all(
          records.map((record) => hydrateMessage(record, namespace)),
        ),
      );
    },
  });
}

function iso(value: string | Date | undefined, fallback: string): string {
  if (!value) return fallback;
  return value instanceof Date ? value.toISOString() : value;
}

async function materializeRoles(
  options: CreateCollectionIngressOptions,
  namespace: string,
  owner: { type: string; id: string; threadId: string },
  fields: readonly RoleContentInput[],
): Promise<ContentSequence> {
  if (!fields.length) return Object.freeze([]);
  const prepared = composeRoleContent(fields);
  return await options.assets.materialize({
    transaction: options.session,
    tables: options.eventStore.tables,
  }, {
    namespace,
    content: prepared,
    origin: {
      scope: { type: "thread", id: owner.threadId },
      producer: { type: owner.type, id: owner.id },
    },
  });
}

/** Engine ingress for logical and provider LLM attempts. */
export function createCollectionLlmAttemptRepository(
  options: CreateCollectionIngressOptions,
): LlmAttemptRepository {
  const createId = options.createId ?? ulid;
  const now = options.now ?? (() => new Date());
  const attempts = requireCollection(options.collectionRuntime, "llm_attempt");

  const roleFields = (input: {
    answer?: DurableContentInput;
    reasoning?: DurableContentInput;
    toolCalls?: DurableContentInput;
    errorDetail?: DurableContentInput;
    trace?: DurableContentInput;
    input?: DurableContentInput;
    toolDefinitions?: DurableContentInput;
  }): RoleContentInput[] => {
    const fields: RoleContentInput[] = [];
    if (input.input !== undefined) {
      fields.push({
        role: LLM_CONTENT_ROLE.input,
        input: input.input,
        cardinality: "many",
      });
    }
    if (input.toolDefinitions !== undefined) {
      fields.push({
        role: LLM_CONTENT_ROLE.toolDefinitions,
        input: input.toolDefinitions,
        cardinality: "one",
      });
    }
    if (input.answer !== undefined) {
      fields.push({
        role: LLM_CONTENT_ROLE.answer,
        input: input.answer,
        cardinality: "one",
      });
    }
    if (input.reasoning !== undefined) {
      fields.push({
        role: LLM_CONTENT_ROLE.reasoning,
        input: input.reasoning,
        cardinality: "one",
      });
    }
    if (input.toolCalls !== undefined) {
      fields.push({
        role: LLM_CONTENT_ROLE.toolCalls,
        input: input.toolCalls,
        cardinality: "one",
      });
    }
    if (input.errorDetail !== undefined) {
      fields.push({
        role: LLM_CONTENT_ROLE.errorDetail,
        input: input.errorDetail,
        cardinality: "one",
      });
    }
    if (input.trace !== undefined) {
      fields.push({
        role: LLM_CONTENT_ROLE.trace,
        input: input.trace,
        cardinality: "one",
      });
    }
    return fields;
  };

  return Object.freeze({
    async create(input) {
      const namespace = requireText(input.namespace, "Namespace");
      const threadId = requireText(input.threadId, "Thread ID");
      const id = workflowMutationId(
        "llm_attempt",
        namespace,
        input.id,
        input.identity,
        createId,
      );
      const fields = roleFields(input);
      const content = await materializeRoles(options, namespace, {
        type: "llm_attempt",
        id,
        threadId,
      }, fields);
      const startedAt = iso(input.startedAt, now().toISOString());
      const created = await attempts.create({
        id,
        threadId,
        ...(input.messageId ? { messageId: input.messageId } : {}),
        ...(input.participantId ? { participantId: input.participantId } : {}),
        ...(input.initiatorParticipantId
          ? { initiatorParticipantId: input.initiatorParticipantId }
          : {}),
        ...(input.agentId ? { agentId: input.agentId } : {}),
        ...(input.provider ? { provider: input.provider } : {}),
        ...(input.model ? { model: input.model } : {}),
        status: input.status ?? "running",
        attemptIndex: input.attemptIndex ?? 0,
        ...(input.parentAttemptId ? { parentAttemptId: input.parentAttemptId } : {}),
        inputMessageIds: [...(input.inputMessageIds ?? [])],
        availableToolIds: [...(input.availableToolIds ?? [])],
        content,
        startedAt,
        metadata: structuredClone(input.metadata ?? {}),
      }, writeOptions(namespace, input.identity, {
        threadId,
        visibility: input.visibility ?? { kind: "internal" },
        ...(input.participantId
          ? { routing: { senderId: input.participantId } }
          : {}),
      }));
      if (content.length) {
        await options.assets.linkOwner({
          transaction: options.session,
          tables: options.eventStore.tables,
        }, { namespace, ownerId: id, content });
      }
      return fromMutation(created, mapLlmAttempt(created.record));
    },
    async update(input) {
      const namespace = requireText(input.namespace, "Namespace");
      const current = await attempts.get(input.id, namespace);
      if (!current) throw new Error(`llm_attempt '${input.id}' was not found.`);
      const fields = roleFields(input);
      const replacement = await materializeRoles(options, namespace, {
        type: "llm_attempt",
        id: input.id,
        threadId: String(current.threadId),
      }, fields);
      const content = replaceContentRoles(
        contentSequence(current.content),
        replacement,
        new Set(fields.map((field) => field.role)),
      );
      const metadata = {
        ...workflowObject(current.metadata),
        ...workflowObject(input.metadataPatch),
      };
      const write = await attempts.update(input.id, {
        set: {
          ...(input.provider !== undefined ? { provider: input.provider } : {}),
          ...(input.model !== undefined ? { model: input.model } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.usage ? { usage: input.usage } : {}),
          ...(input.cost ? { cost: input.cost } : {}),
          ...(input.metricsFinalizedAt
            ? {
              metricsFinalizedAt: workflowTimestamp(
                input.metricsFinalizedAt,
                "metricsFinalizedAt",
              ),
            }
            : {}),
          ...(fields.length ? { content } : {}),
          ...(input.metadataPatch ? { metadata } : {}),
        },
      }, writeOptions(namespace, input.identity, {
        threadId: String(current.threadId),
        visibility: input.visibility ?? { kind: "internal" },
      }));
      return fromMutation(write, mapLlmAttempt(write.record));
    },
    async complete(input) {
      const namespace = requireText(input.namespace, "Namespace");
      const current = await attempts.get(input.id, namespace);
      if (!current) throw new Error(`llm_attempt '${input.id}' was not found.`);
      const fields = roleFields(input);
      const replacement = await materializeRoles(options, namespace, {
        type: "llm_attempt",
        id: input.id,
        threadId: String(current.threadId),
      }, fields);
      const content = replaceContentRoles(
        contentSequence(current.content),
        replacement,
        new Set(fields.map((field) => field.role)),
      );
      const metadata = {
        ...workflowObject(current.metadata),
        ...workflowObject(input.metadataPatch),
      };
      const write = await attempts.mutate(input.id, "complete", {
        content,
        ...(input.finishReason ? { finishReason: input.finishReason } : {}),
        ...(input.usage ? { usage: input.usage } : {}),
        ...(input.cost ? { cost: input.cost } : {}),
        finishedAt: iso(input.finishedAt, now().toISOString()),
        ...(input.metricsFinalizedAt
          ? {
            metricsFinalizedAt: workflowTimestamp(
              input.metricsFinalizedAt,
              "metricsFinalizedAt",
            ),
          }
          : {}),
        ...(input.metadataPatch ? { metadata } : {}),
      }, writeOptions(namespace, input.identity, {
        threadId: String(current.threadId),
        visibility: input.visibility ?? { kind: "internal" },
      }));
      return fromMutation(write, mapLlmAttempt(write.record));
    },
    async fail(input) {
      const namespace = requireText(input.namespace, "Namespace");
      const current = await attempts.get(input.id, namespace);
      if (!current) throw new Error(`llm_attempt '${input.id}' was not found.`);
      const fields = roleFields(input);
      const replacement = await materializeRoles(options, namespace, {
        type: "llm_attempt",
        id: input.id,
        threadId: String(current.threadId),
      }, fields);
      const content = replaceContentRoles(
        contentSequence(current.content),
        replacement,
        new Set(fields.map((field) => field.role)),
      );
      const metadata = {
        ...workflowObject(current.metadata),
        ...workflowObject(input.metadataPatch),
      };
      const write = await attempts.mutate(input.id, "fail", {
        message: input.safeError.message,
        ...(input.safeError.code ? { code: input.safeError.code } : {}),
        content,
        finishedAt: iso(input.finishedAt, now().toISOString()),
        ...(input.metadataPatch ? { metadata } : {}),
      }, writeOptions(namespace, input.identity, {
        threadId: String(current.threadId),
        visibility: input.visibility ?? { kind: "internal" },
      }));
      return fromMutation(write, mapLlmAttempt(write.record));
    },
    async cancel(input) {
      const namespace = requireText(input.namespace, "Namespace");
      const current = await attempts.get(input.id, namespace);
      if (!current) throw new Error(`llm_attempt '${input.id}' was not found.`);
      const metadata = {
        ...workflowObject(current.metadata),
        ...workflowObject(input.metadataPatch),
      };
      const write = await attempts.mutate(input.id, "cancel", {
        ...(input.reason ? { reason: input.reason } : {}),
        finishedAt: iso(input.finishedAt, now().toISOString()),
        ...(input.metadataPatch ? { metadata } : {}),
      }, writeOptions(namespace, input.identity, {
        threadId: String(current.threadId),
        visibility: input.visibility ?? { kind: "internal" },
      }));
      return fromMutation(write, mapLlmAttempt(write.record));
    },
    async get(namespace, id) {
      const record = await attempts.get(id, requireText(namespace, "Namespace"));
      return record ? mapLlmAttempt(record) : null;
    },
    async list(namespace, threadId, listOptions = {}) {
      const records = await attempts.list(requireText(namespace, "Namespace"), {
        where: { threadId },
        order: { field: "createdAt", direction: "asc" },
        ...(listOptions.after ? { after: listOptions.after } : {}),
        ...(listOptions.limit ? { limit: listOptions.limit } : {}),
      });
      return Object.freeze(records.map(mapLlmAttempt));
    },
  });
}

/** Engine ingress for tool executions. */
export function createCollectionToolExecutionRepository(
  options: CreateCollectionIngressOptions,
): ToolExecutionRepository {
  const createId = options.createId ?? ulid;
  const now = options.now ?? (() => new Date());
  const executions = requireCollection(options.collectionRuntime, "tool_execution");

  const roleFields = (input: {
    arguments?: DurableContentInput;
    output?: DurableContentInput;
    projectedOutput?: DurableContentInput;
    attachments?: DurableContentInput;
    errorDetail?: DurableContentInput;
  }): RoleContentInput[] => {
    const fields: RoleContentInput[] = [];
    if (input.arguments !== undefined) {
      fields.push({
        role: TOOL_CONTENT_ROLE.arguments,
        input: input.arguments,
        cardinality: "one",
      });
    }
    if (input.output !== undefined) {
      fields.push({
        role: TOOL_CONTENT_ROLE.output,
        input: input.output,
        cardinality: "one",
      });
    }
    if (input.projectedOutput !== undefined) {
      fields.push({
        role: TOOL_CONTENT_ROLE.projectedOutput,
        input: input.projectedOutput,
        cardinality: "one",
      });
    }
    if (input.attachments !== undefined) {
      fields.push({
        role: "attachment",
        input: input.attachments,
        cardinality: "many",
      });
    }
    if (input.errorDetail !== undefined) {
      fields.push({
        role: TOOL_CONTENT_ROLE.errorDetail,
        input: input.errorDetail,
        cardinality: "one",
      });
    }
    return fields;
  };

  return Object.freeze({
    async create(input) {
      const namespace = requireText(input.namespace, "Namespace");
      const threadId = requireText(input.threadId, "Thread ID");
      const id = workflowMutationId(
        "tool_execution",
        namespace,
        input.id,
        input.identity,
        createId,
      );
      const fields = roleFields(input);
      const content = await materializeRoles(options, namespace, {
        type: "tool_execution",
        id,
        threadId,
      }, fields);
      const created = await executions.create({
        id,
        threadId,
        ...(input.messageId ? { messageId: input.messageId } : {}),
        ...(input.participantId ? { participantId: input.participantId } : {}),
        ...(input.agentId ? { agentId: input.agentId } : {}),
        toolCallId: input.toolCallId,
        tool: structuredClone(input.tool),
        status: input.status ?? "running",
        content,
        ...(input.historyVisibility
          ? { historyVisibility: input.historyVisibility }
          : {}),
        startedAt: iso(input.startedAt, now().toISOString()),
        metadata: structuredClone(input.metadata ?? {}),
      }, writeOptions(namespace, input.identity, {
        threadId,
        visibility: input.visibility ?? { kind: "internal" },
      }));
      if (content.length) {
        await options.assets.linkOwner({
          transaction: options.session,
          tables: options.eventStore.tables,
        }, { namespace, ownerId: id, content });
      }
      return fromMutation(created, mapToolExecution(created.record));
    },
    async update(input) {
      const namespace = requireText(input.namespace, "Namespace");
      const current = await executions.get(input.id, namespace);
      if (!current) {
        throw new Error(`tool_execution '${input.id}' was not found.`);
      }
      const fields = roleFields(input);
      const replacement = await materializeRoles(options, namespace, {
        type: "tool_execution",
        id: input.id,
        threadId: String(current.threadId),
      }, fields);
      const content = replaceContentRoles(
        contentSequence(current.content),
        replacement,
        new Set(fields.map((field) => field.role)),
      );
      const metadata = {
        ...workflowObject(current.metadata),
        ...workflowObject(input.metadataPatch),
      };
      const write = await executions.update(input.id, {
        set: {
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.historyVisibility !== undefined
            ? { historyVisibility: input.historyVisibility }
            : {}),
          ...(fields.length ? { content } : {}),
          ...(input.metadataPatch ? { metadata } : {}),
        },
      }, writeOptions(namespace, input.identity, {
        threadId: String(current.threadId),
        visibility: input.visibility ?? { kind: "internal" },
      }));
      return fromMutation(write, mapToolExecution(write.record));
    },
    async complete(input) {
      const namespace = requireText(input.namespace, "Namespace");
      const current = await executions.get(input.id, namespace);
      if (!current) {
        throw new Error(`tool_execution '${input.id}' was not found.`);
      }
      const fields = roleFields(input);
      const replacement = await materializeRoles(options, namespace, {
        type: "tool_execution",
        id: input.id,
        threadId: String(current.threadId),
      }, fields);
      const content = replaceContentRoles(
        contentSequence(current.content),
        replacement,
        new Set(fields.map((field) => field.role)),
      );
      const metadata = {
        ...workflowObject(current.metadata),
        ...workflowObject(input.metadataPatch),
      };
      const write = await executions.mutate(input.id, "complete", {
        content,
        finishedAt: iso(input.finishedAt, now().toISOString()),
        ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
        ...(input.historyVisibility
          ? { historyVisibility: input.historyVisibility }
          : {}),
        ...(input.metadataPatch ? { metadata } : {}),
      }, writeOptions(namespace, input.identity, {
        threadId: String(current.threadId),
        visibility: input.visibility ?? { kind: "internal" },
      }));
      return fromMutation(write, mapToolExecution(write.record));
    },
    async fail(input) {
      const namespace = requireText(input.namespace, "Namespace");
      const current = await executions.get(input.id, namespace);
      if (!current) {
        throw new Error(`tool_execution '${input.id}' was not found.`);
      }
      const fields = roleFields(input);
      const replacement = await materializeRoles(options, namespace, {
        type: "tool_execution",
        id: input.id,
        threadId: String(current.threadId),
      }, fields);
      const content = replaceContentRoles(
        contentSequence(current.content),
        replacement,
        new Set(fields.map((field) => field.role)),
      );
      const metadata = {
        ...workflowObject(current.metadata),
        ...workflowObject(input.metadataPatch),
      };
      const write = await executions.mutate(input.id, "fail", {
        message: input.safeError.message,
        ...(input.safeError.code ? { code: input.safeError.code } : {}),
        content,
        finishedAt: iso(input.finishedAt, now().toISOString()),
        ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
        ...(input.historyVisibility
          ? { historyVisibility: input.historyVisibility }
          : {}),
        ...(input.metadataPatch ? { metadata } : {}),
      }, writeOptions(namespace, input.identity, {
        threadId: String(current.threadId),
        visibility: input.visibility ?? { kind: "internal" },
      }));
      return fromMutation(write, mapToolExecution(write.record));
    },
    async cancel(input) {
      const namespace = requireText(input.namespace, "Namespace");
      const current = await executions.get(input.id, namespace);
      if (!current) {
        throw new Error(`tool_execution '${input.id}' was not found.`);
      }
      const fields = roleFields(input);
      const replacement = await materializeRoles(options, namespace, {
        type: "tool_execution",
        id: input.id,
        threadId: String(current.threadId),
      }, fields);
      const content = replaceContentRoles(
        contentSequence(current.content),
        replacement,
        new Set(fields.map((field) => field.role)),
      );
      const metadata = {
        ...workflowObject(current.metadata),
        ...workflowObject(input.metadataPatch),
      };
      const write = await executions.mutate(input.id, "cancel", {
        ...(input.reason ? { reason: input.reason } : {}),
        content,
        finishedAt: iso(input.finishedAt, now().toISOString()),
        ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
        ...(input.historyVisibility
          ? { historyVisibility: input.historyVisibility }
          : {}),
        ...(input.metadataPatch ? { metadata } : {}),
      }, writeOptions(namespace, input.identity, {
        threadId: String(current.threadId),
        visibility: input.visibility ?? { kind: "internal" },
      }));
      return fromMutation(write, mapToolExecution(write.record));
    },
    async get(namespace, id) {
      const record = await executions.get(id, requireText(namespace, "Namespace"));
      return record ? mapToolExecution(record) : null;
    },
    async getByToolCallId(namespace, threadId, toolCallId) {
      const records = await executions.list(requireText(namespace, "Namespace"), {
        where: { threadId, toolCallId },
        order: { field: "createdAt", direction: "desc" },
        limit: 1,
      });
      return records[0] ? mapToolExecution(records[0]) : null;
    },
    async getByMessageToolCallId(namespace, threadId, messageId, toolCallId) {
      const records = await executions.list(requireText(namespace, "Namespace"), {
        where: { threadId, messageId, toolCallId },
        limit: 1,
      });
      return records[0] ? mapToolExecution(records[0]) : null;
    },
    async list(namespace, threadId, listOptions = {}) {
      const records = await executions.list(requireText(namespace, "Namespace"), {
        where: { threadId },
        order: { field: "createdAt", direction: "asc" },
        ...(listOptions.after ? { after: listOptions.after } : {}),
        ...(listOptions.limit ? { limit: listOptions.limit } : {}),
      });
      return Object.freeze(records.map(mapToolExecution));
    },
  });
}

export function coreCollectionsBound(runtime: CollectionRuntime): boolean {
  return Boolean(
    runtime.get("participant") &&
      runtime.get("thread") &&
      runtime.get("message") &&
      runtime.get("llm_attempt") &&
      runtime.get("tool_execution"),
  );
}
