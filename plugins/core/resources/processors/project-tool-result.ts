import type { CollectionRecord } from "@copilotz/copilotz/collections";
import type {
  ContentRef,
  ContentSequence,
  PreparedContent,
} from "@copilotz/copilotz/content";
import { toolExecutionContent } from "@copilotz/copilotz/content";
import type { EventVisibility } from "@copilotz/copilotz/events";
import {
  agentAskMetadata,
  deriveWorkflowId,
  type WorkflowMetadata,
  withAgentAskMetadata,
  withWorkflowMetadata,
  workflowMetadata,
} from "@copilotz/copilotz/events";
import type { CopilotzProcessorContext } from "@copilotz/copilotz/engine";
import { defineProcessor, type Processor } from "@copilotz/copilotz/plugins";
import type { CreateTextWorkflowPluginOptions } from "@copilotz/copilotz/llm";
import type { Agent } from "@copilotz/copilotz/resources";
import {
  advanceWorkflowPipeline,
  evaluateJq as defaultEvaluateJq,
  type WorkflowJqEvaluator,
} from "@copilotz/copilotz/tools";
import { threadMessageFeature } from "../features/thread-message.ts";
import { toolExecutionFeature } from "../features/tool-execution.ts";
import {
  asRecord,
  collectionEventRecord,
  historyVisibilityOf,
  optionalText,
  recordThreadId,
  requireCollection,
  requiredText,
  resolvedValue,
  stringArray,
  toolCatalogFor,
  toolField,
  valueContent,
} from "./helpers.ts";

function jqFor(
  _context: CopilotzProcessorContext,
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

async function resultContent(
  context: CopilotzProcessorContext,
  execution: CollectionRecord,
  override?: ContentSequence | PreparedContent,
): Promise<ContentSequence | PreparedContent> {
  if (override) return override;
  const content = toolExecutionContent(execution);
  const selected: ContentRef | undefined = content.projectedOutput ??
    content.output;
  if (selected || content.attachments.length > 0) {
    return Object.freeze([
      ...(selected ? [selected] : []),
      ...content.attachments,
    ]);
  }
  const error = asRecord(execution.safeError);
  return await context.content.prepare({
    type: "text",
    text: String(execution.status) === "failed"
      ? optionalText(error.message) ?? "Tool execution failed."
      : "No output returned",
    role: "tool.projected_output",
  }, { operationKey: "project:tool-result:fallback" });
}

async function executionOutput(
  context: CopilotzProcessorContext,
  execution: CollectionRecord,
): Promise<unknown> {
  const content = toolExecutionContent(execution);
  const selected = content.projectedOutput ?? content.output;
  return selected
    ? resolvedValue(await context.content.resolve(selected))
    : undefined;
}

export const projectToolResultProcessor: Processor<CopilotzProcessorContext> =
  defineProcessor<CopilotzProcessorContext>({
    id: "copilotz.core.project-tool-result",
    on: [
      {
        eventType: "tool_execution.updated",
        data: { record: { status: "completed" } },
      },
      {
        eventType: "tool_execution.updated",
        data: { record: { status: "failed" } },
      },
      {
        eventType: "tool_execution.updated",
        data: { record: { status: "cancelled" } },
      },
    ],
    requires: {
      features: {
        threadMessage: threadMessageFeature,
        toolExecution: toolExecutionFeature,
      },
    },
    async handle(event, context) {
      const record = collectionEventRecord(event);
      let execution = record;
      if (String(execution.status) === "running") return;
      let metadata = workflowMetadata(execution.metadata);
      if (metadata?.kind === "memory_consolidation") return;
      const agent = optionalText(execution.agentId)
        ? context.agents[optionalText(execution.agentId)!]
        : undefined;
      const toolCatalog = toolCatalogFor(context, agent);
      const evaluateJq = jqFor(context, agent);
      let projectedStatus = String(execution.status);
      let projectedContent: ContentSequence | PreparedContent | undefined;

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
            ? await toolCatalog.forAgent(context, agent)
            : await toolCatalog.all(context);
          const attemptId = metadata.parentLlmAttemptId ??
            metadata.llmAttemptId;
          if (attemptId) {
            const attemptRecord = await requireCollection(
              context,
              "llm_attempt",
            )
              .get({ id: attemptId });
            if (attemptRecord) {
              const attempt = attemptRecord;
              const granted = new Set(stringArray(attempt.availableToolIds));
              availableTools = availableTools.filter((tool) =>
                granted.has(tool.key)
              );
            }
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
          const { toolExecutionId: _completedToolExecutionId, ...workflow } =
            metadata;
          const nextWorkflow: WorkflowMetadata = {
            ...workflow,
            kind: "tool_execution",
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
          await context.features.toolExecution.create({
            id: await deriveWorkflowId(
              "tool",
              parentAttemptId,
              "pipeline",
              advancement.pipeline.id,
              String(advancement.stageIndex),
            ),
            threadId: recordThreadId(execution),
            messageId: optionalText(execution.messageId),
            participantId: optionalText(execution.participantId),
            agentId: optionalText(execution.agentId),
            toolCallId: advancement.stage.id,
            tool: {
              id: advancement.stage.tool.id,
              name: nextTool?.name ?? advancement.stage.tool.name ??
                advancement.stage.tool.id,
            },
            arguments: preparedArguments,
            status: "running",
            historyVisibility: nextTool?.historyPolicy?.visibility ??
              historyVisibilityOf(execution),
            metadata: nextMetadata,
          }, {
            operationKey:
              `pipeline:${advancement.pipeline.id}:${advancement.stageIndex}:create`,
          });
          return;
        }

        if (advancement.kind === "settled" && advancement.projected) {
          projectedContent = await context.content.prepare(
            valueContent(advancement.output, "tool.projected_output"),
            {
              operationKey: `pipeline:${metadata.pipeline.id}:final-projection`,
            },
          );
          const updated = await context.features.toolExecution.patch({
            id: execution.id,
            projectedOutput: projectedContent,
          }, {
            operationKey:
              `pipeline:${metadata.pipeline.id}:persist-final-projection`,
          }) as CollectionRecord;
          if (updated) execution = updated;
        }

        if (advancement.kind === "failed") {
          projectedStatus = "failed";
          projectedContent = await context.content.prepare({
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
          const failedWorkflow: WorkflowMetadata = {
            ...metadata,
            pipelineFailure: {
              stageIndex: advancement.stageIndex,
              message: advancement.message,
            },
          };
          const updated = await context.features.toolExecution.patch({
            id: execution.id,
            projectedOutput: projectedContent,
            metadataPatch: withWorkflowMetadata(undefined, failedWorkflow),
          }, {
            operationKey: `pipeline:${metadata.pipeline.id}:persist-failure`,
          }) as CollectionRecord;
          if (updated) execution = updated;
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
        }, activeAsk)
        : {
          historyVisibility: historyVisibilityOf(execution),
          requesterId: recipientId,
          toolStatus: projectedStatus,
          toolId,
        };
      const messageMetadata = withWorkflowMetadata(resultBaseMetadata, {
        kind: "tool_result",
        continuation: metadata?.continuation,
        realtimeStreamId: metadata?.realtimeStreamId,
        llmAttemptId: metadata?.llmAttemptId,
        parentLlmAttemptId: metadata?.parentLlmAttemptId ??
          metadata?.llmAttemptId,
        toolExecutionId: execution.id,
        toolCallId: metadata?.pipeline?.rootToolCallId ??
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
      await context.features.threadMessage.create({
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
        content: await resultContent(context, execution, projectedContent),
        visibility: resultVisibility(execution),
        metadata: messageMetadata,
      }, {
        operationKey: `project:tool-result:message:${execution.id}`,
      });
    },
  });
