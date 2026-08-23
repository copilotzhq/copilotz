import type { CollectionRecord } from "@copilotz/copilotz/collections";
import type {
  ContentInput,
  ContentRef,
  ContentSequence,
} from "@copilotz/copilotz/content";
import type { EventVisibility } from "@copilotz/copilotz/events";
import {
  agentAskMetadata,
  deriveWorkflowId,
  withAgentAskMetadata,
  withWorkflowMetadata,
  type WorkflowMetadata,
  workflowMetadata,
} from "@copilotz/copilotz/events";
import { defineProcessor, type Processor } from "@copilotz/copilotz/plugins";
import type { CreateTextWorkflowPluginOptions } from "@copilotz/copilotz/llm";
import type { Agent } from "@copilotz/copilotz/resources";
import {
  advanceWorkflowPipeline,
  evaluateJq as defaultEvaluateJq,
  type WorkflowJqEvaluator,
} from "@copilotz/copilotz/tools";
import {
  coreAgent,
  type CoreProcessorContext,
  coreWorkflowContext,
} from "../../context.ts";
import {
  asRecord,
  historyVisibilityOf,
  optionalText,
  recordThreadId,
  requiredText,
  resolvedValue,
  stringArray,
  toolCatalogFor,
  toolField,
  valueContent,
} from "./helpers.ts";

function jqFor(
  _context: CoreProcessorContext,
  agent?: Agent,
): WorkflowJqEvaluator {
  const extra = agent as
    | Agent & Partial<CreateTextWorkflowPluginOptions>
    | undefined;
  return extra?.evaluateJq ?? defaultEvaluateJq;
}

function resultVisibility(execution: CollectionRecord): EventVisibility {
  const historyVisibility = optionalText(execution.historyVisibility);
  const policy = historyVisibility === "requester_only" ||
      historyVisibility === "public"
    ? historyVisibility
    : "public_status";
  const participantId = optionalText(execution.participantId);
  return participantId
    ? { kind: "tool" as const, policy, requesterId: participantId }
    : { kind: "internal" as const };
}

function resultContent(
  execution: CollectionRecord,
  override?: ContentSequence,
): ContentSequence | ContentInput {
  if (override) return override;
  const projected = Array.isArray(execution.projectedOutput)
    ? execution.projectedOutput as ContentSequence
    : undefined;
  const output = Array.isArray(execution.output)
    ? execution.output as ContentSequence
    : undefined;
  const attachments = Array.isArray(execution.attachments)
    ? execution.attachments as ContentSequence
    : [];
  const selected = projected ?? output ?? [];
  if (selected.length || attachments.length) {
    return Object.freeze([
      ...selected,
      ...attachments,
    ]);
  }
  const error = asRecord(execution.safeError);
  const failed = String(execution.status) === "failed" ||
    String(execution.status) === "cancelled";
  return {
    type: "text",
    text: failed
      ? optionalText(error.message) ?? "Tool execution failed."
      : "No output returned",
    role: "tool.projected_output",
  };
}

async function executionOutput(
  context: CoreProcessorContext,
  execution: CollectionRecord,
): Promise<unknown> {
  const sequence = Array.isArray(execution.projectedOutput)
    ? execution.projectedOutput as readonly ContentRef[]
    : Array.isArray(execution.output)
    ? execution.output as readonly ContentRef[]
    : [];
  const selected = sequence[0];
  return selected
    ? resolvedValue(await context.content.resolve(selected))
    : undefined;
}

async function projectExecution(
  event: Parameters<Processor<CoreProcessorContext>["handle"]>[0],
  context: CoreProcessorContext,
  initial: CollectionRecord,
  continueAfter: boolean,
) {
  let execution = initial;
  const workflowContext = coreWorkflowContext(context);
  if (String(execution.status) === "running") return;
  let metadata = workflowMetadata(execution.metadata);
  if (metadata?.kind === "memory_consolidation") return;
  const agent = optionalText(execution.agentId)
    ? coreAgent(context.resources, optionalText(execution.agentId)!)
    : undefined;
  const toolCatalog = toolCatalogFor(agent);
  const evaluateJq = jqFor(context, agent);
  let projectedStatus = String(execution.status);
  let projectedContent: ContentSequence | undefined;

  if (
    metadata?.pipeline && String(execution.status) === "completed" &&
    metadata.pipeline.stageIndex < metadata.pipeline.stages.length - 1
  ) {
    const advancement = await advanceWorkflowPipeline({
      pipeline: metadata.pipeline,
      output: await executionOutput(context, execution),
      upstreamToolExecutionId: execution.id,
      evaluateJq,
    });
    if (advancement.kind === "next_tool") {
      let availableTools = agent
        ? await toolCatalog.forAgent(workflowContext, agent)
        : await toolCatalog.all(workflowContext);
      const granted = new Set(stringArray(execution.availableToolIds));
      if (granted.size) {
        availableTools = availableTools.filter((tool) => granted.has(tool.key));
      }
      const nextTool = availableTools.find((candidate) =>
        candidate.key === advancement.stage.tool.id
      );
      const preparedArguments = await context.content.prepare(
        valueContent(advancement.arguments, "tool.arguments"),
        {
          operationKey:
            `pipeline:${advancement.pipeline.id}:${advancement.stageIndex}:arguments`,
        },
      );
      const argumentsContent = await context.content.materialize(
        preparedArguments,
      );
      const { toolExecutionId: _completedToolExecutionId, ...workflow } =
        metadata;
      const nextWorkflow: WorkflowMetadata = {
        ...workflow,
        kind: "tool_action",
        toolCallId: advancement.stage.id,
        pipeline: advancement.pipeline,
      };
      const activeAsk = agentAskMetadata(execution.metadata);
      const nextMetadata = withWorkflowMetadata(
        activeAsk ? withAgentAskMetadata(undefined, activeAsk) : undefined,
        nextWorkflow,
      );
      const parentAttemptId = metadata.parentLlmAttemptId ??
        metadata.llmAttemptId ?? "pipeline";
      const nextId = await deriveWorkflowId(
        "tool",
        parentAttemptId,
        "pipeline",
        advancement.pipeline.id,
        String(advancement.stageIndex),
      );
      await context.actions.executeToolBatch({
        batchId: nextId,
        items: [{
          id: nextId,
          namespace: context.namespace,
          threadId: recordThreadId(execution),
          messageId: optionalText(execution.messageId),
          participantId: optionalText(execution.participantId),
          agentId: optionalText(execution.agentId),
          toolCallId: advancement.stage.id,
          invocation: structuredClone(execution.invocation),
          tool: {
            id: advancement.stage.tool.id,
            name: nextTool?.name ?? advancement.stage.tool.name ??
              advancement.stage.tool.id,
          },
          arguments: argumentsContent,
          availableToolIds: stringArray(execution.availableToolIds),
          status: "running",
          content: [],
          startedAt: event.createdAt,
          createdAt: event.createdAt,
          updatedAt: event.createdAt,
          historyVisibility: nextTool?.historyPolicy?.visibility ??
            historyVisibilityOf(execution),
          metadata: nextMetadata,
          sourceEvent: event,
        }],
      }, {
        operationKey:
          `pipeline:${advancement.pipeline.id}:${advancement.stageIndex}:call`,
        signal: context.signal,
      });
      return;
    }

    if (advancement.kind === "settled" && advancement.projected) {
      const prepared = await context.content.prepare(
        valueContent(advancement.output, "tool.projected_output"),
        {
          operationKey: `pipeline:${metadata.pipeline.id}:final-projection`,
        },
      );
      projectedContent = await context.content.materialize(prepared);
      execution = {
        ...execution,
        projectedOutput: projectedContent,
      } as CollectionRecord;
    }

    if (advancement.kind === "failed") {
      projectedStatus = "failed";
      const prepared = await context.content.prepare({
        type: "json",
        value: {
          ok: false,
          status: "failed",
          code: "pipeline_error",
          error: advancement.message,
        },
        role: "tool.projected_output",
      }, {
        operationKey: `pipeline:${metadata.pipeline.id}:failure-projection`,
      });
      projectedContent = await context.content.materialize(prepared);
      const failedWorkflow: WorkflowMetadata = {
        ...metadata,
        pipelineFailure: {
          stageIndex: advancement.stageIndex,
          message: advancement.message,
        },
      };
      execution = {
        ...execution,
        projectedOutput: projectedContent,
        metadata: withWorkflowMetadata(undefined, failedWorkflow),
      } as CollectionRecord;
      metadata = failedWorkflow;
    }
  }

  const recipientId = optionalText(execution.participantId) ??
    metadata?.agentParticipantId;
  if (!recipientId) {
    throw new Error(`Tool execution '${execution.id}' has no requester.`);
  }
  const toolId = requiredText(
    typeof toolField(execution, "id") === "string"
      ? toolField(execution, "id") as string
      : undefined,
    "Tool execution tool id",
  );
  const activeAsk = agentAskMetadata(execution.metadata);
  const resultBaseMetadata = activeAsk
    ? withAgentAskMetadata({
      historyVisibility: historyVisibilityOf(execution),
      requesterId: recipientId,
      toolStatus: projectedStatus,
      toolId,
      toolInvocation: structuredClone(execution.invocation),
    }, activeAsk)
    : {
      historyVisibility: historyVisibilityOf(execution),
      requesterId: recipientId,
      toolStatus: projectedStatus,
      toolId,
      toolInvocation: structuredClone(execution.invocation),
    };
  const messageMetadata = withWorkflowMetadata(resultBaseMetadata, {
    kind: "tool_result",
    continuation: continueAfter ? metadata?.continuation : "none",
    realtimeStreamId: metadata?.realtimeStreamId,
    llmAttemptId: metadata?.llmAttemptId,
    parentLlmAttemptId: metadata?.parentLlmAttemptId ??
      metadata?.llmAttemptId,
    toolExecutionId: execution.id,
    toolCallId: optionalText(asRecord(execution.invocation).id) ??
      metadata?.pipeline?.rootToolCallId ??
      optionalText(execution.toolCallId),
    batchId: metadata?.batchId ?? execution.id,
    batchSize: metadata?.batchSize ?? 1,
    batchIndex: metadata?.batchIndex ?? 0,
    sourceMessageId: metadata?.sourceMessageId,
    agentParticipantId: recipientId,
    ...(metadata?.pipeline ? { pipeline: metadata.pipeline } : {}),
    ...(metadata?.pipelineFailure
      ? { pipelineFailure: metadata.pipelineFailure }
      : {}),
  });
  await context.actions.createThreadMessage({
    id: await deriveWorkflowId("message", execution.id, "result"),
    threadId: recordThreadId(execution),
    sender: {
      externalId: `tool:${toolId}`,
      participantType: "tool",
      name: typeof toolField(execution, "name") === "string"
        ? toolField(execution, "name") as string
        : toolId,
    },
    recipientIds: [recipientId],
    content: resultContent(execution, projectedContent),
    visibility: resultVisibility(execution),
    metadata: messageMetadata,
  }, {
    operationKey: `project:tool-result:message:${execution.id}`,
  });
}

export const projectToolResultProcessor: Processor<CoreProcessorContext> =
  defineProcessor<CoreProcessorContext>({
    id: "copilotz.core.project-tool-result",
    on: [{ eventType: "copilotz.core.tool-batch.execute.completed" }],
    async handle(event, context) {
      const lifecycle = asRecord(event.data);
      const input = asRecord(lifecycle.input);
      const output = asRecord(lifecycle.output);
      const items = Array.isArray(input.items) ? input.items.map(asRecord) : [];
      const outcomes = Array.isArray(output.outcomes)
        ? output.outcomes.map(asRecord)
        : [];
      const itemsById = new Map(items.map((item) => [String(item.id), item]));
      const projectable = outcomes.filter((outcome) =>
        asRecord(outcome.output).status !== "deferred"
      );
      for (const [index, outcome] of projectable.entries()) {
        const original = itemsById.get(String(outcome.id));
        if (!original) continue;
        const result = asRecord(outcome.output);
        const execution = {
          ...original,
          ...result,
          status: outcome.status === "completed"
            ? result.status ?? "completed"
            : outcome.status,
          ...(outcome.error ? { safeError: outcome.error } : {}),
        } as unknown as CollectionRecord;
        await projectExecution(
          event,
          context,
          execution,
          index === projectable.length - 1,
        );
      }
    },
  });
