import {
  type ContentRef,
  mergePreparedContent,
} from "@copilotz/copilotz/content";
import type { CollectionRecord } from "@copilotz/copilotz/collections";
import type { CopilotzEvent } from "@copilotz/copilotz/events";
import {
  type ActionCaller,
  type ActionDefinition,
  defineAction,
} from "@copilotz/copilotz/actions";
import {
  executeTool,
  type WorkflowToolHostContext,
} from "@copilotz/copilotz/tools";
import {
  type CoreActionContext,
  coreAgent,
  coreWorkflowContext,
} from "../../context.ts";
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
export const CALL_TOOL_ACTION_ID = "copilotz.core.tool.call";
export const EXECUTE_TOOL_BATCH_ACTION_ID = "copilotz.core.tool-batch.execute";

async function executeCall(
  input: unknown,
  context: CoreActionContext,
): Promise<Readonly<Record<string, unknown>>> {
  const execution = asRecord(input) as CollectionRecord;
  const event = asRecord(execution.sourceEvent) as unknown as CopilotzEvent;
  if (!event.type || !event.namespace || !event.correlationId) {
    throw new TypeError("Tool call requires a source Event.");
  }
  if (!context.signal) {
    throw new Error("Tool call requires a cancellable invocation context.");
  }
  const workflowContext = coreWorkflowContext(context);
  const toolContext = workflowContext as WorkflowToolHostContext;
  const agent = optionalText(execution.agentId)
    ? coreAgent(context.resources, optionalText(execution.agentId)!)
    : undefined;
  const toolCatalog = toolCatalogFor(agent);
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
      workflowContext,
      agent,
    )
    : await toolCatalog.all(workflowContext);
  const availableTools = granted.size
    ? catalog.filter((tool) => granted.has(tool.key))
    : catalog;
  const tool = availableTools.find((candidate) => candidate.key === toolId);
  const argumentRef = Array.isArray(execution.arguments)
    ? execution.arguments[0] as ContentRef | undefined
    : undefined;
  if (!argumentRef) throw new TypeError("Tool call arguments are missing.");
  const args = resolvedValue(await context.content.resolve(argumentRef));
  const streamRuntime = context.streams;
  const outcome = await executeTool({
    execution,
    tool,
    availableTools,
    arguments: args,
    context: toolContext,
    sourceEvent: event,
  }, {
    defaultTimeoutMs: options.toolExecutionTimeoutMs ??
      DEFAULT_TOOL_TIMEOUT_MS,
    timeoutsMs: options.toolExecutionTimeoutsMs,
    openStream: (input) => {
      if (!streamRuntime) {
        throw new Error("Runtime content stream is not configured.");
      }
      return streamRuntime.open({
        ...input,
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

export const callToolAction: ActionDefinition<
  unknown,
  Readonly<Record<string, unknown>>,
  CoreActionContext,
  undefined,
  undefined
> = defineAction({
  id: CALL_TOOL_ACTION_ID,
  execute: executeCall,
});

type ToolBatchActionContext =
  & Omit<CoreActionContext, "actions">
  & Readonly<{
    actions: Readonly<{
      callTool: ActionCaller<typeof callToolAction>;
    }>;
  }>;

async function executeBatch(
  input: unknown,
  context: ToolBatchActionContext,
): Promise<Readonly<Record<string, unknown>>> {
  const batch = asRecord(input);
  const items = Array.isArray(batch.items) ? batch.items : [];
  const call = context.actions.callTool;
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

export const executeToolBatchAction: ActionDefinition<
  unknown,
  Readonly<Record<string, unknown>>,
  ToolBatchActionContext,
  undefined,
  undefined
> = defineAction({
  id: EXECUTE_TOOL_BATCH_ACTION_ID,
  execute: executeBatch,
});
