import type {
  Event,
  EventProcessor,
  MessagePayload,
  NewEvent,
  ProcessorDeps,
  ToolResultEventPayload,
} from "@/types/index.ts";

export type TOOLResultPayload = ToolResultEventPayload;

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

    const newMessagePayload: MessagePayload = {
      content: payload.content ?? "",
      sender: {
        type: "tool",
        id: payload.agent.id ?? payload.agent.name,
        name: payload.agent.name,
      },
      metadata: {
        toolCalls: [
          {
            id: payload.toolCallId,
            tool: payload.tool,
            args: typeof payload.args === "string" || payload.args === null ||
                (payload.args && typeof payload.args === "object")
              ? payload.args as string | Record<string, unknown> | null
              : null,
            ...(typeof payload.output !== "undefined" ? { output: payload.output } : {}),
            status: payload.status === "cancelled" ? "failed" : payload.status,
            ...(typeof payload.historyVisibility === "string"
              ? { visibility: payload.historyVisibility }
              : {}),
            ...(typeof payload.projectedOutput !== "undefined"
              ? { projectedOutput: payload.projectedOutput }
              : {}),
          },
        ],
        ...(payload.batchId ? { batchId: payload.batchId } : {}),
        ...(typeof payload.batchSize === "number" ? { batchSize: payload.batchSize } : {}),
        ...(typeof payload.batchIndex === "number" ? { batchIndex: payload.batchIndex } : {}),
      },
    };

    const producedEvents: NewEvent[] = [{
      threadId,
      type: "NEW_MESSAGE",
      payload: newMessagePayload,
      parentEventId: typeof event.id === "string" ? event.id : undefined,
      traceId: typeof event.traceId === "string" ? event.traceId : undefined,
      priority: typeof event.priority === "number" ? event.priority : undefined,
      metadata: event.metadata,
    }];

    return { producedEvents };
  },
};

export const { shouldProcess, process } = toolResultProcessor;
