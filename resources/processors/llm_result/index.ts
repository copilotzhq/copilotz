import type {
  Event,
  EventProcessor,
  LlmResultEventPayload,
  MessagePayload,
  NewEvent,
  ProcessorDeps,
} from "@/types/index.ts";
import { EVENT_PRIORITIES } from "@/runtime/event-priority.ts";

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

    const errorAnswer = payload.status === "failed"
      ? payload.answer ??
        "O modelo ficou temporariamente indisponível. Tente novamente em alguns instantes."
      : "";

    const newMessagePayload: MessagePayload = {
      content: payload.status === "failed" ? errorAnswer : payload.answer ?? "",
      sender: {
        id: payload.agent.id ?? undefined,
        type: "agent",
        name: payload.agent.name,
      },
      ...(Array.isArray(payload.toolCalls)
        ? { toolCalls: payload.toolCalls }
        : {}),
      ...(payload.reasoning ? { reasoning: payload.reasoning } : {}),
    };

    const metadata: Record<string, unknown> = {
      ...(event.metadata && typeof event.metadata === "object" &&
          !Array.isArray(event.metadata)
        ? event.metadata as Record<string, unknown>
        : {}),
      ...(payload.usageNodeId ? { usageNodeId: payload.usageNodeId } : {}),
      ...(payload.status === "failed" && payload.error
        ? { llmError: payload.error }
        : {}),
    };

    const producedEvents: NewEvent[] = [{
      threadId,
      type: "NEW_MESSAGE",
      payload: newMessagePayload,
      parentEventId: typeof event.id === "string" ? event.id : undefined,
      traceId: typeof event.traceId === "string" ? event.traceId : undefined,
      priority: EVENT_PRIORITIES.SETTLEMENT,
      metadata,
    }];

    return { producedEvents };
  },
};

export const { shouldProcess, process } = llmResultProcessor;
