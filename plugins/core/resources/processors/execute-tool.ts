import {
  mergePreparedContent,
  toolExecutionContent,
} from "@copilotz/copilotz/content";
import { workflowMetadata } from "@copilotz/copilotz/events";
import type { CopilotzProcessorContext } from "@copilotz/copilotz/engine";
import { defineProcessor, type Processor } from "@copilotz/copilotz/plugins";
import { executeTool } from "@copilotz/copilotz/tools";
import { threadMessageFeature } from "../features/thread-message.ts";
import { toolExecutionFeature } from "../features/tool-execution.ts";
import {
  collectionEventRecord,
  historyVisibilityOf,
  optionalText,
  policyOptions,
  recordThreadId,
  requireCollection,
  requiredText,
  resolvedValue,
  safeError,
  stringArray,
  toolCatalogFor,
  toolField,
  valueContent,
} from "./helpers.ts";

const DEFAULT_TOOL_TIMEOUT_MS = 300_000;

export const executeToolProcessor: Processor<CopilotzProcessorContext> =
  defineProcessor<CopilotzProcessorContext>({
    id: "copilotz.core.execute-tool",
    on: [{ eventType: "tool_execution.created" }],
    requires: {
      features: {
        threadMessage: threadMessageFeature,
        toolExecution: toolExecutionFeature,
      },
    },
    async handle(event, context) {
      const record = collectionEventRecord(event);
      const execution = record;
      if (String(execution.status) !== "running") return;
      const agent = optionalText(execution.agentId)
        ? context.agents[optionalText(execution.agentId)!]
        : undefined;
      const toolCatalog = toolCatalogFor(context, agent);
      const options = agent ? policyOptions(agent) : {};
      const toolId = requiredText(
        typeof toolField(execution, "id") === "string"
          ? toolField(execution, "id") as string
          : undefined,
        "Tool execution tool id",
      );
      let availableTools = agent
        ? await toolCatalog.forAgent(context, agent)
        : await toolCatalog.all(context);
      const workflow = workflowMetadata(execution.metadata);
      const attemptId = workflow?.parentLlmAttemptId ?? workflow?.llmAttemptId;
      if (attemptId) {
        const attemptRecord = await requireCollection(context, "llm_attempt")
          .get({ id: attemptId });
        if (attemptRecord) {
          const attempt = attemptRecord;
          const granted = new Set(stringArray(attempt.availableToolIds));
          availableTools = (await toolCatalog.all(context)).filter((
            tool,
          ) => granted.has(tool.key));
        }
      }
      const tool = availableTools.find((candidate) => candidate.key === toolId);
      const argumentRef = toolExecutionContent(execution).arguments;
      const args = resolvedValue(await context.content.resolve(argumentRef));
      const streamRuntime = context.content.stream;
      const outcome = await executeTool({
        execution,
        tool,
        availableTools,
        arguments: args,
        context,
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
          producer: { type: "tool_execution", id: execution.id },
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
        await context.features.toolExecution.complete({
          id: execution.id,
          output: prepared,
          projectedOutput: prepared,
          ...(attachments ? { attachments } : {}),
          historyVisibility: historyVisibilityOf(execution),
          durationMs: outcome.durationMs,
        }, {
          operationKey: "tool:complete",
        });
        return;
      }
      if (outcome.status === "deferred") return;

      const message = outcome.status === "cancelled"
        ? outcome.reason
        : outcome.message;
      const detail = await context.content.prepare({
        type: "text",
        text: message,
        role: "tool.error_detail",
      }, { operationKey: "tool:error-detail" });
      const projection = await context.content.prepare({
        type: "json",
        value: {
          ok: false,
          status: outcome.status,
          code: outcome.code,
          error: message,
        },
        role: "tool.projected_output",
      }, { operationKey: "tool:error-projection" });
      if (outcome.status === "cancelled") {
        await context.features.toolExecution.cancel({
          id: execution.id,
          reason: outcome.reason,
          errorDetail: detail,
          projectedOutput: projection,
          historyVisibility: historyVisibilityOf(execution),
          durationMs: outcome.durationMs,
        }, {
          operationKey: "tool:cancel",
        });
        return;
      }
      await context.features.toolExecution.fail({
        id: execution.id,
        safeError: safeError(
          outcome.code,
          "Tool execution failed.",
          outcome.error,
        ),
        errorDetail: detail,
        projectedOutput: projection,
        historyVisibility: historyVisibilityOf(execution),
        durationMs: outcome.durationMs,
      }, {
        operationKey: "tool:fail",
      });
    },
  });
