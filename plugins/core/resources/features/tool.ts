import {
  type ContentRef,
  mergePreparedContent,
} from "@copilotz/copilotz/content";
import type { CollectionRecord } from "@copilotz/copilotz/collections";
import type { CopilotzEvent } from "@copilotz/copilotz/events";
import type { CopilotzProcessorContext } from "@copilotz/copilotz/engine";
import {
  defineFeature,
  type FeatureAction,
  type FeatureDefinition,
  type FeatureExecuteContext,
} from "@copilotz/copilotz/features";
import {
  executeTool,
  type WorkflowToolHostContext,
} from "@copilotz/copilotz/tools";
import {
  asRecord,
  historyVisibilityOf,
  optionalText,
  policyOptions,
  recordThreadId,
  requiredText,
  resolvedValue,
  stringArray,
  toolCatalogFor,
  toolField,
  valueContent,
} from "../processors/helpers.ts";

const DEFAULT_TOOL_TIMEOUT_MS = 300_000;
export const TOOL_FEATURE_ID = "copilotz.core.tool";
export const TOOL_BATCH_FEATURE_ID = "copilotz.core.tool-batch";

async function executeCall(
  input: unknown,
  context: FeatureExecuteContext,
): Promise<Readonly<Record<string, unknown>>> {
  const execution = asRecord(input) as CollectionRecord;
  const event = asRecord(execution.sourceEvent) as unknown as CopilotzEvent;
  if (!event.type || !event.namespace || !event.correlationId) {
    throw new TypeError("Tool call requires a source Event.");
  }
  if (!context.signal) {
    throw new Error("Tool call requires a cancellable invocation context.");
  }
  const toolContext = context as unknown as WorkflowToolHostContext;
  const agent = optionalText(execution.agentId)
    ? context.agents[optionalText(execution.agentId)!]
    : undefined;
  const toolCatalog = toolCatalogFor(
    context as unknown as CopilotzProcessorContext,
    agent,
  );
  const options = agent ? policyOptions(agent) : {};
  const toolId = requiredText(
    typeof toolField(execution, "id") === "string"
      ? toolField(execution, "id") as string
      : undefined,
    "Tool execution tool id",
  );
  const granted = new Set(stringArray(execution.availableToolIds));
  const catalog = agent
    ? await toolCatalog.forAgent(
      context as unknown as CopilotzProcessorContext,
      agent,
    )
    : await toolCatalog.all(context as unknown as CopilotzProcessorContext);
  const availableTools = granted.size
    ? catalog.filter((tool) => granted.has(tool.key))
    : catalog;
  const tool = availableTools.find((candidate) => candidate.key === toolId);
  const argumentRef = Array.isArray(execution.arguments)
    ? execution.arguments[0] as ContentRef | undefined
    : undefined;
  if (!argumentRef) throw new TypeError("Tool call arguments are missing.");
  const args = resolvedValue(await context.content.resolve(argumentRef));
  const streamRuntime = context.content.stream;
  const outcome = await executeTool({
    execution,
    tool,
    availableTools,
    arguments: args,
    context: toolContext,
    sourceEvent: event,
    idempotencyKey: context.operationKey ?? String(execution.id),
  }, {
    defaultTimeoutMs: options.toolExecutionTimeoutMs ??
      DEFAULT_TOOL_TIMEOUT_MS,
    timeoutsMs: options.toolExecutionTimeoutsMs,
    openStream: (input) => {
      if (!streamRuntime) {
        throw new Error("Runtime content stream is not configured.");
      }
      return streamRuntime.open({
        id: input.id,
        threadId: input.threadId,
        role: input.lane,
        mediaType: input.mediaType,
        participantId: input.participantId,
        metadata: input.metadata,
        routing: input.routing,
        visibility: input.visibility,
        correlationId: event.correlationId,
      });
    },
  });
  if (outcome.status === "completed") {
    const origin = {
      scope: { type: "thread" as const, id: recordThreadId(execution) },
      producer: { type: "tool_action", id: String(execution.id) },
    };
    const prepared = await context.content.prepare(
      valueContent(outcome.output, "tool.output"),
      { operationKey: "tool:output", origin },
    );
    const explicitAttachments = outcome.attachments
      ? await context.content.prepare(outcome.attachments, {
        operationKey: "tool:attachments",
        origin,
      })
      : undefined;
    const attachments = mergePreparedContent(
      outcome.extractedAttachments,
      explicitAttachments,
    );
    const output = await context.content.materialize(prepared, { origin });
    const durableAttachments = attachments
      ? await context.content.materialize(attachments, { origin })
      : undefined;
    return Object.freeze({
      id: String(execution.id),
      status: "completed" as const,
      output,
      projectedOutput: output,
      ...(durableAttachments ? { attachments: durableAttachments } : {}),
      historyVisibility: historyVisibilityOf(execution),
      durationMs: outcome.durationMs,
    });
  }
  if (outcome.status === "deferred") {
    return Object.freeze({
      id: String(execution.id),
      status: "deferred" as const,
      metadata: outcome.metadata,
      durationMs: outcome.durationMs,
    });
  }

  const message = outcome.status === "cancelled"
    ? outcome.reason
    : outcome.message;
  const error = new Error(message);
  error.name = outcome.status === "cancelled" ? "AbortError" : outcome.code;
  throw error;
}

async function executeBatch(
  input: unknown,
  context: FeatureExecuteContext,
): Promise<Readonly<Record<string, unknown>>> {
  const batch = asRecord(input);
  const items = Array.isArray(batch.items) ? batch.items : [];
  const call = context.feature(toolFeature).call;
  const outcomes = await Promise.all(items.map(async (item, index) => {
    const record = asRecord(item);
    try {
      const output = await call(record, {
        operationKey: `call:${String(record.id ?? index)}`,
        signal: context.signal,
      });
      return Object.freeze({
        id: String(record.id ?? index),
        status: "completed" as const,
        output,
      });
    } catch (caught) {
      const error = caught instanceof Error
        ? caught
        : new Error(String(caught));
      return Object.freeze({
        id: String(record.id ?? index),
        status: error.name === "AbortError"
          ? "cancelled" as const
          : "failed" as const,
        error: Object.freeze({ name: error.name, message: error.message }),
      });
    }
  }));
  return Object.freeze({
    batchId: String(batch.batchId ?? ""),
    outcomes: Object.freeze(outcomes),
  });
}

export const toolFeature: FeatureDefinition<
  Readonly<{
    call: FeatureAction<undefined, Readonly<Record<string, unknown>>>;
  }>
> = defineFeature({
  id: TOOL_FEATURE_ID,
  actions: { call: { execute: executeCall } },
});

export const toolBatchFeature: FeatureDefinition<
  Readonly<{
    execute: FeatureAction<undefined, Readonly<Record<string, unknown>>>;
  }>
> = defineFeature({
  id: TOOL_BATCH_FEATURE_ID,
  actions: { execute: { execute: executeBatch } },
});
