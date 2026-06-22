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

export const toolResultProcessor: EventProcessor<
  TOOLResultPayload,
  ProcessorDeps
> = {
  shouldProcess: () => true,
  process: async (event: Event, deps: ProcessorDeps) => {
    const payload = event.payload as ToolResultEventPayload;
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
    const output = buildFailureOutput(payload);

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
