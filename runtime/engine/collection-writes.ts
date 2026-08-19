import type { CollectionRecord } from "../collections/index.ts";
import type { DurableContentInput, PreparedContent } from "../content/index.ts";
import {
  composeRoleContent,
  contentSequence,
  LLM_CONTENT_ROLE,
  replaceContentRoles,
} from "../content/index.ts";
import type { CopilotzProcessorCapabilities } from "./types.ts";
import type { EventVisibility } from "../events/index.ts";
import { requireBoundCollection } from "./collection-graph.ts";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
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

export type CollectionParticipantInput = Readonly<{
  id?: string;
  externalId: string;
  participantType: string;
  name?: string;
  email?: string;
  agentId?: string;
  metadata?: Record<string, unknown>;
}>;

export async function loadCollectionRecord(
  context: CopilotzProcessorCapabilities,
  name: string,
  id: string,
): Promise<CollectionRecord | null> {
  return await requireBoundCollection(context, name).get(id, context.namespace);
}

export async function findParticipantByExternalId(
  context: CopilotzProcessorCapabilities,
  externalId: string,
): Promise<CollectionRecord | null> {
  const collection = requireBoundCollection(context, "participant");
  if (!collection.query.byExternalId) return null;
  const [record] = await collection.query.byExternalId(context.namespace, {
    externalId,
  });
  return record ?? null;
}

export async function ensureParticipantRecord(
  context: CopilotzProcessorCapabilities,
  input: CollectionParticipantInput,
  options: Readonly<{ operationKey: string; threadId?: string }>,
): Promise<CollectionRecord> {
  if (input.id?.trim()) {
    const existing = await loadCollectionRecord(
      context,
      "participant",
      input.id.trim(),
    );
    if (existing) return existing;
  }
  const existing = await findParticipantByExternalId(context, input.externalId);
  if (existing) return existing;
  const result = await context.transaction({
    operationKey: options.operationKey,
    namespace: context.namespace,
    execute: async ({ collections }) => {
      return await collections.participant.create({
        ...(input.id?.trim() ? { id: input.id.trim() } : {}),
        externalId: input.externalId,
        participantType: input.participantType,
        ...(input.name ? { name: input.name } : {}),
        ...(input.email ? { email: input.email } : {}),
        ...(input.agentId ? { agentId: input.agentId } : {}),
        metadata: structuredClone(input.metadata ?? {}),
      }, {
        namespace: context.namespace,
        ...(options.threadId ? { threadId: options.threadId } : {}),
      });
    },
  });
  return result.value.record;
}

export async function findThreadByExternalId(
  context: CopilotzProcessorCapabilities,
  externalId: string,
): Promise<CollectionRecord | null> {
  const collection = requireBoundCollection(context, "thread");
  if (!collection.query.byExternalId) return null;
  const [record] = await collection.query.byExternalId(context.namespace, {
    externalId,
  });
  return record ?? null;
}

export async function createThreadRecord(
  context: CopilotzProcessorCapabilities,
  input: Readonly<{
    id?: string;
    externalId?: string;
    name?: string;
    status?: string;
    parentThreadId?: string;
    metadata?: Record<string, unknown>;
    participantIds: readonly string[];
  }>,
  options: Readonly<{ operationKey: string }>,
): Promise<CollectionRecord> {
  const result = await context.transaction({
    operationKey: options.operationKey,
    namespace: context.namespace,
    execute: async ({ collections }) => {
      return await collections.thread.create({
        ...(input.id?.trim() ? { id: input.id.trim() } : {}),
        ...(input.externalId ? { externalId: input.externalId } : {}),
        ...(input.name ? { name: input.name } : {}),
        ...(input.status ? { status: input.status } : {}),
        ...(input.parentThreadId
          ? { parentThreadId: input.parentThreadId }
          : {}),
        metadata: structuredClone(input.metadata ?? {}),
        participantIds: [...input.participantIds],
      }, { namespace: context.namespace });
    },
  });
  return result.value.record;
}

export async function addParticipantToThreadRecord(
  context: CopilotzProcessorCapabilities,
  threadId: string,
  participantId: string,
  options: Readonly<{ operationKey: string }>,
): Promise<CollectionRecord> {
  const result = await context.transaction({
    operationKey: options.operationKey,
    namespace: context.namespace,
    execute: async ({ collections }) => {
      const thread = await collections.thread.get(threadId, context.namespace);
      if (!thread) throw new Error(`Thread '${threadId}' was not found.`);
      const current = stringArray(thread.participantIds);
      if (current.includes(participantId)) return thread;
      const updated = await collections.thread.update(threadId, {
        set: { participantIds: [...new Set([...current, participantId])] },
      }, { namespace: context.namespace, threadId });
      return updated.record;
    },
  });
  return result.value;
}

export async function createMessageRecord(
  context: CopilotzProcessorCapabilities,
  input: Readonly<{
    id: string;
    threadId: string;
    senderId: string;
    recipientIds: readonly string[];
    content: DurableContentInput;
    metadata?: Record<string, unknown>;
    visibility?: EventVisibility;
  }>,
  options: Readonly<{ operationKey: string }>,
): Promise<CollectionRecord> {
  const result = await context.transaction({
    operationKey: options.operationKey,
    namespace: context.namespace,
    execute: async ({ collections }) => {
      const content = await context.content.materialize(input.content, {
        origin: {
          scope: { type: "thread", id: input.threadId },
          producer: { type: "message", id: input.id },
        },
      });
      const created = await collections.message.create({
        id: input.id,
        threadId: input.threadId,
        senderId: input.senderId,
        recipientIds: [...input.recipientIds],
        content,
        metadata: structuredClone(input.metadata ?? {}),
      }, {
        namespace: context.namespace,
        threadId: input.threadId,
        routing: {
          senderId: input.senderId,
          recipientIds: [...input.recipientIds],
        },
        visibility: input.visibility ?? { kind: "public" },
      });
      if (content.length) await context.content.linkOwner(input.id, content);
      return created.record;
    },
  });
  return result.value;
}

export async function listMessageRecords(
  context: CopilotzProcessorCapabilities,
  threadId: string,
): Promise<readonly CollectionRecord[]> {
  return await requireBoundCollection(context, "message").list(
    context.namespace,
    {
      where: { threadId },
      order: { field: "createdAt", direction: "asc" },
      limit: 1_000,
    },
  );
}

export async function createLlmAttemptRecord(
  context: CopilotzProcessorCapabilities,
  input: Record<string, unknown>,
  options: Readonly<
    { operationKey: string; metadata?: Record<string, unknown> }
  >,
): Promise<CollectionRecord> {
  const { content: suppliedContent, ...fields } = input;
  const result = await context.transaction({
    operationKey: options.operationKey,
    namespace: context.namespace,
    ...(options.metadata ? { identity: { metadata: options.metadata } } : {}),
    execute: async ({ collections }) => {
      const content = suppliedContent !== undefined
        ? await context.content.materialize(
          suppliedContent as DurableContentInput,
          {
            origin: {
              scope: { type: "thread", id: String(input.threadId) },
              producer: { type: "llm_attempt", id: String(input.id) },
            },
          },
        )
        : undefined;
      const created = await collections.llm_attempt.create({
        ...fields,
        ...(content ? { content } : {}),
      }, {
        namespace: context.namespace,
        threadId: String(input.threadId),
        ...(options.metadata
          ? { identity: { metadata: options.metadata } }
          : {}),
      });
      if (content?.length) {
        await context.content.linkOwner(String(input.id), content);
      }
      return created;
    },
  });
  return result.value.record;
}

export async function completeLlmAttemptCollection(
  context: CopilotzProcessorCapabilities,
  attempt: CollectionRecord,
  input: Readonly<{
    answer?: PreparedContent;
    reasoning?: PreparedContent;
    toolCalls?: PreparedContent;
    finishReason?: string;
    usage?: Record<string, unknown>;
    cost?: Record<string, unknown>;
    metadataPatch?: Record<string, unknown>;
  }>,
  options: Readonly<{ operationKey: string }>,
): Promise<void> {
  const fields = [
    ...(input.answer
      ? [{
        role: LLM_CONTENT_ROLE.answer,
        input: input.answer,
        cardinality: "one" as const,
      }]
      : []),
    ...(input.reasoning
      ? [{
        role: LLM_CONTENT_ROLE.reasoning,
        input: input.reasoning,
        cardinality: "one" as const,
      }]
      : []),
    ...(input.toolCalls
      ? [{
        role: LLM_CONTENT_ROLE.toolCalls,
        input: input.toolCalls,
        cardinality: "one" as const,
      }]
      : []),
  ];
  await context.transaction({
    operationKey: options.operationKey,
    namespace: context.namespace,
    identity: { metadata: asRecord(attempt.metadata) },
    execute: async ({ collections }) => {
      const replacement = fields.length
        ? await context.content.materialize(composeRoleContent(fields), {
          origin: {
            scope: { type: "thread", id: String(attempt.threadId) },
            producer: { type: "llm_attempt", id: attempt.id },
          },
        })
        : contentSequence(attempt.content);
      const content = fields.length
        ? replaceContentRoles(
          contentSequence(attempt.content),
          replacement,
          new Set(fields.map((field) => field.role)),
        )
        : contentSequence(attempt.content);
      await collections.llm_attempt.mutate(attempt.id, "complete", {
        content,
        ...(input.finishReason ? { finishReason: input.finishReason } : {}),
        ...(input.usage ? { usage: input.usage } : {}),
        ...(input.cost ? { cost: input.cost } : {}),
        finishedAt: new Date().toISOString(),
        ...(input.metadataPatch
          ? {
            metadata: { ...asRecord(attempt.metadata), ...input.metadataPatch },
          }
          : {}),
      }, {
        namespace: context.namespace,
        threadId: String(attempt.threadId),
        identity: { metadata: asRecord(attempt.metadata) },
      });
      if (content.length) await context.content.linkOwner(attempt.id, content);
    },
  });
}

export async function failLlmAttemptCollection(
  context: CopilotzProcessorCapabilities,
  attempt: CollectionRecord,
  input: Readonly<{
    safeError: Readonly<{ message: string; code?: string }>;
    errorDetail?: PreparedContent;
  }>,
  options: Readonly<{ operationKey: string }>,
): Promise<void> {
  await context.transaction({
    operationKey: options.operationKey,
    namespace: context.namespace,
    identity: { metadata: asRecord(attempt.metadata) },
    execute: async ({ collections }) => {
      const content = input.errorDetail
        ? replaceContentRoles(
          contentSequence(attempt.content),
          await context.content.materialize(
            composeRoleContent([{
              role: LLM_CONTENT_ROLE.errorDetail,
              input: input.errorDetail,
              cardinality: "one",
            }]),
            {
              origin: {
                scope: { type: "thread", id: String(attempt.threadId) },
                producer: { type: "llm_attempt", id: attempt.id },
              },
            },
          ),
          new Set([LLM_CONTENT_ROLE.errorDetail]),
        )
        : contentSequence(attempt.content);
      await collections.llm_attempt.mutate(attempt.id, "fail", {
        message: input.safeError.message,
        ...(input.safeError.code ? { code: input.safeError.code } : {}),
        content,
        finishedAt: new Date().toISOString(),
      }, {
        namespace: context.namespace,
        threadId: String(attempt.threadId),
        identity: { metadata: asRecord(attempt.metadata) },
      });
      if (content.length) await context.content.linkOwner(attempt.id, content);
    },
  });
}

export async function createToolExecutionCollection(
  context: CopilotzProcessorCapabilities,
  input: Record<string, unknown>,
  options: Readonly<{
    operationKey: string;
    metadata?: Record<string, unknown>;
    content?: DurableContentInput;
  }>,
): Promise<CollectionRecord> {
  const result = await context.transaction({
    operationKey: options.operationKey,
    namespace: context.namespace,
    ...(options.metadata ? { identity: { metadata: options.metadata } } : {}),
    execute: async ({ collections }) => {
      const content = options.content
        ? await context.content.materialize(options.content, {
          origin: {
            scope: { type: "thread", id: String(input.threadId) },
            producer: { type: "tool_execution", id: String(input.id) },
          },
        })
        : undefined;
      const created = await collections.tool_execution.create({
        ...input,
        ...(content ? { content } : {}),
      }, {
        namespace: context.namespace,
        threadId: String(input.threadId),
        visibility: { kind: "internal" },
        ...(optionalText(input.participantId)
          ? { routing: { senderId: String(input.participantId) } }
          : {}),
        ...(options.metadata
          ? { identity: { metadata: options.metadata } }
          : {}),
      });
      if (content?.length) {
        await context.content.linkOwner(String(input.id), content);
      }
      return created;
    },
  });
  return result.value.record;
}

export async function updateParticipantRecord(
  context: CopilotzProcessorCapabilities,
  id: string,
  patch: Record<string, unknown>,
  options: Readonly<{ operationKey: string }>,
): Promise<CollectionRecord> {
  const result = await context.transaction({
    operationKey: options.operationKey,
    namespace: context.namespace,
    execute: async ({ collections }) => {
      return await collections.participant.update(id, { set: patch }, {
        namespace: context.namespace,
      });
    },
  });
  return result.value.record;
}

export async function updateThreadRecord(
  context: CopilotzProcessorCapabilities,
  id: string,
  patch: Record<string, unknown>,
  options: Readonly<{ operationKey: string }>,
): Promise<CollectionRecord> {
  const result = await context.transaction({
    operationKey: options.operationKey,
    namespace: context.namespace,
    execute: async ({ collections }) => {
      return await collections.thread.update(id, { set: patch }, {
        namespace: context.namespace,
        threadId: id,
      });
    },
  });
  return result.value.record;
}

export { asRecord, optionalText, requireBoundCollection, stringArray };
