import {
  type DurableContentInput,
  TOOL_CONTENT_ROLE,
} from "@copilotz/copilotz/content";
import type {
  FeatureContext,
  FeatureResource,
} from "@copilotz/copilotz/features";
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
  context: FeatureContext,
) {
  const id = requiredText(data.id, "Tool execution ID");
  const threadId = requiredText(data.threadId, "Thread ID");
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
  const { arguments: _arguments, sender: _sender, ...fields } = data;
  const created = await context.collections.tool_execution.create({
    ...fields,
    id,
    threadId,
    content,
    status: data.status ?? "running",
    startedAt: data.startedAt ?? new Date().toISOString(),
    metadata: structuredClone(asRecord(data.metadata)),
  }, {
    threadId,
    visibility: { kind: "internal" },
    ...(typeof data.participantId === "string" && data.participantId.trim()
      ? { routing: { senderId: data.participantId.trim() } }
      : {}),
  });
  await linkContent(context, id, content);
  return created;
}

async function create(input: unknown, context: FeatureContext) {
  return await createRecord(asRecord(input), context);
}

async function createBatch(input: unknown, context: FeatureContext) {
  const data = asRecord(input);
  const threadId = requiredText(data.threadId, "Thread ID");
  const items = Array.isArray(data.items) ? data.items.map(asRecord) : [];
  const created = [];
  for (const item of items) {
    if (item.sender) {
      const sender = await ensureParticipantInTransaction(
        context.collections,
        item.sender as ThreadMessageSender,
        threadId,
      );
      await addSenderToThreadInTransaction(
        context.collections,
        threadId,
        sender.id,
      );
    }
    created.push(await createRecord({ ...item, threadId }, context));
  }
  return Object.freeze(created);
}

async function current(input: unknown, context: FeatureContext) {
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

async function complete(input: unknown, context: FeatureContext) {
  const { data, id, record, threadId } = await current(input, context);
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
  const metadata = asRecord(data.metadata);
  const updated = await context.collections.tool_execution.commands.complete({
    id,
    content,
    finishedAt: data.finishedAt ?? new Date().toISOString(),
    ...(data.durationMs !== undefined ? { durationMs: data.durationMs } : {}),
    ...(data.historyVisibility
      ? { historyVisibility: data.historyVisibility }
      : {}),
    ...(Object.keys(metadata).length
      ? { metadata: { ...asRecord(record.metadata), ...metadata } }
      : {}),
  }, { threadId });
  await linkContent(context, id, content);
  return updated;
}

async function fail(input: unknown, context: FeatureContext) {
  const { data, id, record, threadId } = await current(input, context);
  const safeError = asRecord(data.safeError);
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
  const updated = await context.collections.tool_execution.commands.fail({
    id,
    message: String(safeError.message ?? "Tool execution failed"),
    ...(safeError.code ? { code: safeError.code } : {}),
    content,
    finishedAt: data.finishedAt ?? new Date().toISOString(),
    ...(data.durationMs !== undefined ? { durationMs: data.durationMs } : {}),
    ...(data.historyVisibility
      ? { historyVisibility: data.historyVisibility }
      : {}),
  }, { threadId });
  await linkContent(context, id, content);
  return updated;
}

async function cancel(input: unknown, context: FeatureContext) {
  const { data, id, record, threadId } = await current(input, context);
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
  const updated = await context.collections.tool_execution.commands.cancel({
    id,
    reason: String(data.reason ?? "Tool execution cancelled"),
    content,
    finishedAt: data.finishedAt ?? new Date().toISOString(),
    ...(data.durationMs !== undefined ? { durationMs: data.durationMs } : {}),
    ...(data.historyVisibility
      ? { historyVisibility: data.historyVisibility }
      : {}),
  }, { threadId });
  await linkContent(context, id, content);
  return updated;
}

async function patch(input: unknown, context: FeatureContext) {
  const { data, id, record, threadId } = await current(input, context);
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
  const metadataPatch = asRecord(data.metadataPatch);
  const updated = await context.collections.tool_execution.update({
    id,
    set: {
      content,
      ...(Object.keys(metadataPatch).length
        ? { metadata: { ...asRecord(record.metadata), ...metadataPatch } }
        : {}),
    },
  }, { threadId });
  await linkContent(context, id, content);
  return updated;
}

export const toolExecutionFeature: FeatureResource = Object.freeze({
  id: TOOL_EXECUTION_FEATURE_ID,
  alias: "toolExecution",
  actions: Object.freeze({
    create,
    createBatch,
    complete,
    fail,
    cancel,
    patch,
  }),
});
