import type { CopilotzEvent, DurableEventDraft } from "../events/types.ts";

export type ProcessorDelivery = "durable" | "live";

/** Determines whether durable work participates in its triggering scope. */
export type ProcessorSettlement = "inherit" | "detached";

export type ProcessorMatchEvent = DurableEventDraft | CopilotzEvent;

export type ProcessorContext = Record<string, unknown>;

/** Independent named event subscription. */
export type Processor<TContext extends ProcessorContext = ProcessorContext> = {
  id: string;
  on: readonly string[];
  delivery: ProcessorDelivery;
  /** Defaults to `inherit`. Detached work remains durable but non-blocking. */
  settlement?: ProcessorSettlement;
  filter?: (event: ProcessorMatchEvent) => boolean;
  handle(
    event: CopilotzEvent,
    context: TContext,
  ): void | Promise<void>;
};

/** Defines one independent event subscription. */
export function defineProcessor<
  TContext extends ProcessorContext = ProcessorContext,
>(
  processor: Processor<TContext>,
): Processor<TContext> {
  const id = processor.id?.trim();
  if (!id) throw new TypeError("Processor id is required.");
  if (!Array.isArray(processor.on) || processor.on.length === 0) {
    throw new TypeError(`Processor '${id}' requires at least one event type.`);
  }
  const on = [...new Set(processor.on.map((type) => type.trim()))];
  if (on.some((type) => !type)) {
    throw new TypeError(`Processor '${id}' contains an empty event type.`);
  }
  if (processor.delivery !== "durable" && processor.delivery !== "live") {
    throw new TypeError(`Processor '${id}' has an invalid delivery mode.`);
  }
  const settlement = processor.settlement ?? "inherit";
  if (settlement !== "inherit" && settlement !== "detached") {
    throw new TypeError(`Processor '${id}' has an invalid settlement mode.`);
  }
  if (processor.delivery === "live" && settlement === "detached") {
    throw new TypeError(
      `Live processor '${id}' cannot use detached durable settlement.`,
    );
  }
  if (typeof processor.handle !== "function") {
    throw new TypeError(`Processor '${id}' requires a handle function.`);
  }
  if (
    processor.filter !== undefined && typeof processor.filter !== "function"
  ) {
    throw new TypeError(`Processor '${id}' filter must be a function.`);
  }
  return Object.freeze({
    ...processor,
    id,
    on: Object.freeze(on),
    settlement,
  });
}

export function processorConsumerId(processorId: string): string {
  const id = processorId.trim();
  if (!id) throw new TypeError("Processor id is required.");
  return `processor:${id}`;
}

export function processorIdFromConsumer(
  consumerId: string,
): string | undefined {
  return consumerId.startsWith("processor:")
    ? consumerId.slice("processor:".length) || undefined
    : undefined;
}

export function isProcessor(value: unknown): value is Processor {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<Processor>;
  return typeof candidate.id === "string" && Array.isArray(candidate.on) &&
    (candidate.delivery === "durable" || candidate.delivery === "live") &&
    typeof candidate.handle === "function";
}
