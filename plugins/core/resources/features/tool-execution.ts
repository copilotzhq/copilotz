import {
  type DurableContentInput,
  TOOL_CONTENT_ROLE,
} from "@copilotz/copilotz/content";
import {
  defineFeature,
  type FeatureAction,
  type FeatureDefinition,
  type FeatureExecuteContext,
} from "@copilotz/copilotz/features";
import type { CollectionRecord } from "@copilotz/copilotz/collections";
import type { JsonSchema } from "../../../../dependencies/ominipg.ts";
import {
  addSenderToThreadInTransaction,
  ensureParticipantInTransaction,
  type ThreadMessageSender,
} from "./thread-message.ts";
import {
  asRecord,
  contentSequence,
  linkContent,
  persistRoleContent,
  preparedContent,
  requiredText,
} from "./content-policy.ts";

export const TOOL_EXECUTION_FEATURE_ID = "copilotz.core.tool-execution";

async function createRecord(
  data: Record<string, unknown>,
  context: FeatureExecuteContext,
): Promise<CollectionRecord> {
  const id = requiredText(data.id, "Tool execution ID");
  const threadId = requiredText(data.threadId, "Thread ID");
  const { arguments: _arguments, sender: _sender, ...fields } = data;
  const metadata = structuredClone(asRecord(data.metadata));
  return await context.transaction(async (tx) => {
    const supplied = data.arguments as DurableContentInput | undefined;
    const content = supplied === undefined
      ? contentSequence(data.content)
      : await persistRoleContent(
        context,
        { type: "tool_execution", id, threadId },
        contentSequence(data.content),
        [{
          role: TOOL_CONTENT_ROLE.arguments,
          input: supplied,
          cardinality: "one",
        }],
      );
    const created = await tx.collections.tool_execution.create({
      ...fields,
      id,
      threadId,
      content,
      status: data.status ?? "running",
      startedAt: data.startedAt ?? new Date().toISOString(),
      metadata,
    }, {
      threadId,
      identity: { metadata },
      visibility: { kind: "internal" },
      ...(typeof data.participantId === "string" && data.participantId.trim()
        ? { routing: { senderId: data.participantId.trim() } }
        : {}),
    });
    await linkContent(context, id, content);
    return created;
  });
}

async function create(
  input: unknown,
  context: FeatureExecuteContext,
): Promise<CollectionRecord> {
  return await createRecord(asRecord(input), context);
}

async function createBatch(
  input: unknown,
  context: FeatureExecuteContext,
): Promise<readonly CollectionRecord[]> {
  const data = asRecord(input);
  const threadId = requiredText(data.threadId, "Thread ID");
  const items = Array.isArray(data.items) ? data.items.map(asRecord) : [];
  return await context.transaction(async (tx) => {
    const created = [];
    for (const item of items) {
      if (item.sender) {
        const sender = await ensureParticipantInTransaction(
          tx.collections,
          item.sender as ThreadMessageSender,
          threadId,
        );
        await addSenderToThreadInTransaction(
          tx.collections,
          threadId,
          sender.id,
        );
      }
      created.push(await createRecord({ ...item, threadId }, context));
    }
    return Object.freeze(created);
  });
}

async function current(
  input: unknown,
  context: FeatureExecuteContext,
): Promise<
  Readonly<{
    data: Record<string, unknown>;
    id: string;
    record: CollectionRecord;
    threadId: string;
  }>
> {
  const data = asRecord(input);
  const id = requiredText(data.id, "Tool execution ID");
  const record = await context.collections.tool_execution.get({ id });
  if (!record) throw new Error(`Tool execution '${id}' was not found.`);
  return {
    data,
    id,
    record,
    threadId: requiredText(record.threadId, "Thread ID"),
  };
}

async function complete(
  input: unknown,
  context: FeatureExecuteContext,
): Promise<CollectionRecord> {
  const { data, id, record, threadId } = await current(input, context);
  const metadata = asRecord(data.metadata);
  const eventMetadata = { ...asRecord(record.metadata), ...metadata };
  return await context.transaction(async (tx) => {
    const content = await persistRoleContent(
      context,
      { type: "tool_execution", id, threadId },
      contentSequence(record.content),
      [
        {
          role: TOOL_CONTENT_ROLE.output,
          input: preparedContent(data.output),
          cardinality: "one",
        },
        {
          role: TOOL_CONTENT_ROLE.projectedOutput,
          input: preparedContent(data.projectedOutput),
          cardinality: "one",
        },
        {
          role: "attachment",
          input: preparedContent(data.attachments),
          cardinality: "many",
        },
      ],
    );
    const updated = await tx.collections.tool_execution.commands.complete({
      id,
      content,
      finishedAt: data.finishedAt ?? new Date().toISOString(),
      ...(data.durationMs !== undefined ? { durationMs: data.durationMs } : {}),
      ...(data.historyVisibility
        ? { historyVisibility: data.historyVisibility }
        : {}),
      ...(Object.keys(metadata).length ? { metadata: eventMetadata } : {}),
    }, { threadId, identity: { metadata: eventMetadata } });
    await linkContent(context, id, content);
    return updated;
  });
}

async function fail(
  input: unknown,
  context: FeatureExecuteContext,
): Promise<CollectionRecord> {
  const { data, id, record, threadId } = await current(input, context);
  const safeError = asRecord(data.safeError);
  return await context.transaction(async (tx) => {
    const content = await persistRoleContent(
      context,
      { type: "tool_execution", id, threadId },
      contentSequence(record.content),
      [
        {
          role: TOOL_CONTENT_ROLE.errorDetail,
          input: preparedContent(data.errorDetail),
          cardinality: "one",
        },
        {
          role: TOOL_CONTENT_ROLE.projectedOutput,
          input: preparedContent(data.projectedOutput),
          cardinality: "one",
        },
      ],
    );
    const updated = await tx.collections.tool_execution.commands.fail({
      id,
      message: String(safeError.message ?? "Tool execution failed"),
      ...(safeError.code ? { code: safeError.code } : {}),
      content,
      finishedAt: data.finishedAt ?? new Date().toISOString(),
      ...(data.durationMs !== undefined ? { durationMs: data.durationMs } : {}),
      ...(data.historyVisibility
        ? { historyVisibility: data.historyVisibility }
        : {}),
    }, { threadId, identity: { metadata: asRecord(record.metadata) } });
    await linkContent(context, id, content);
    return updated;
  });
}

async function cancel(
  input: unknown,
  context: FeatureExecuteContext,
): Promise<CollectionRecord> {
  const { data, id, record, threadId } = await current(input, context);
  return await context.transaction(async (tx) => {
    const content = await persistRoleContent(
      context,
      { type: "tool_execution", id, threadId },
      contentSequence(record.content),
      [
        {
          role: TOOL_CONTENT_ROLE.errorDetail,
          input: preparedContent(data.errorDetail),
          cardinality: "one",
        },
        {
          role: TOOL_CONTENT_ROLE.projectedOutput,
          input: preparedContent(data.projectedOutput),
          cardinality: "one",
        },
      ],
    );
    const updated = await tx.collections.tool_execution.commands.cancel({
      id,
      reason: String(data.reason ?? "Tool execution cancelled"),
      content,
      finishedAt: data.finishedAt ?? new Date().toISOString(),
      ...(data.durationMs !== undefined ? { durationMs: data.durationMs } : {}),
      ...(data.historyVisibility
        ? { historyVisibility: data.historyVisibility }
        : {}),
    }, { threadId, identity: { metadata: asRecord(record.metadata) } });
    await linkContent(context, id, content);
    return updated;
  });
}

async function patch(
  input: unknown,
  context: FeatureExecuteContext,
): Promise<CollectionRecord> {
  const { data, id, record, threadId } = await current(input, context);
  const metadataPatch = asRecord(data.metadataPatch);
  const metadata = { ...asRecord(record.metadata), ...metadataPatch };
  return await context.transaction(async (tx) => {
    const content = await persistRoleContent(
      context,
      { type: "tool_execution", id, threadId },
      contentSequence(record.content),
      [{
        role: TOOL_CONTENT_ROLE.projectedOutput,
        input: preparedContent(data.projectedOutput),
        cardinality: "one",
      }],
    );
    const updated = await tx.collections.tool_execution.update({
      id,
      set: {
        content,
        ...(Object.keys(metadataPatch).length ? { metadata } : {}),
      },
    }, { threadId, identity: { metadata } });
    await linkContent(context, id, content);
    return updated;
  });
}

const idInput = {
  type: "object",
  additionalProperties: true,
  properties: {
    id: { type: "string" },
  },
  required: ["id"],
} as const;

const createInput = {
  type: "object",
  additionalProperties: true,
  properties: {
    id: { type: "string" },
    threadId: { type: "string" },
    arguments: {},
    content: {},
  },
  required: ["id", "threadId"],
} as const;

const createBatchInput = {
  type: "object",
  additionalProperties: true,
  properties: {
    threadId: { type: "string" },
    items: { type: "array", items: { type: "object" } },
  },
  required: ["threadId"],
} as const;

type TransactionAction<
  S extends JsonSchema,
  O,
> = FeatureAction<S, O>;

type ToolExecutionFeature = FeatureDefinition<{
  create: TransactionAction<typeof createInput, CollectionRecord>;
  createBatch: TransactionAction<
    typeof createBatchInput,
    readonly CollectionRecord[]
  >;
  complete: TransactionAction<typeof idInput, CollectionRecord>;
  fail: TransactionAction<typeof idInput, CollectionRecord>;
  cancel: TransactionAction<typeof idInput, CollectionRecord>;
  patch: TransactionAction<typeof idInput, CollectionRecord>;
}>;

const toolExecutionFeatureDefinition: ToolExecutionFeature = defineFeature({
  id: TOOL_EXECUTION_FEATURE_ID,
  actions: {
    create: {
      inputSchema: createInput,
      execute: create,
    },
    createBatch: {
      inputSchema: createBatchInput,
      execute: createBatch,
    },
    complete: {
      inputSchema: idInput,
      execute: complete,
    },
    fail: {
      inputSchema: idInput,
      execute: fail,
    },
    cancel: {
      inputSchema: idInput,
      execute: cancel,
    },
    patch: {
      inputSchema: idInput,
      execute: patch,
    },
  },
});

export const toolExecutionFeature: ToolExecutionFeature =
  toolExecutionFeatureDefinition;
