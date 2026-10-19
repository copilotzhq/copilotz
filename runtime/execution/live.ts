import { closeCollectionPolicyInvocation } from "../collections/policy-invocation.ts";
import { readViews } from "../collections/read-view.ts";
import type { CopilotzEvent } from "../events/index.ts";
import {
  hydrateProcessorEventContent,
  isProcessor,
  matchProcessor,
  type PluginRegistry,
  type Processor,
  type ProcessorContext,
  type ProcessorEvent,
  type TransientProcessorSet,
  withProcessorEventData,
} from "../plugins/index.ts";

export type LiveProcessorContextBase = Readonly<{
  databaseSchema: string;
  event: CopilotzEvent;
  signal: AbortSignal;
  processorId: string;
  dispatchAttemptId: string;
  idempotencyKey: string;
  settlementScopeId?: string;
  actionScopeId?: string;
  createMutationIdentity(
    operationKey: string,
    metadata?: Record<string, unknown>,
  ): LiveMutationIdentity;
}>;

export type LiveMutationIdentity = Readonly<{
  causationId?: string;
  correlationId: string;
  deduplicationId: string;
  settlementScopeId?: string;
  actionScopeId?: string;
  metadata: Readonly<Record<string, unknown>>;
}>;

export type LiveProcessorContextFactory = (
  base: LiveProcessorContextBase,
) => ProcessorContext | Promise<ProcessorContext>;

export type LiveProcessorEventResolver = (
  event: CopilotzEvent,
  databaseSchema: string,
) => Promise<ProcessorEvent>;

export type InvokeLiveProcessorsOptions = Readonly<{
  databaseSchema: string;
  registry: PluginRegistry;
  transients?: TransientProcessorSet;
  event: CopilotzEvent;
  /** Resolved durable Event Body; ephemeral events use their payload. */
  eventData?: unknown;
  /** Reused immutable view also published to application observers. */
  resolvedEvent?: ProcessorEvent;
  /** Resolves an Event for transport-hosted live processors. */
  resolveEvent?: LiveProcessorEventResolver;
  signal: AbortSignal;
  settlementScopeId?: string;
  actionScopeId?: string;
  createContext: LiveProcessorContextFactory;
  createDispatchAttemptId?: () => string;
}>;

function requiredText(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${name} must be non-empty.`);
  }
  return value.trim();
}

function lookupProcessor(
  options: Pick<InvokeLiveProcessorsOptions, "registry" | "transients">,
  processorId: string,
): Processor | undefined {
  return options.transients?.get(processorId) ??
    Object.values(options.registry.processors).find((processor) =>
      processor.id === processorId
    );
}

function matchingTransient(
  options: Pick<
    InvokeLiveProcessorsOptions,
    "transients" | "event" | "eventData" | "resolvedEvent"
  >,
): readonly Processor[] {
  return options.transients?.match(
    options.event,
    options.resolvedEvent?.data ?? options.eventData,
  ) ?? [];
}

function sourceEventId(event: CopilotzEvent): string | undefined {
  return event.durable ? event.id : event.causationId;
}

function mutationIdentity(
  event: CopilotzEvent,
  processorId: string,
  dispatchAttemptId: string,
  settlementScopeId?: string,
  actionScopeId?: string,
): LiveProcessorContextBase["createMutationIdentity"] {
  return (operationKey, metadata = {}) => {
    const key = requiredText(operationKey, "Live mutation operation key");
    const causationId = sourceEventId(event);
    return ({
      ...(causationId ? { causationId } : {}),
      correlationId: event.correlationId,
      deduplicationId: `live:${dispatchAttemptId}:${processorId}:${key}`,
      ...(settlementScopeId ? { settlementScopeId } : {}),
      ...(actionScopeId ? { actionScopeId } : {}),
      metadata: {
        ...structuredClone(metadata),
        ...(causationId ? { sourceEventId: causationId } : {}),
        sourceLiveDispatchId: dispatchAttemptId,
        sourceConsumerId: `processor:${processorId}`,
      } as const,
    } as const);
  };
}

/** One live processor call reads through a view of its own. */
function invokeOne(
  options: Omit<InvokeLiveProcessorsOptions, "createDispatchAttemptId">,
  processorId: string,
  dispatchAttemptId: string,
): Promise<void> {
  return readViews.run(() => runOne(options, processorId, dispatchAttemptId));
}

async function runOne(
  options: Omit<InvokeLiveProcessorsOptions, "createDispatchAttemptId">,
  processorId: string,
  dispatchAttemptId: string,
): Promise<void> {
  const processor = lookupProcessor(options, processorId);
  if (!isProcessor(processor)) {
    throw new Error(
      `Live processor '${processorId}' is unavailable or no longer matches.`,
    );
  }
  const base: LiveProcessorContextBase = {
    databaseSchema: options.databaseSchema,
    event: options.event,
    signal: options.signal,
    processorId,
    dispatchAttemptId,
    idempotencyKey: `live:${dispatchAttemptId}:${processorId}`,
    ...(options.actionScopeId ? { actionScopeId: options.actionScopeId } : {}),
    ...(options.settlementScopeId
      ? { settlementScopeId: options.settlementScopeId }
      : {}),
    createMutationIdentity: mutationIdentity(
      options.event,
      processorId,
      dispatchAttemptId,
      options.settlementScopeId,
      options.actionScopeId,
    ),
  } as const;
  const context = await options.createContext(base);
  options.signal.throwIfAborted();
  const processorEvent = options.resolvedEvent ??
    (options.resolveEvent
      ? await options.resolveEvent(options.event, options.databaseSchema)
      : withProcessorEventData(
        options.event,
        await hydrateProcessorEventContent(
          options.eventData === undefined
            ? options.event.payload
            : options.eventData,
          { getMany: (refs) => context.content.resolveMany(refs) },
          options.event.namespace,
        ),
      ));
  if (!matchProcessor(processor, options.event, processorEvent.data)) {
    throw new Error(
      `Live processor '${processorId}' is unavailable or no longer matches.`,
    );
  }
  try {
    await processor.handle(processorEvent, context);
    options.signal.throwIfAborted();
  } finally {
    closeCollectionPolicyInvocation(context);
  }
}

/** Invokes independent live subscriptions inside an already running worker. */
export async function invokeLiveProcessors(
  options: InvokeLiveProcessorsOptions,
): Promise<void> {
  const createId = options.createDispatchAttemptId ??
    (() => crypto.randomUUID());
  const processors = matchingTransient(options);
  const settled = await Promise.allSettled(
    processors.map((processor) => invokeOne(options, processor.id, createId())),
  );
  const failures = settled.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : []
  );
  if (failures.length) {
    throw new AggregateError(
      failures,
      `${failures.length} live processor(s) failed.`,
    );
  }
}

export type LiveEventDispatchHandle = Readonly<{
  event: CopilotzEvent;
  processorIds: readonly string[];
  done: Promise<void>;
  cancel(reason?: string): Promise<void>;
}>;
