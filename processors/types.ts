import type { ScopedCollectionsManager } from "@/database/collections/types.ts";
import type {
  CopilotzEvent,
  DurableEvent,
  EphemeralEvent,
  EventDelivery,
} from "@/events/types.ts";
import type { Agent, ToolExecutionContext } from "@/types/resources.ts";

export type ProcessorDelivery = "durable" | "live";

export interface ProcessorContext {
  readonly event: CopilotzEvent;
  readonly delivery?: EventDelivery;
  readonly namespace: string;
  readonly threadId?: string;
  readonly correlationId: string;
  /** Stable across at-least-once retries. */
  readonly idempotencyKey: string;
  readonly collections: ScopedCollectionsManager;
  readonly agents: readonly Agent[];
  readonly signal: AbortSignal;
  readonly tools: ToolExecutionContext["tools"];
  /** Emit a process-lifetime frame. Durable facts are created through collections. */
  emit(event: EphemeralEvent): void;
}

export interface Processor {
  readonly resourceType: "processors";
  readonly id: string;
  readonly on: readonly string[];
  readonly delivery: ProcessorDelivery;
  /** Must be synchronous and pure for durable subscriptions. */
  readonly filter?: (event: CopilotzEvent) => boolean;
  readonly handle: (
    event: CopilotzEvent,
    context: ProcessorContext,
  ) => void | Promise<void>;
}

export type ProcessorInput<TEvent extends CopilotzEvent = CopilotzEvent> =
  & Omit<
    Processor,
    "resourceType" | "filter" | "handle"
  >
  & {
    resourceType?: "processors";
    filter?: (event: TEvent) => boolean;
    handle: (
      event: TEvent,
      context: ProcessorContext,
    ) => void | Promise<void>;
  };

export function defineProcessor<TEvent extends CopilotzEvent = DurableEvent>(
  input: ProcessorInput<TEvent>,
): Processor {
  if (!input.id.trim()) throw new TypeError("Processor id is required.");
  if (!input.on.length) {
    throw new TypeError(`Processor '${input.id}' must subscribe to an event.`);
  }
  return Object.freeze({
    ...input,
    resourceType: "processors",
    filter: input.filter as Processor["filter"],
    handle: input.handle as Processor["handle"],
  });
}
