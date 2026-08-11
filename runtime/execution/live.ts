import type { CopilotzEvent } from "../events/index.ts";
import {
  isProcessor,
  type PluginRegistry,
  type ProcessorContext,
} from "../plugins/index.ts";
import type { DeliveryExecutor, DeliveryWorkload } from "./types.ts";

export const COPILOTZ_LIVE_WORKLOAD = "copilotz.live.v1";

export type LiveDispatchMetadata = Readonly<{
  schema: "copilotz.live.dispatch.v1";
  processorId: string;
  namespace: string;
  eventType: string;
  correlationId: string;
  dispatchAttemptId: string;
  idempotencyKey: string;
}>;

export type LiveProcessorContextBase = Readonly<{
  event: CopilotzEvent;
  signal: AbortSignal;
  processorId: string;
  dispatchAttemptId: string;
  idempotencyKey: string;
  createMutationIdentity(
    operationKey: string,
    metadata?: Record<string, unknown>,
  ): LiveMutationIdentity;
}>;

export type LiveMutationIdentity = Readonly<{
  causationId?: string;
  correlationId: string;
  deduplicationId: string;
  metadata: Readonly<Record<string, unknown>>;
}>;

export type LiveProcessorContextFactory = (
  base: LiveProcessorContextBase,
) => ProcessorContext | void | Promise<ProcessorContext | void>;

export type CreateLiveProcessorWorkloadOptions = Readonly<{
  registry: PluginRegistry;
  createContext?: LiveProcessorContextFactory;
  maxEventBytes?: number;
}>;

export type InvokeLiveProcessorsOptions = Readonly<{
  registry: PluginRegistry;
  event: CopilotzEvent;
  signal: AbortSignal;
  createContext?: LiveProcessorContextFactory;
  createDispatchAttemptId?: () => string;
}>;

export type LiveEventDispatchHandle = Readonly<{
  event: CopilotzEvent;
  processorIds: readonly string[];
  done: Promise<void>;
  cancel(reason?: string): Promise<void>;
}>;

export type LiveEventDispatcher = Readonly<{
  workload: string;
  dispatch(event: CopilotzEvent): Promise<LiveEventDispatchHandle>;
}>;

export type CreateLiveEventDispatcherOptions = Readonly<{
  registry: PluginRegistry;
  executor: Pick<DeliveryExecutor, "dispatchWork">;
  workload?: string;
  createDispatchAttemptId?: () => string;
}>;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function requiredText(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${name} must be non-empty.`);
  }
  return value.trim();
}

function positiveBytes(value: number | undefined): number {
  const resolved = value ?? 1024 * 1024;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new TypeError("Live event byte limit must be positive.");
  }
  return resolved;
}

function parseMetadata(
  value: Readonly<Record<string, unknown>>,
): LiveDispatchMetadata {
  if (value.schema !== "copilotz.live.dispatch.v1") {
    throw new TypeError(
      `Unsupported live dispatch schema '${String(value.schema)}'.`,
    );
  }
  return Object.freeze({
    schema: "copilotz.live.dispatch.v1",
    processorId: requiredText(value.processorId, "Live processor ID"),
    namespace: requiredText(value.namespace, "Live namespace"),
    eventType: requiredText(value.eventType, "Live event type"),
    correlationId: requiredText(
      value.correlationId,
      "Live correlation ID",
    ),
    dispatchAttemptId: requiredText(
      value.dispatchAttemptId,
      "Live dispatch attempt ID",
    ),
    idempotencyKey: requiredText(
      value.idempotencyKey,
      "Live idempotency key",
    ),
  });
}

async function readBytes(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream) {
    total += chunk.byteLength;
    if (total > maxBytes) {
      throw new TypeError(
        `Live event exceeds the ${maxBytes}-byte dispatch limit.`,
      );
    }
    chunks.push(chunk);
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function parseEvent(bytes: Uint8Array): CopilotzEvent {
  const value = JSON.parse(decoder.decode(bytes)) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Live dispatch body must contain an event object.");
  }
  const event = value as Partial<CopilotzEvent>;
  if (
    typeof event.durable !== "boolean" ||
    typeof event.type !== "string" || !event.type.trim() ||
    typeof event.namespace !== "string" || !event.namespace.trim() ||
    typeof event.correlationId !== "string" || !event.correlationId.trim()
  ) {
    throw new TypeError("Live dispatch body contains an invalid event.");
  }
  return Object.freeze(value) as CopilotzEvent;
}

function encodedEvent(event: CopilotzEvent): Uint8Array {
  try {
    return encoder.encode(JSON.stringify(event));
  } catch (cause) {
    throw new TypeError(
      "Live processor events must be JSON-compatible.",
      { cause },
    );
  }
}

function isThenable(value: unknown): boolean {
  return Boolean(
    value && (typeof value === "object" || typeof value === "function") &&
      typeof (value as { then?: unknown }).then === "function",
  );
}

function processorMatches(
  processor: ReturnType<PluginRegistry["matchLive"]>[number],
  event: CopilotzEvent,
): boolean {
  if (processor.delivery !== "live" || !processor.on.includes(event.type)) {
    return false;
  }
  if (!processor.filter) return true;
  const accepted: unknown = processor.filter(event);
  if (isThenable(accepted)) {
    throw new TypeError(
      `Processor '${processor.id}' filter must be synchronous and pure.`,
    );
  }
  return accepted === true;
}

function sourceEventId(event: CopilotzEvent): string | undefined {
  return event.durable ? event.id : event.causationId;
}

function mutationIdentity(
  event: CopilotzEvent,
  processorId: string,
  dispatchAttemptId: string,
): LiveProcessorContextBase["createMutationIdentity"] {
  return (operationKey, metadata = {}) => {
    const key = requiredText(operationKey, "Live mutation operation key");
    const causationId = sourceEventId(event);
    return Object.freeze({
      ...(causationId ? { causationId } : {}),
      correlationId: event.correlationId,
      deduplicationId: `live:${dispatchAttemptId}:${processorId}:${key}`,
      metadata: Object.freeze({
        ...structuredClone(metadata),
        ...(causationId ? { sourceEventId: causationId } : {}),
        sourceLiveDispatchId: dispatchAttemptId,
        sourceConsumerId: `processor:${processorId}`,
      }),
    });
  };
}

async function invokeOne(
  options: Omit<InvokeLiveProcessorsOptions, "createDispatchAttemptId">,
  processorId: string,
  dispatchAttemptId: string,
): Promise<void> {
  const processor = options.registry.get("processors", processorId);
  if (!isProcessor(processor) || !processorMatches(processor, options.event)) {
    throw new Error(
      `Live processor '${processorId}' is unavailable or no longer matches.`,
    );
  }
  const base: LiveProcessorContextBase = Object.freeze({
    event: options.event,
    signal: options.signal,
    processorId,
    dispatchAttemptId,
    idempotencyKey: `live:${dispatchAttemptId}:${processorId}`,
    createMutationIdentity: mutationIdentity(
      options.event,
      processorId,
      dispatchAttemptId,
    ),
  });
  const extension = await options.createContext?.(base);
  const context = Object.freeze({ ...(extension ?? {}), ...base });
  options.signal.throwIfAborted();
  await processor.handle(options.event, context);
  options.signal.throwIfAborted();
}

/** Invokes independent live subscriptions inside an already running worker. */
export async function invokeLiveProcessors(
  options: InvokeLiveProcessorsOptions,
): Promise<void> {
  const createId = options.createDispatchAttemptId ??
    (() => crypto.randomUUID());
  const processors = options.registry.matchLive(options.event);
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

/** Creates the transport-neutral Oxian workload for one live subscription. */
export function createLiveProcessorWorkload(
  options: CreateLiveProcessorWorkloadOptions,
): DeliveryWorkload {
  const maxBytes = positiveBytes(options.maxEventBytes);
  return async ({ metadata: rawMetadata, input, signal }) => {
    const metadata = parseMetadata(rawMetadata);
    const event = parseEvent(await readBytes(input, maxBytes));
    if (
      event.namespace !== metadata.namespace ||
      event.type !== metadata.eventType ||
      event.correlationId !== metadata.correlationId
    ) {
      throw new TypeError("Live event dispatch scope does not match.");
    }
    await invokeOne(
      {
        registry: options.registry,
        event,
        signal,
        createContext: options.createContext,
      },
      metadata.processorId,
      metadata.dispatchAttemptId,
    );
    return {
      metadata: {
        schema: "copilotz.live.result.v1",
        processorId: metadata.processorId,
        status: "succeeded",
      },
    };
  };
}

function workloadName(value: string | undefined): string {
  return requiredText(value ?? COPILOTZ_LIVE_WORKLOAD, "Live workload");
}

/** Dispatches root live subscriptions through the configured Oxian target. */
export function createLiveEventDispatcher(
  options: CreateLiveEventDispatcherOptions,
): LiveEventDispatcher {
  const workload = workloadName(options.workload);
  const createId = options.createDispatchAttemptId ??
    (() => crypto.randomUUID());

  return Object.freeze({
    workload,
    async dispatch(event) {
      const processors = options.registry.matchLive(event);
      if (!processors.length) {
        return Object.freeze({
          event,
          processorIds: Object.freeze([]),
          done: Promise.resolve(),
          cancel: () => Promise.resolve(),
        });
      }
      const placements = await Promise.allSettled(
        processors.map((processor) => {
          const dispatchAttemptId = createId();
          const metadata: LiveDispatchMetadata = Object.freeze({
            schema: "copilotz.live.dispatch.v1",
            processorId: processor.id,
            namespace: event.namespace,
            eventType: event.type,
            correlationId: event.correlationId,
            dispatchAttemptId,
            idempotencyKey: `live:${dispatchAttemptId}:${processor.id}`,
          });
          return options.executor.dispatchWork({
            workload,
            metadata,
            body: encodedEvent(event),
          });
        }),
      );
      const work = placements.flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : []
      );
      const placementFailures = placements.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : []
      );
      if (placementFailures.length) {
        await Promise.all(
          work.map((item) =>
            item.cancel("live_placement_failed").catch(
              () => undefined,
            )
          ),
        );
        throw new AggregateError(
          placementFailures,
          `${placementFailures.length} live processor placement(s) failed.`,
        );
      }

      const output = work.map((item) =>
        item.output.pipeTo(new WritableStream<Uint8Array>())
      );
      output.forEach((promise) => promise.catch(() => undefined));
      work.forEach((item) => item.metadata.catch(() => undefined));
      const done = (async () => {
        const [terminalResults, outputResults] = await Promise.all([
          Promise.allSettled(work.map((item) => item.completed)),
          Promise.allSettled(output),
        ]);
        const terminals = terminalResults.map((result) =>
          result.status === "fulfilled" ? result.value : undefined
        );
        const failures: Error[] = terminalResults.flatMap((result) => {
          if (result.status === "rejected") {
            return [
              result.reason instanceof Error
                ? result.reason
                : new Error(String(result.reason)),
            ];
          }
          return result.value.status === "completed" ? [] : [
            new Error(
              result.value.terminal?.message ??
                `Live processor ended as '${result.value.status}'.`,
            ),
          ];
        });
        outputResults.forEach((result, index) => {
          if (
            result.status === "rejected" &&
            terminals[index]?.status === "completed"
          ) {
            failures.push(
              result.reason instanceof Error
                ? result.reason
                : new Error(String(result.reason)),
            );
          }
        });
        if (failures.length) {
          throw new AggregateError(
            failures,
            `${failures.length} live processor operation(s) failed.`,
          );
        }
      })();
      done.catch(() => undefined);
      return Object.freeze({
        event,
        processorIds: Object.freeze(processors.map((item) => item.id)),
        done,
        async cancel(reason = "live_event_cancelled") {
          await Promise.all(
            work.map((item) => item.cancel(reason).catch(() => undefined)),
          );
          await done.catch(() => undefined);
        },
      });
    },
  });
}
