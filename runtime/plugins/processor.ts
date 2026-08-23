import type {
  CopilotzEvent,
  EventRouting,
  EventSubject,
  EventVisibility,
} from "../events/types.ts";

/** Determines whether durable work participates in its triggering scope. */
export type ProcessorSettlement = "inherit" | "detached";

export type ProcessorContext = Record<string, unknown>;

/** One OR-entry. Fields inside the entry are AND. */
export type ProcessorMatchClause = Readonly<{
  eventType: string;
  namespace?: string;
  threadId?: string;
  subject?: Partial<EventSubject>;
  routing?: Partial<EventRouting>;
  visibility?: Partial<EventVisibility> | EventVisibility;
  metadata?: Readonly<Record<string, unknown>>;
  data?: unknown;
}>;

export type ProcessorEvent<TData = unknown> = CopilotzEvent & {
  data: TData;
};

declare const processorContextType: unique symbol;

/** Independent named event subscription. Plugin resources are static. */
export type Processor<TContext extends ProcessorContext = ProcessorContext> = {
  id: string;
  on: readonly ProcessorMatchClause[];
  /** Defaults to `inherit`. Detached work remains durable but non-blocking. */
  settlement?: ProcessorSettlement;
  /**
   * Carries the author's expected composed context through TypeScript without
   * creating runtime dependency metadata or filtering the injected context.
   */
  readonly [processorContextType]?: (context: TContext) => TContext;
  handle(
    event: ProcessorEvent,
    context: TContext,
  ): void | Promise<void>;
};

function requireClause(
  id: string,
  value: unknown,
  index: number,
): ProcessorMatchClause {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(
      `Processor '${id}' on[${index}] must be a matcher object.`,
    );
  }
  const clause = value as Record<string, unknown>;
  const eventType = typeof clause.eventType === "string"
    ? clause.eventType.trim()
    : "";
  if (!eventType) {
    throw new TypeError(
      `Processor '${id}' on[${index}] requires eventType.`,
    );
  }
  return Object.freeze({
    eventType,
    ...(clause.namespace === undefined ? {} : { namespace: clause.namespace }),
    ...(clause.threadId === undefined ? {} : { threadId: clause.threadId }),
    ...(clause.subject === undefined ? {} : { subject: clause.subject }),
    ...(clause.routing === undefined ? {} : { routing: clause.routing }),
    ...(clause.visibility === undefined
      ? {}
      : { visibility: clause.visibility }),
    ...(clause.metadata === undefined ? {} : { metadata: clause.metadata }),
    ...(clause.data === undefined ? {} : { data: clause.data }),
  }) as ProcessorMatchClause;
}

/** Defines one independent event subscription. */
export function defineProcessor<
  TContext extends ProcessorContext = ProcessorContext,
>(
  processor: Processor<TContext>,
): Processor<TContext> {
  const id = processor.id?.trim();
  if (!id) throw new TypeError("Processor id is required.");
  if (!Array.isArray(processor.on) || processor.on.length === 0) {
    throw new TypeError(`Processor '${id}' requires at least one matcher.`);
  }
  const on = Object.freeze(
    processor.on.map((clause, index) => requireClause(id, clause, index)),
  );
  const settlement = processor.settlement ?? "inherit";
  if (settlement !== "inherit" && settlement !== "detached") {
    throw new TypeError(`Processor '${id}' has an invalid settlement mode.`);
  }
  if (typeof processor.handle !== "function") {
    throw new TypeError(`Processor '${id}' requires a handle function.`);
  }
  return Object.freeze({
    ...processor,
    id,
    on,
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
    candidate.on.every((clause) =>
      Boolean(clause) && typeof clause === "object" &&
      typeof (clause as ProcessorMatchClause).eventType === "string"
    ) &&
    typeof candidate.handle === "function";
}

export function deepFreezeValue<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreezeValue(child);
    }
    Object.freeze(value);
  }
  return value;
}

export function withProcessorEventData<TData>(
  event: CopilotzEvent,
  data: TData,
): ProcessorEvent<TData> {
  return Object.freeze({
    ...event,
    data: deepFreezeValue(structuredClone(data)),
  }) as ProcessorEvent<TData>;
}
