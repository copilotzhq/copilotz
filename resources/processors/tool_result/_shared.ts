import type {
  Event,
  EventProcessor,
  MessagePayload,
  NewEvent,
  ProcessorDeps,
  ToolResultEventPayload,
} from "@/types/index.ts";
import { EVENT_PRIORITIES } from "@/runtime/event-priority.ts";
import {
  detectNewerHumanInputSupersession,
  withSupersededSkipRoutingMetadata,
} from "@/runtime/event-supersession.ts";
import { evaluateJq } from "@/runtime/tools/jq.ts";
import {
  isToolPipelineStage,
  mergePipelineArguments,
  parsePipelineMetadata,
  TOOL_PIPELINE_METADATA_KEY,
} from "@/runtime/tools/pipeline.ts";

export type TOOLResultPayload = ToolResultEventPayload;

function normalizeToolStatus(status: ToolResultEventPayload["status"]) {
  return status === "cancelled" ? "failed" : status;
}

function buildFailureOutput(payload: ToolResultEventPayload) {
  if (typeof payload.output !== "undefined") return payload.output;
  if (typeof payload.error === "undefined") return undefined;
  return {
    ok: false,
    status: normalizeToolStatus(payload.status),
    error: payload.error,
  };
}

function toolResultContent(output: unknown): string {
  if (typeof output === "string") return output;
  if (typeof output === "undefined") return "No output returned";
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

export const toolResultProcessor: EventProcessor<
  TOOLResultPayload,
  ProcessorDeps
> = {
  shouldProcess: () => true,
  process: async (event: Event, deps: ProcessorDeps) => {
    const eventType = (event as unknown as { type?: string }).type;
    const isLifecycleToolResult = eventType === "tool_execution.completed" ||
      eventType === "tool_execution.failed";
    let payload = event.payload as ToolResultEventPayload;
    const threadId = typeof event.threadId === "string"
      ? event.threadId
      : (() => {
        throw new Error("Invalid thread id for tool result event");
      })();
    const parentEventId = typeof event.parentEventId === "string"
      ? event.parentEventId
      : null;
    const superseded = parentEventId
      ? await detectNewerHumanInputSupersession(
        deps.db.ops,
        threadId,
        parentEventId,
        deps.context.namespace,
      )
      : null;

    const toolResultQueueEventId = typeof event.id === "string"
      ? event.id
      : undefined;
    const eventMetadata =
      event.metadata && typeof event.metadata === "object" &&
        !Array.isArray(event.metadata)
        ? event.metadata as Record<string, unknown>
        : {};
    const toolExecutionId = typeof eventMetadata.toolExecutionId === "string"
      ? eventMetadata.toolExecutionId
      : undefined;
    let output = buildFailureOutput(payload);
    const pipeline = parsePipelineMetadata(
      eventMetadata[TOOL_PIPELINE_METADATA_KEY],
    );

    if (
      !superseded && pipeline && payload.status === "completed" &&
      pipeline.stageIndex < pipeline.stages.length - 1
    ) {
      let transformedOutput = payload.output;
      let nextStageIndex = pipeline.stageIndex + 1;
      const appliedJqStageIndexes: number[] = [];
      try {
        while (
          nextStageIndex < pipeline.stages.length &&
          pipeline.stages[nextStageIndex]?.type === "jq"
        ) {
          const jqStage = pipeline.stages[nextStageIndex];
          if (jqStage.type !== "jq") break;
          transformedOutput = await evaluateJq(
            transformedOutput,
            jqStage.filter,
          );
          appliedJqStageIndexes.push(nextStageIndex);
          nextStageIndex += 1;
        }

        if (nextStageIndex < pipeline.stages.length) {
          const nextStage = pipeline.stages[nextStageIndex];
          if (!isToolPipelineStage(nextStage)) {
            throw new Error("Pipeline expected a tool stage.");
          }
          let explicitArguments: Record<string, unknown>;
          try {
            const parsed = JSON.parse(nextStage.args);
            if (
              !parsed || typeof parsed !== "object" || Array.isArray(parsed)
            ) {
              throw new Error("arguments must be an object");
            }
            explicitArguments = parsed as Record<string, unknown>;
          } catch (error) {
            throw new Error(
              `Invalid downstream tool arguments: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
          const mergedArguments = mergePipelineArguments(
            transformedOutput,
            explicitArguments,
          );
          const nextArgs = JSON.stringify(mergedArguments);
          const nextPipeline = {
            ...pipeline,
            stageIndex: nextStageIndex,
            ...(toolExecutionId
              ? { upstreamToolExecutionId: toolExecutionId }
              : {}),
            ...(appliedJqStageIndexes.length > 0
              ? { appliedJqStageIndexes }
              : {}),
          };
          const { toolExecutionId: _previousExecutionId, ...baseMetadata } =
            eventMetadata;
          const nextMetadata = {
            ...baseMetadata,
            [TOOL_PIPELINE_METADATA_KEY]: nextPipeline,
          };
          const nextCall = {
            id: nextStage.id,
            tool: nextStage.tool,
            args: nextArgs,
            batchId: payload.batchId ?? null,
            batchSize: payload.batchSize ?? null,
            batchIndex: payload.batchIndex ?? null,
          };
          const nextPayload = {
            agent: payload.agent,
            senderId: payload.agent.id ?? payload.agent.name,
            senderType: "agent" as const,
            toolCall: nextCall,
          };
          const sourceMessageId = typeof eventMetadata.sourceMessageId ===
              "string"
            ? eventMetadata.sourceMessageId
            : null;

          if (isLifecycleToolResult && deps.db?.ops?.mutate?.toolExecutions) {
            const nextExecutionId = `pipeline:${pipeline.id}:${nextStageIndex}`;
            if (
              typeof deps.db.ops.getNodeById === "function" &&
              await deps.db.ops.getNodeById(nextExecutionId)
            ) {
              return { producedEvents: [] };
            }
            await deps.db.ops.mutate.toolExecutions.create({
              id: nextExecutionId,
              threadId,
              messageId: sourceMessageId,
              eventId: typeof event.id === "string" ? event.id : null,
              agentId: payload.agent.id ?? payload.agent.name,
              agentName: payload.agent.name,
              toolCallId: nextStage.id,
              tool: nextStage.tool,
              args: nextArgs,
              status: "processing",
              metadata: nextMetadata,
              namespace: deps.context.namespace,
            }, {
              traceId: typeof event.traceId === "string" ? event.traceId : null,
              causationId: typeof event.id === "string" ? event.id : null,
              priority: EVENT_PRIORITIES.SETTLEMENT,
              status: "pending",
              metadata: nextMetadata,
              eventPayload: nextPayload,
            });
            return { producedEvents: [] };
          }

          return {
            producedEvents: [{
              threadId,
              type: "TOOL_CALL",
              payload: nextPayload,
              parentEventId: typeof event.id === "string"
                ? event.id
                : undefined,
              traceId: typeof event.traceId === "string"
                ? event.traceId
                : undefined,
              priority: EVENT_PRIORITIES.SETTLEMENT,
              metadata: nextMetadata,
            } as NewEvent],
          };
        }

        // The pipeline ended with jq. Keep the raw execution output and store
        // the transformed value in the existing projection slot.
        if (toolExecutionId && deps.db?.ops?.mutate?.toolExecutions) {
          await deps.db.ops.mutate.toolExecutions.update(toolExecutionId, {
            projectedOutput: transformedOutput,
          });
        }
        payload = {
          ...payload,
          output: transformedOutput,
          content: toolResultContent(transformedOutput),
        };
        output = transformedOutput;
      } catch (error) {
        const message = `PIPELINE ERROR: ${
          error instanceof Error ? error.message : String(error)
        }`;
        if (toolExecutionId && deps.db?.ops?.mutate?.toolExecutions) {
          await deps.db.ops.mutate.toolExecutions.update(toolExecutionId, {
            metadata: {
              ...eventMetadata,
              pipelineFailure: {
                stageIndex: nextStageIndex,
                error: message,
              },
            },
          });
        }
        payload = {
          ...payload,
          status: "failed",
          error: message,
          content: `tool error: ${message}`,
        };
        delete (payload as { output?: unknown }).output;
        output = buildFailureOutput(payload);
      }
    }

    // A pipeline is one assistant request even though its durable stages have
    // distinct execution IDs. Settle the final message against the root ID so
    // provider transcript validation sees one complete tool cycle.
    if (pipeline?.rootToolCallId) {
      payload = { ...payload, toolCallId: pipeline.rootToolCallId };
    }

    const newMessagePayload: MessagePayload = {
      content: payload.content ?? "",
      sender: {
        type: "tool",
        id: payload.agent.id ?? payload.agent.name,
        name: payload.agent.name,
      },
      metadata: {
        ...(toolResultQueueEventId ? { toolResultQueueEventId } : {}),
        ...(toolExecutionId ? { toolExecutionId } : {}),
        ...(pipeline ? { [TOOL_PIPELINE_METADATA_KEY]: pipeline } : {}),
        toolCalls: [
          {
            id: payload.toolCallId,
            tool: payload.tool,
            args: typeof payload.args === "string" || payload.args === null ||
                (payload.args && typeof payload.args === "object")
              ? payload.args as string | Record<string, unknown> | null
              : null,
            ...(typeof output !== "undefined" ? { output } : {}),
            ...(typeof payload.error !== "undefined"
              ? { error: payload.error }
              : {}),
            status: normalizeToolStatus(payload.status),
            ...(typeof payload.historyVisibility === "string"
              ? { visibility: payload.historyVisibility }
              : {}),
          },
        ],
        ...(payload.batchId ? { batchId: payload.batchId } : {}),
        ...(typeof payload.batchSize === "number"
          ? { batchSize: payload.batchSize }
          : {}),
        ...(typeof payload.batchIndex === "number"
          ? { batchIndex: payload.batchIndex }
          : {}),
      },
    };

    if (superseded) {
      newMessagePayload.metadata = withSupersededSkipRoutingMetadata(
        newMessagePayload.metadata,
        superseded,
      );
    }

    if (isLifecycleToolResult && deps.db?.ops?.mutate?.messages) {
      await deps.db.ops.mutate.messages.create(
        {
          threadId,
          senderId: payload.agent.id ?? payload.agent.name,
          senderType: "tool",
          content: typeof newMessagePayload.content === "string"
            ? newMessagePayload.content
            : "",
          metadata: newMessagePayload.metadata ?? null,
        },
        deps.context.namespace,
        {
          traceId: typeof event.traceId === "string" ? event.traceId : null,
          causationId: typeof event.id === "string" ? event.id : null,
          priority: EVENT_PRIORITIES.SETTLEMENT,
          status: "pending",
          metadata: event.metadata && typeof event.metadata === "object" &&
              !Array.isArray(event.metadata)
            ? event.metadata as Record<string, unknown>
            : null,
          eventPayload: newMessagePayload as unknown as Record<string, unknown>,
        },
      );
      return { producedEvents: [] };
    }

    const producedEvents: NewEvent[] = [{
      threadId,
      type: "NEW_MESSAGE",
      payload: newMessagePayload,
      parentEventId: typeof event.id === "string" ? event.id : undefined,
      traceId: typeof event.traceId === "string" ? event.traceId : undefined,
      priority: EVENT_PRIORITIES.SETTLEMENT,
      metadata: event.metadata,
    }];

    return { producedEvents };
  },
};

export const { shouldProcess, process } = toolResultProcessor;
