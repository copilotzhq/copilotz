import type {
  CollectionRecord,
  CollectionWriteOptions,
} from "@copilotz/copilotz/collections";
import type {
  ContentSequence,
  DurableContentInput,
  PreparedContent,
} from "@copilotz/copilotz/content";
import type { SafeWorkflowError } from "@copilotz/copilotz/domain";
import {
  composeRoleContent,
  LLM_CONTENT_ROLE,
  replaceContentRoles,
  type RoleContentInput,
  TOOL_CONTENT_ROLE,
} from "@copilotz/copilotz/content";
import type { CopilotzProcessorContext } from "@copilotz/copilotz/engine";
import type { EventVisibility } from "@copilotz/copilotz/events";
import {
  addSenderToThreadInTransaction,
  ensureParticipantInTransaction,
  THREAD_MESSAGE_FEATURE_ID,
  type ThreadMessageSender,
} from "../features/thread-message.ts";
import {
  asRecord,
  requireCollection,
} from "./helpers.ts";

type RoleField = Readonly<{
  role: string;
  input?: DurableContentInput;
  cardinality?: "one" | "many";
}>;

export function asContentSequence(
  value: ContentSequence | PreparedContent | undefined,
): ContentSequence {
  if (!value) return Object.freeze([]);
  if (Array.isArray(value)) return Object.freeze([...value]) as ContentSequence;
  if ("content" in value && Array.isArray(value.content)) {
    return Object.freeze(value.content);
  }
  return Object.freeze([]);
}

function contentSequence(value: unknown): ContentSequence {
  if (!Array.isArray(value)) return Object.freeze([]);
  return Object.freeze(value) as ContentSequence;
}

function definedRoleFields(fields: readonly RoleField[]): RoleContentInput[] {
  return fields.flatMap((field) =>
    field.input === undefined ? [] : [{
      role: field.role,
      input: field.input,
      ...(field.cardinality ? { cardinality: field.cardinality } : {}),
    }]
  );
}

type SenderInput = ThreadMessageSender;

function asMessageRecord(value: unknown): CollectionRecord {
  const record = asRecord(value);
  if (typeof record.id !== "string" || !record.id.trim()) {
    throw new Error(
      `Feature '${THREAD_MESSAGE_FEATURE_ID}.create' did not return a message record.`,
    );
  }
  return record as CollectionRecord;
}

async function persistRoleContent(
  context: CopilotzProcessorContext,
  owner: Readonly<{ type: string; id: string; threadId: string }>,
  current: ContentSequence,
  fields: readonly RoleField[],
): Promise<ContentSequence> {
  const active = definedRoleFields(fields);
  if (!active.length) return current;
  const replacement = await context.content.materialize(
    composeRoleContent(active),
    {
      origin: {
        scope: { type: "thread", id: owner.threadId },
        producer: { type: owner.type, id: owner.id },
      },
    },
  );
  return replaceContentRoles(
    current,
    replacement,
    new Set(active.map((field) => field.role)),
  );
}

async function persistInputContent(
  context: CopilotzProcessorContext,
  owner: Readonly<{ type: string; id: string; threadId: string }>,
  input: DurableContentInput,
): Promise<ContentSequence> {
  const sequence = asContentSequence(input);
  const hasAssets = !Array.isArray(input) && "assets" in input &&
    Array.isArray(input.assets) && input.assets.length > 0;
  if (!sequence.length && !hasAssets) return Object.freeze([]);
  return await context.content.materialize(input, {
    origin: {
      scope: { type: "thread", id: owner.threadId },
      producer: { type: owner.type, id: owner.id },
    },
  });
}

async function persistToolExecutionRoles(
  context: CopilotzProcessorContext,
  execution: CollectionRecord,
  fields: readonly RoleField[],
): Promise<{ current: CollectionRecord; content: ContentSequence }> {
  const current = await requireCollection(context, "tool_execution").get(
    execution.id,
    context.namespace,
  );
  if (!current) {
    throw new Error(`Tool execution '${execution.id}' was not found.`);
  }
  const content = await persistRoleContent(
    context,
    { type: "tool_execution", id: execution.id, threadId: String(execution.threadId) },
    contentSequence(current.content),
    fields,
  );
  return { current, content };
}

async function linkIfNeeded(
  context: CopilotzProcessorContext,
  ownerId: string,
  content: ContentSequence,
): Promise<void> {
  if (!content.length) return;
  await context.content.linkOwner(ownerId, content);
}

function writeOptions(
  context: CopilotzProcessorContext,
  extra: Omit<CollectionWriteOptions, "namespace"> = {},
): CollectionWriteOptions {
  return {
    namespace: context.namespace,
    ...extra,
  };
}

export async function createThreadMessage(
  context: CopilotzProcessorContext,
  input: Readonly<{
    id: string;
    threadId: string;
    sender: SenderInput;
    recipientIds: readonly string[];
    content: ContentSequence | PreparedContent;
    visibility?: EventVisibility;
    metadata?: Record<string, unknown>;
  }>,
  options: Readonly<{ operationKey: string; metadata?: Record<string, unknown> }>,
): Promise<CollectionRecord> {
  const content = await persistInputContent(context, {
    type: "message",
    id: input.id,
    threadId: input.threadId,
  }, input.content);
  const record = asMessageRecord(
    await context.features.invoke(THREAD_MESSAGE_FEATURE_ID, "create", {
      id: input.id,
      threadId: input.threadId,
      sender: input.sender,
      recipientIds: input.recipientIds,
      content,
      visibility: input.visibility,
      metadata: input.metadata,
      operationKey: options.operationKey,
      ...(options.metadata ? { identity: { metadata: options.metadata } } : {}),
    }),
  );
  await linkIfNeeded(context, input.id, content);
  return record;
}

export async function completeLlmAttemptRecord(
  context: CopilotzProcessorContext,
  attempt: CollectionRecord,
  input: Readonly<{
    answer?: PreparedContent;
    reasoning?: PreparedContent;
    toolCalls?: PreparedContent;
    finishReason?: string;
    usage?: Record<string, unknown>;
    cost?: Record<string, unknown>;
    metricsFinalizedAt?: string;
    metadataPatch?: Record<string, unknown>;
  }>,
  options: Readonly<{ operationKey: string }>,
): Promise<void> {
  const attempts = requireCollection(context, "llm_attempt");
  const current = await attempts.get(attempt.id, context.namespace);
  if (!current) {
    throw new Error(`LLM attempt '${attempt.id}' was not found.`);
  }
  const content = await persistRoleContent(
    context,
    { type: "llm_attempt", id: attempt.id, threadId: String(attempt.threadId) },
    contentSequence(current.content),
    [
      { role: LLM_CONTENT_ROLE.answer, input: input.answer, cardinality: "one" },
      { role: LLM_CONTENT_ROLE.reasoning, input: input.reasoning, cardinality: "one" },
      { role: LLM_CONTENT_ROLE.toolCalls, input: input.toolCalls, cardinality: "one" },
    ],
  );
  await context.transaction({
    operationKey: options.operationKey,
    namespace: context.namespace,
    execute: async ({ collections }) => {
      await collections.llm_attempt.mutate(attempt.id, "complete", {
        content,
        ...(input.finishReason ? { finishReason: input.finishReason } : {}),
        ...(input.usage ? { usage: input.usage } : {}),
        ...(input.cost ? { cost: input.cost } : {}),
        finishedAt: new Date().toISOString(),
        ...(input.metricsFinalizedAt
          ? { metricsFinalizedAt: input.metricsFinalizedAt }
          : {}),
        ...(input.metadataPatch
          ? { metadata: { ...asRecord(current.metadata), ...input.metadataPatch } }
          : {}),
      }, writeOptions(context, { threadId: String(attempt.threadId) }));
    },
  });
  await linkIfNeeded(context, attempt.id, content);
}

export async function failLlmAttemptRecord(
  context: CopilotzProcessorContext,
  attempt: CollectionRecord,
  input: Readonly<{
    safeError: SafeWorkflowError;
    errorDetail?: PreparedContent;
  }>,
  options: Readonly<{ operationKey: string }>,
): Promise<void> {
  const attempts = requireCollection(context, "llm_attempt");
  const current = await attempts.get(attempt.id, context.namespace);
  if (!current) {
    throw new Error(`LLM attempt '${attempt.id}' was not found.`);
  }
  const content = await persistRoleContent(
    context,
    { type: "llm_attempt", id: attempt.id, threadId: String(attempt.threadId) },
    contentSequence(current.content),
    [{ role: LLM_CONTENT_ROLE.errorDetail, input: input.errorDetail, cardinality: "one" }],
  );
  await context.transaction({
    operationKey: options.operationKey,
    namespace: context.namespace,
    execute: async ({ collections }) => {
      await collections.llm_attempt.mutate(attempt.id, "fail", {
        message: input.safeError.message,
        ...(input.safeError.code ? { code: input.safeError.code } : {}),
        content,
        finishedAt: new Date().toISOString(),
      }, writeOptions(context, { threadId: String(attempt.threadId) }));
    },
  });
  await linkIfNeeded(context, attempt.id, content);
}

export async function cancelLlmAttemptRecord(
  context: CopilotzProcessorContext,
  attempt: CollectionRecord,
  input: Readonly<{ reason: string }>,
  options: Readonly<{ operationKey: string }>,
): Promise<void> {
  await context.transaction({
    operationKey: options.operationKey,
    namespace: context.namespace,
    execute: async ({ collections }) => {
      await collections.llm_attempt.mutate(attempt.id, "cancel", {
        reason: input.reason,
        finishedAt: new Date().toISOString(),
      }, writeOptions(context, { threadId: String(attempt.threadId) }));
    },
  });
}

export async function createToolExecutionRecord(
  context: CopilotzProcessorContext,
  input: Readonly<{
    id: string;
    threadId: string;
    messageId?: string;
    participantId?: string;
    agentId?: string;
    toolCallId: string;
    tool: object;
    arguments: PreparedContent;
    status?: string;
    historyVisibility?: string;
    metadata?: Record<string, unknown>;
  }>,
  options: Readonly<{ operationKey: string; metadata?: Record<string, unknown> }>,
): Promise<void> {
  const content = await persistRoleContent(
    context,
    { type: "tool_execution", id: input.id, threadId: input.threadId },
    Object.freeze([]),
    [{
      role: TOOL_CONTENT_ROLE.arguments,
      input: input.arguments,
      cardinality: "one",
    }],
  );
  await context.transaction({
    operationKey: options.operationKey,
    namespace: context.namespace,
    ...(options.metadata ? { identity: { metadata: options.metadata } } : {}),
    execute: async ({ collections }) => {
      await collections.tool_execution.create({
        id: input.id,
        threadId: input.threadId,
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
        startedAt: new Date().toISOString(),
        metadata: structuredClone(input.metadata ?? {}),
      }, writeOptions(context, {
        threadId: input.threadId,
        visibility: { kind: "internal" },
        ...(input.participantId
          ? { routing: { senderId: input.participantId } }
          : {}),
        ...(options.metadata ? { identity: { metadata: options.metadata } } : {}),
      }));
    },
  });
  await linkIfNeeded(context, input.id, content);
}

export async function createToolExecutionBatch(
  context: CopilotzProcessorContext,
  input: Readonly<{
    threadId: string;
    items: readonly Readonly<{
      id: string;
      messageId?: string;
      participantId?: string;
      agentId?: string;
      toolCallId: string;
      tool: object;
      arguments: PreparedContent;
      status?: string;
      historyVisibility?: string;
      metadata?: Record<string, unknown>;
      sender?: SenderInput;
    }>[];
  }>,
  options: Readonly<{ operationKey: string }>,
): Promise<void> {
  const contents: ContentSequence[] = [];
  for (const item of input.items) {
    contents.push(
      await persistRoleContent(
        context,
        { type: "tool_execution", id: item.id, threadId: input.threadId },
        Object.freeze([]),
        [{
          role: TOOL_CONTENT_ROLE.arguments,
          input: item.arguments,
          cardinality: "one",
        }],
      ),
    );
  }
  await context.transaction({
    operationKey: options.operationKey,
    namespace: context.namespace,
    execute: async ({ collections }) => {
      for (const [index, item] of input.items.entries()) {
        if (item.sender) {
          const sender = await ensureParticipantInTransaction(
            collections,
            context.namespace,
            item.sender,
            input.threadId,
          );
          await addSenderToThreadInTransaction(
            collections,
            context.namespace,
            input.threadId,
            sender.id,
          );
        }
        const content = contents[index] ?? Object.freeze([]);
        await collections.tool_execution.create({
          id: item.id,
          threadId: input.threadId,
          ...(item.messageId ? { messageId: item.messageId } : {}),
          ...(item.participantId ? { participantId: item.participantId } : {}),
          ...(item.agentId ? { agentId: item.agentId } : {}),
          toolCallId: item.toolCallId,
          tool: structuredClone(item.tool),
          status: item.status ?? "running",
          content,
          ...(item.historyVisibility
            ? { historyVisibility: item.historyVisibility }
            : {}),
          startedAt: new Date().toISOString(),
          metadata: structuredClone(item.metadata ?? {}),
        }, writeOptions(context, {
          threadId: input.threadId,
          visibility: { kind: "internal" },
          ...(item.participantId
            ? { routing: { senderId: item.participantId } }
            : {}),
          ...(item.metadata ? { identity: { metadata: item.metadata } } : {}),
        }));
      }
    },
  });
  await Promise.all(
    input.items.map((item, index) =>
      linkIfNeeded(context, item.id, contents[index] ?? Object.freeze([]))
    ),
  );
}

export async function completeToolExecutionRecord(
  context: CopilotzProcessorContext,
  execution: CollectionRecord,
  input: Readonly<{
    output?: PreparedContent;
    projectedOutput?: PreparedContent;
    attachments?: PreparedContent;
    historyVisibility?: string;
    durationMs?: number;
    metadata?: Record<string, unknown>;
  }>,
  options: Readonly<{ operationKey: string; metadata?: Record<string, unknown> }>,
): Promise<void> {
  const { current, content } = await persistToolExecutionRoles(context, execution, [
    { role: TOOL_CONTENT_ROLE.output, input: input.output, cardinality: "one" },
    { role: TOOL_CONTENT_ROLE.projectedOutput, input: input.projectedOutput, cardinality: "one" },
    { role: "attachment", input: input.attachments, cardinality: "many" },
  ]);
  await context.transaction({
    operationKey: options.operationKey,
    namespace: context.namespace,
    ...(options.metadata ? { identity: { metadata: options.metadata } } : {}),
    execute: async ({ collections }) => {
      await collections.tool_execution.mutate(execution.id, "complete", {
        content,
        finishedAt: new Date().toISOString(),
        ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
        ...(input.historyVisibility
          ? { historyVisibility: input.historyVisibility }
          : {}),
        ...(input.metadata
          ? { metadata: { ...asRecord(current.metadata), ...input.metadata } }
          : {}),
      }, writeOptions(context, {
        threadId: String(execution.threadId),
        ...(options.metadata ? { identity: { metadata: options.metadata } } : {}),
      }));
    },
  });
  await linkIfNeeded(context, execution.id, content);
}

export async function failToolExecutionRecord(
  context: CopilotzProcessorContext,
  execution: CollectionRecord,
  input: Readonly<{
    safeError: SafeWorkflowError;
    errorDetail?: PreparedContent;
    projectedOutput?: PreparedContent;
    historyVisibility?: string;
    durationMs?: number;
  }>,
  options: Readonly<{ operationKey: string; metadata?: Record<string, unknown> }>,
): Promise<void> {
  const { content } = await persistToolExecutionRoles(context, execution, [
    { role: TOOL_CONTENT_ROLE.errorDetail, input: input.errorDetail, cardinality: "one" },
    { role: TOOL_CONTENT_ROLE.projectedOutput, input: input.projectedOutput, cardinality: "one" },
  ]);
  await context.transaction({
    operationKey: options.operationKey,
    namespace: context.namespace,
    ...(options.metadata ? { identity: { metadata: options.metadata } } : {}),
    execute: async ({ collections }) => {
      await collections.tool_execution.mutate(execution.id, "fail", {
        message: input.safeError.message,
        ...(input.safeError.code ? { code: input.safeError.code } : {}),
        content,
        finishedAt: new Date().toISOString(),
        ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
        ...(input.historyVisibility
          ? { historyVisibility: input.historyVisibility }
          : {}),
      }, writeOptions(context, {
        threadId: String(execution.threadId),
        ...(options.metadata ? { identity: { metadata: options.metadata } } : {}),
      }));
    },
  });
  await linkIfNeeded(context, execution.id, content);
}

export async function cancelToolExecutionRecord(
  context: CopilotzProcessorContext,
  execution: CollectionRecord,
  input: Readonly<{
    reason: string;
    errorDetail?: PreparedContent;
    projectedOutput?: PreparedContent;
    historyVisibility?: string;
    durationMs?: number;
  }>,
  options: Readonly<{ operationKey: string; metadata?: Record<string, unknown> }>,
): Promise<void> {
  const { content } = await persistToolExecutionRoles(context, execution, [
    { role: TOOL_CONTENT_ROLE.errorDetail, input: input.errorDetail, cardinality: "one" },
    { role: TOOL_CONTENT_ROLE.projectedOutput, input: input.projectedOutput, cardinality: "one" },
  ]);
  await context.transaction({
    operationKey: options.operationKey,
    namespace: context.namespace,
    ...(options.metadata ? { identity: { metadata: options.metadata } } : {}),
    execute: async ({ collections }) => {
      await collections.tool_execution.mutate(execution.id, "cancel", {
        reason: input.reason,
        content,
        finishedAt: new Date().toISOString(),
        ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
        ...(input.historyVisibility
          ? { historyVisibility: input.historyVisibility }
          : {}),
      }, writeOptions(context, {
        threadId: String(execution.threadId),
        ...(options.metadata ? { identity: { metadata: options.metadata } } : {}),
      }));
    },
  });
  await linkIfNeeded(context, execution.id, content);
}

export async function patchToolExecutionRecord(
  context: CopilotzProcessorContext,
  execution: CollectionRecord,
  input: Readonly<{
    projectedOutput?: PreparedContent;
    metadataPatch?: Record<string, unknown>;
  }>,
  options: Readonly<{ operationKey: string }>,
): Promise<CollectionRecord | undefined> {
  const { current, content } = await persistToolExecutionRoles(context, execution, [
    { role: TOOL_CONTENT_ROLE.projectedOutput, input: input.projectedOutput, cardinality: "one" },
  ]);
  const result = await context.transaction({
    operationKey: options.operationKey,
    namespace: context.namespace,
    execute: async ({ collections }) => {
      const metadata = input.metadataPatch
        ? { ...asRecord(current.metadata), ...input.metadataPatch }
        : undefined;
      await collections.tool_execution.update(execution.id, {
        set: {
          ...(input.projectedOutput ? { content } : {}),
          ...(metadata ? { metadata } : {}),
        },
      }, writeOptions(context, { threadId: String(execution.threadId) }));
      const updated = await collections.tool_execution.get(
        execution.id,
        context.namespace,
      );
      return updated ?? undefined;
    },
  });
  await linkIfNeeded(context, execution.id, content);
  return result.value;
}
