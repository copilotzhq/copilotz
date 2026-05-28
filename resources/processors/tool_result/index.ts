import type {
  Event,
  EventProcessor,
  MessagePayload,
  NewEvent,
  ProcessorDeps,
  ToolResultEventPayload,
} from "@/types/index.ts";
import { EVENT_PRIORITIES } from "@/runtime/event-priority.ts";

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
  process: async (event: Event, _deps: ProcessorDeps) => {
    const payload = event.payload as ToolResultEventPayload;
    const threadId = typeof event.threadId === "string"
      ? event.threadId
      : (() => {
        throw new Error("Invalid thread id for tool result event");
      })();

    const toolResultQueueEventId = typeof event.id === "string"
      ? event.id
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
