import type {
  Event,
  EventProcessor,
  MessagePayload,
  NewEvent,
  ProcessorDeps,
  LlmResultEventPayload,
} from "@/types/index.ts";

export type LLMResultPayload = LlmResultEventPayload;

export const llmResultProcessor: EventProcessor<
  LLMResultPayload,
  ProcessorDeps
> = {
  shouldProcess: () => true,
  process: async (event: Event, _deps: ProcessorDeps) => {
    const payload = event.payload as LlmResultEventPayload;
    const threadId = typeof event.threadId === "string"
      ? event.threadId
      : (() => {
        throw new Error("Invalid thread id for LLM result event");
      })();

    const newMessagePayload: MessagePayload = {
      content: payload.answer ?? "",
      sender: {
        id: payload.agent.id ?? undefined,
        type: "agent",
        name: payload.agent.name,
      },
      ...(Array.isArray(payload.toolCalls) ? { toolCalls: payload.toolCalls } : {}),
      ...(payload.reasoning ? { reasoning: payload.reasoning } : {}),
    };

    const metadata: Record<string, unknown> = {
      ...(event.metadata && typeof event.metadata === "object" && !Array.isArray(event.metadata)
        ? event.metadata as Record<string, unknown>
        : {}),
      ...(payload.usageNodeId ? { usageNodeId: payload.usageNodeId } : {}),
    };

    const producedEvents: NewEvent[] = [{
      threadId,
      type: "NEW_MESSAGE",
      payload: newMessagePayload,
      parentEventId: typeof event.id === "string" ? event.id : undefined,
      traceId: typeof event.traceId === "string" ? event.traceId : undefined,
      priority: typeof event.priority === "number" ? event.priority : undefined,
      metadata,
    }];

    return { producedEvents };
  },
};

export const { shouldProcess, process } = llmResultProcessor;
