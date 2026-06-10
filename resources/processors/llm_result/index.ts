import type {
  Event,
  EventProcessor,
  LlmResultEventPayload,
  MessagePayload,
  NewEvent,
  ProcessorDeps,
} from "@/types/index.ts";
import { EVENT_PRIORITIES } from "@/runtime/event-priority.ts";
import {
  detectNewerHumanInputSupersession,
  withSupersededSkipRoutingMetadata,
} from "@/runtime/event-supersession.ts";

export type LLMResultPayload = LlmResultEventPayload;

export const llmResultProcessor: EventProcessor<
  LLMResultPayload,
  ProcessorDeps
> = {
  shouldProcess: () => true,
  process: async (event: Event, deps: ProcessorDeps) => {
    const payload = event.payload as LlmResultEventPayload;
    const threadId = typeof event.threadId === "string"
      ? event.threadId
      : (() => {
        throw new Error("Invalid thread id for LLM result event");
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
    const toolCalls = Array.isArray(payload.toolCalls) ? payload.toolCalls : [];

    if (superseded && toolCalls.length > 0) {
      return { producedEvents: [] };
    }

    const errorAnswer = payload.status === "failed"
      ? payload.answer ??
        "Model is temporarily unavailable. Please try again in a few moments."
      : "";

    const newMessagePayload: MessagePayload = {
      content: payload.status === "failed" ? errorAnswer : payload.answer ?? "",
      sender: {
        id: payload.agent.id ?? undefined,
        type: "agent",
        name: payload.agent.name,
      },
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      ...(payload.reasoning ? { reasoning: payload.reasoning } : {}),
      ...(superseded
        ? { metadata: withSupersededSkipRoutingMetadata(undefined, superseded) }
        : {}),
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
